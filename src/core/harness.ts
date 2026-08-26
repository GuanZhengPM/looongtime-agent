import { budgetPhase, executionTokenAllowance, remainingTokens } from "./budget";
import { compileContext } from "./context";
import type { ModelPort, ModelRoundResult, ModelToolCall } from "./model-port";
import { applyProgress, measureProgress, recoveryGuidance, snapshotState } from "./progress";
import { RunRepository } from "./repository";
import { applyStateReport, commitCompletion, decideCompletion } from "./state";
import type { BudgetUsage, RunEvent, RunState, StateReport } from "./types";
import type { ExecutableTool, ToolExecutionContext } from "../tools/types";
import { findTool } from "../tools/registry";
import { assessAuditRisk, recordMutation } from "./proof";
import { runShadowSemanticAudit } from "./semantic-audit";
import { Workspace } from "../tools/workspace";

export interface HarnessObserver {
	onEvent?: (event: RunEvent) => void;
	onText?: (delta: string) => void;
	authorize?: ToolExecutionContext["authorize"];
}

export interface HarnessRunOptions {
	state: RunState;
	repository: RunRepository;
	modelPort: ModelPort;
	tools: readonly ExecutableTool[];
	signal?: AbortSignal;
	observer?: HarnessObserver;
	retryDelay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

function addUsage(target: BudgetUsage, source: BudgetUsage): void {
	target.inputTokens += source.inputTokens;
	target.outputTokens += source.outputTokens;
	target.cacheReadTokens += source.cacheReadTokens;
	target.cacheWriteTokens += source.cacheWriteTokens;
	target.reasoningTokens += source.reasoningTokens;
	target.costUsd += source.costUsd;
	target.toolCalls += source.toolCalls;
	target.wallTimeMs += source.wallTimeMs;
}

function usageDifference(total: BudgetUsage, recorded: BudgetUsage): BudgetUsage {
	return {
		inputTokens: Math.max(0, total.inputTokens - recorded.inputTokens),
		outputTokens: Math.max(0, total.outputTokens - recorded.outputTokens),
		cacheReadTokens: Math.max(0, total.cacheReadTokens - recorded.cacheReadTokens),
		cacheWriteTokens: Math.max(0, total.cacheWriteTokens - recorded.cacheWriteTokens),
		reasoningTokens: Math.max(0, total.reasoningTokens - recorded.reasoningTokens),
		costUsd: Math.max(0, total.costUsd - recorded.costUsd),
		toolCalls: 0,
		wallTimeMs: Math.max(0, total.wallTimeMs - recorded.wallTimeMs),
	};
}

function toolEventPayload(call: ModelToolCall): Record<string, unknown> {
	const target = ["path", "command", "pattern", "files"]
		.map(key => call.arguments[key])
		.find((value): value is string => typeof value === "string");
	return {
		callId: call.id,
		tool: call.name,
		argumentKeys: Object.keys(call.arguments),
		...(target ? { target: target.slice(0, 1000) } : {}),
	};
}

async function appendEvent(
	options: HarnessRunOptions,
	type: RunEvent["type"],
	payload: Record<string, unknown>,
): Promise<void> {
	const event = await options.repository.append(options.state, type, payload);
	options.observer?.onEvent?.(event);
}

async function currentWorkspaceFingerprint(workspace: string): Promise<string> {
	return await (await Workspace.open(workspace)).fingerprint();
}

async function reconcileWorkspace(options: HarnessRunOptions, reason: string): Promise<boolean> {
	const fingerprint = await currentWorkspaceFingerprint(options.state.workspace);
	const previous = options.state.workspaceFingerprint;
	options.state.baselineWorkspaceFingerprint ??= previous ?? fingerprint;
	options.state.workspaceFingerprint = fingerprint;
	options.state.workspaceFingerprintAt = Date.now();
	if (!previous) {
		await appendEvent(options, "workspace_reconciled", { reason, initialized: true, fingerprint });
		await options.repository.save(options.state);
		return false;
	}
	if (previous === fingerprint) return false;
	const invalidation = recordMutation(options.state, ["*"], `External workspace change detected during ${reason}`);
	options.state.artifacts = [];
	await appendEvent(options, "workspace_reconciled", {
		reason,
		externalChange: true,
		fingerprint,
		mutationEpoch: invalidation.mutationEpoch,
		invalidatedEvidenceIds: invalidation.invalidatedEvidenceIds,
		staleClaimIds: invalidation.staleClaimIds,
		invalidatedFactIds: invalidation.invalidatedFactIds,
	});
	await options.repository.save(options.state);
	return true;
}

function defaultReport(state: RunState, output: string): StateReport {
	return {
		status: "continue",
		summary: output || "The executor ended the round without a structured state report.",
		requirementIds: [],
		evidenceIds: [],
		nextFrontier: state.frontier,
		unknowns: [],
		conflicts: [],
		resolvedUnknowns: [],
		resolvedConflictIds: [],
	};
}

function roundLimits(state: RunState): { maxTurns: number; maxOutputTokens: number } {
	const phase = budgetPhase(state);
	const allowance = phase === "reserve" ? remainingTokens(state) : executionTokenAllowance(state);
	return {
		maxTurns: phase === "normal" ? 40 : phase === "observe" ? 24 : 10,
		maxOutputTokens: Math.max(1, Math.min(64_000, allowance)),
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

class RunBudgetExceededError extends Error {}

function retryableModelError(error: unknown): boolean {
	const message = errorMessage(error).toLowerCase();
	if (
		/(?:401|403|invalid api key|invalid bearer|unauthenticated|not authenticated|unknown model|unsupported model)/i.test(
			message,
		)
	) {
		return false;
	}
	return /(?:\b408\b|\b409\b|\b425\b|\b429\b|\b5\d\d\b|rate.?limit|timed?\s*out|timeout|temporar|unavailable|overload|internal server|network|connection|socket|econn|fetch failed|aborted)/i.test(
		message,
	);
}

function modelRetryDelay(state: RunState): number {
	const exponent = Math.max(0, state.health.consecutiveModelErrors - 1);
	return Math.min(state.budget.modelRetryMaxDelayMs, state.budget.modelRetryBaseDelayMs * 2 ** exponent);
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
	if (milliseconds <= 0) return;
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, milliseconds);
		const onAbort = (): void => {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			reject(signal.reason ?? new Error("Run interrupted."));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
	});
}

async function executeTool(
	options: HarnessRunOptions,
	call: ModelToolCall,
	signal: AbortSignal,
): Promise<{ text: string; isError: boolean; report?: StateReport }> {
	await appendEvent(options, "tool_started", toolEventPayload(call));
	const tool = findTool(options.tools, call);
	if (!tool) {
		const text = `Error: unknown tool '${call.name}'.`;
		await appendEvent(options, "tool_completed", { callId: call.id, tool: call.name, success: false, error: text });
		return { text, isError: true };
	}
	if (options.state.usage.toolCalls >= options.state.budget.maxToolCalls) {
		const text = "Run-level tool-call budget was exhausted.";
		await appendEvent(options, "tool_completed", {
			callId: call.id,
			tool: call.name,
			success: false,
			error: text,
			budgetExhausted: true,
		});
		return {
			text: `Error: ${text}`,
			isError: true,
			report: {
				status: "blocked",
				summary: text,
				requirementIds: [],
				evidenceIds: [],
				nextFrontier: options.state.frontier,
				unknowns: [],
				conflicts: [],
				resolvedUnknowns: [],
				resolvedConflictIds: [],
			},
		};
	}
	options.state.usage.toolCalls += 1;
	const mutationEpochBefore = options.state.mutationEpoch;
	const outcome = await tool.execute(call, {
		state: options.state,
		repository: options.repository,
		signal,
		permissionMode: options.state.permissionMode,
		allowNetwork: options.state.allowNetwork,
		...(options.observer?.authorize ? { authorize: options.observer.authorize } : {}),
	});
	if (options.state.mutationEpoch !== mutationEpochBefore) {
		options.state.workspaceFingerprint = await currentWorkspaceFingerprint(options.state.workspace);
		options.state.workspaceFingerprintAt = Date.now();
	}
	for (const evidence of outcome.evidence) {
		await appendEvent(options, "evidence_recorded", {
			evidenceId: evidence.id,
			kind: evidence.kind,
			source: evidence.source,
			subject: evidence.subject,
			mutationEpoch: evidence.mutationEpoch,
		});
	}
	await appendEvent(options, "tool_completed", {
		callId: call.id,
		tool: call.name,
		success: !outcome.isError,
		evidenceIds: outcome.evidence.map(item => item.id),
		...(outcome.isError ? { error: outcome.text.slice(0, 2000) } : {}),
	});
	await options.repository.save(options.state);
	return {
		text: outcome.text,
		isError: outcome.isError,
		...(outcome.report ? { report: outcome.report } : {}),
	};
}

async function blockRun(options: HarnessRunOptions, reason: string): Promise<RunState> {
	options.state.status = "blocked";
	options.state.recoveryGuidance = reason;
	await appendEvent(options, "run_blocked", { reason });
	await options.repository.save(options.state);
	return options.state;
}

export async function runHarness(options: HarnessRunOptions): Promise<RunState> {
	const controller = new AbortController();
	const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
	const lease = await options.repository.acquireLease();
	try {
		options.state.status = "running";
		for (const requirement of options.state.requirements) {
			if (requirement.status === "pending" || requirement.status === "blocked") requirement.status = "active";
		}
		await reconcileWorkspace(options, "run start or resume");
		signal.throwIfAborted();
		await options.modelPort.assertAvailable(options.state.model, signal);
		if (options.state.semanticAuditMode !== "off" && options.state.auditModel) {
			await options.modelPort.assertAvailable(options.state.auditModel, signal);
		}
		await options.repository.save(options.state);
		while (options.state.status === "running") {
			await reconcileWorkspace(options, `round ${options.state.round + 1} start`);
			const phase = budgetPhase(options.state);
			if (phase === "exhausted") {
				return await blockRun(options, "Run-level token, tool, active-time, or round budget was exhausted.");
			}
			options.state.round += 1;
			const before = snapshotState(options.state);
			await appendEvent(options, "round_started", {
				round: options.state.round,
				phase,
				frontier: options.state.frontier,
			});
			const context = await compileContext(options.state);
			const limits = roundLimits(options.state);
			const callCounts = new Map<string, number>();
			await appendEvent(options, "model_started", {
				provider: options.state.model.provider,
				modelId: options.state.model.modelId,
				reasoning: options.state.model.reasoning,
				maxTurns: limits.maxTurns,
				maxOutputTokens: limits.maxOutputTokens,
			});
			const started = performance.now();
			const roundSignal = AbortSignal.any([signal, AbortSignal.timeout(options.state.budget.maxRoundTimeMs)]);
			const incrementallyRecordedUsage: BudgetUsage = {
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				reasoningTokens: 0,
				costUsd: 0,
				toolCalls: 0,
				wallTimeMs: 0,
			};
			let result: ModelRoundResult;
			try {
				result = await options.modelPort.runRound({
					model: options.state.model,
					sessionId: options.state.id,
					systemPrompt: context.systemPrompt,
					userPrompt: context.userPrompt,
					tools: options.tools.map(tool => ({
						name: tool.definition.name,
						description: tool.definition.description,
						parameters: tool.definition.parameters,
					})),
					maxTurns: limits.maxTurns,
					maxOutputTokens: limits.maxOutputTokens,
					signal: roundSignal,
					...(options.observer?.onText ? { onText: options.observer.onText } : {}),
					onUsage: async usage => {
						addUsage(incrementallyRecordedUsage, usage);
						addUsage(options.state.usage, usage);
						await appendEvent(options, "model_usage_recorded", { round: options.state.round, usage });
						await options.repository.save(options.state);
						if (budgetPhase(options.state) === "exhausted") {
							throw new RunBudgetExceededError(
								"token, active-time, cost, round, or tool budget reached its hard limit",
							);
						}
					},
					executeTool: async call => {
						const signature = `${call.name}:${JSON.stringify(call.arguments)}`;
						const count = (callCounts.get(signature) ?? 0) + 1;
						callCounts.set(signature, count);
						if (count <= 2) return await executeTool(options, call, roundSignal);
						await appendEvent(options, "tool_started", toolEventPayload(call));
						const error =
							"Identical tool call blocked after two attempts; start a new round with a different hypothesis.";
						await appendEvent(options, "tool_completed", {
							callId: call.id,
							tool: call.name,
							success: false,
							error,
							repeated: true,
						});
						return {
							text: `Error: ${error}`,
							isError: true,
							report: {
								status: "continue",
								summary: error,
								requirementIds: [],
								evidenceIds: [],
								nextFrontier: options.state.frontier,
								unknowns: [],
								conflicts: [],
								resolvedUnknowns: [],
								resolvedConflictIds: [],
							},
						};
					},
				});
			} catch (error) {
				options.state.usage.wallTimeMs += performance.now() - started;
				if (signal.aborted) throw error;
				if (error instanceof RunBudgetExceededError || budgetPhase(options.state) === "exhausted") {
					return await blockRun(options, `Run-level budget exhausted during model round: ${errorMessage(error)}`);
				}
				options.state.health.consecutiveModelErrors += 1;
				options.state.health.totalModelErrors += 1;
				options.state.health.lastModelError = errorMessage(error).slice(0, 2_000);
				options.state.health.lastModelErrorAt = Date.now();
				const retryable = retryableModelError(error);
				await appendEvent(options, "model_failed", {
					round: options.state.round,
					error: options.state.health.lastModelError,
					retryable,
					consecutiveErrors: options.state.health.consecutiveModelErrors,
				});
				if (
					retryable &&
					options.state.health.consecutiveModelErrors <= options.state.budget.maxConsecutiveModelErrors
				) {
					const delayMs = modelRetryDelay(options.state);
					options.state.recoveryGuidance = `Transient model failure; retrying the same frontier after ${delayMs} ms.`;
					await appendEvent(options, "model_retry_scheduled", {
						round: options.state.round,
						delayMs,
						consecutiveErrors: options.state.health.consecutiveModelErrors,
					});
					await options.repository.save(options.state);
					await (options.retryDelay ?? abortableDelay)(delayMs, signal);
					continue;
				}
				throw error;
			}
			result.usage.wallTimeMs += performance.now() - started;
			addUsage(options.state.usage, usageDifference(result.usage, incrementallyRecordedUsage));
			options.state.health.consecutiveModelErrors = 0;
			await appendEvent(options, "model_completed", {
				round: options.state.round,
				turns: result.turns,
				output: result.output.slice(0, 4000),
				usage: result.usage,
			});
			const report = result.report ?? defaultReport(options.state, result.output);
			applyStateReport(options.state, report);
			await appendEvent(options, "state_reported", {
				status: report.status,
				summary: report.summary,
				requirementIds: report.requirementIds,
				evidenceIds: report.evidenceIds,
				nextFrontier: report.nextFrontier,
				claims: report.claims ?? [],
				facts: report.facts ?? [],
			});
			options.state.audit = assessAuditRisk(options.state, report);
			await appendEvent(options, "audit_routed", {
				route: options.state.audit.route,
				riskScore: options.state.audit.riskScore,
				reasons: options.state.audit.reasons,
				claimIds: options.state.audit.claimIds,
				advisory: options.state.audit.advisory,
			});
			if (
				options.state.semanticAuditMode !== "off" &&
				report.status === "complete" &&
				options.state.audit.route === "semantic_audit"
			) {
				if (budgetPhase(options.state) === "exhausted") {
					if (options.state.semanticAuditMode === "gate") {
						return await blockRun(options, "Run-level budget was exhausted before mandatory semantic review.");
					}
				} else {
					const auditSignal = AbortSignal.any([
						signal,
						AbortSignal.timeout(Math.min(options.state.budget.maxRoundTimeMs, 10 * 60_000)),
					]);
					await runShadowSemanticAudit({
						state: options.state,
						repository: options.repository,
						modelPort: options.modelPort,
						signal: auditSignal,
					});
				}
			}

			if (report.status === "complete") {
				await reconcileWorkspace(options, `round ${options.state.round} completion`);
				const decision = decideCompletion(options.state, report);
				commitCompletion(options.state, report, decision);
				if (!decision.complete) {
					options.state.recoveryGuidance = `Completion rejected: ${decision.reasons.join(" ")} If an existing unknown is outside the current objective, include its exact string in resolvedUnknowns on the next report; do not repeat hypothetical future choices as unknowns.`;
				}
			} else if (report.status === "blocked") {
				options.state.recoveryGuidance = `Executor reported a blocker: ${report.summary}`;
			} else if (result.report) {
				delete options.state.recoveryGuidance;
			}

			const delta = measureProgress(before, snapshotState(options.state));
			applyProgress(options.state, delta);
			await appendEvent(options, "progress_measured", {
				round: options.state.round,
				delta,
				stalledRounds: options.state.progress.stalledRounds,
			});

			if (options.state.completedAt !== undefined) {
				await appendEvent(options, "run_completed", {
					round: options.state.round,
					usage: options.state.usage,
					evidenceIds: report.evidenceIds,
				});
				await options.repository.save(options.state);
				return options.state;
			}

			if (options.state.progress.stalledRounds >= options.state.budget.maxStalledRounds) {
				return await blockRun(
					options,
					`No trusted state delta was observed for ${options.state.progress.stalledRounds} consecutive rounds. ${options.state.recoveryGuidance ?? report.summary}`,
				);
			}
			if (delta.score === 0) {
				const governorGuidance = recoveryGuidance(options.state);
				options.state.recoveryGuidance = options.state.recoveryGuidance
					? `${options.state.recoveryGuidance} ${governorGuidance}`
					: governorGuidance;
				await appendEvent(options, "recovery_selected", {
					round: options.state.round,
					stalledRounds: options.state.progress.stalledRounds,
					guidance: options.state.recoveryGuidance,
				});
			}
			await options.repository.save(options.state);
		}
		return options.state;
	} catch (error) {
		options.state.recoveryGuidance = errorMessage(error);
		if (signal.aborted) {
			options.state.status = "paused";
			await appendEvent(options, "run_paused", {
				round: options.state.round,
				reason: options.state.recoveryGuidance,
			});
			await options.repository.save(options.state);
			return options.state;
		}
		options.state.status = "failed";
		await appendEvent(options, "run_failed", {
			status: options.state.status,
			error: options.state.recoveryGuidance,
		});
		await options.repository.save(options.state);
		throw error;
	} finally {
		controller.abort();
		await lease.release();
		options.modelPort.closeSession?.(options.state.id);
	}
}
