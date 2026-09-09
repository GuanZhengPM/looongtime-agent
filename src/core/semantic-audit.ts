import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Type, validateToolCall, type Tool, type ToolCall } from "@earendil-works/pi-ai";
import { validateRelativeGlob } from "../path-policy";
import { compileSearchRegex } from "../regex-policy";
import { budgetPhase, remainingTokens } from "./budget";
import type { ModelPort, ModelToolCall, ModelToolResult } from "./model-port";
import { currentEvidence } from "./proof";
import type { RunRepository } from "./repository";
import {
	emptyUsage,
	type AuditCriterion,
	type BudgetUsage,
	type ContractDriftFinding,
	type RunState,
	type SemanticAuditEvidence,
	type SemanticAuditRecord,
	type SemanticAuditVerdict,
	type SemanticCriterionResult,
} from "./types";

const SNAPSHOT_FILE_LIMIT = 20 * 1024 * 1024;
const SNAPSHOT_TOTAL_LIMIT = 100 * 1024 * 1024;
const READ_CHARACTER_LIMIT = 120_000;
const EXCLUDED_DIRECTORIES = new Set([
	".git",
	".looongtime",
	".continuum",
	"node_modules",
	".cache",
	".gocache",
	".gomodcache",
	".pytest_cache",
]);

interface AuditSnapshot {
	root: string;
	id: string;
	fileCount: number;
	totalBytes: number;
	skippedPaths: string[];
	verify(): Promise<boolean>;
	cleanup(): Promise<void>;
}

interface SubmittedAudit {
	verdict: SemanticAuditVerdict;
	criterionResults: SemanticCriterionResult[];
	contractDrift: ContractDriftFinding[];
	missingEvidence: string[];
	confidence: number;
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

function excluded(relative: string): boolean {
	return relative.split(/[\\/]/).some(segment => EXCLUDED_DIRECTORIES.has(segment));
}

async function hashFile(file: string): Promise<string> {
	return new Bun.CryptoHasher("sha256").update(await Bun.file(file).arrayBuffer()).digest("hex");
}

async function snapshotId(root: string): Promise<string> {
	const manifest: string[] = [];
	for (const relative of [...new Bun.Glob("**/*").scanSync({ cwd: root, dot: true, onlyFiles: true })].sort()) {
		const file = path.join(root, relative);
		const stat = await fs.stat(file);
		manifest.push(`${relative}\u0000${await hashFile(file)}\u0000${stat.size}`);
	}
	return new Bun.CryptoHasher("sha256").update(manifest.join("\n")).digest("hex");
}

async function createAuditSnapshot(workspace: string, signal: AbortSignal): Promise<AuditSnapshot> {
	const createdRoot = await fs.mkdtemp(path.join(os.tmpdir(), "looongtime-audit-"));
	const root = await fs.realpath(createdRoot);
	const manifest: Array<{ path: string; hash: string; bytes: number }> = [];
	const skippedPaths: string[] = [];
	let totalBytes = 0;
	try {
		const files = [...new Bun.Glob("**/*").scanSync({ cwd: workspace, dot: true, onlyFiles: true })].sort();
		for (const relative of files) {
			signal.throwIfAborted();
			if (excluded(relative)) continue;
			const source = path.join(workspace, relative);
			let stat: import("node:fs").Stats;
			try {
				stat = await fs.lstat(source);
			} catch {
				continue;
			}
			if (!stat.isFile()) continue;
			if (stat.size > SNAPSHOT_FILE_LIMIT || totalBytes + stat.size > SNAPSHOT_TOTAL_LIMIT) {
				skippedPaths.push(relative);
				continue;
			}
			const target = path.join(root, relative);
			await fs.mkdir(path.dirname(target), { recursive: true });
			await fs.copyFile(source, target);
			await fs.chmod(target, 0o400);
			const hash = await hashFile(target);
			manifest.push({ path: relative, hash, bytes: stat.size });
			totalBytes += stat.size;
		}
		const id = new Bun.CryptoHasher("sha256")
			.update(manifest.map(item => `${item.path}\u0000${item.hash}\u0000${item.bytes}`).join("\n"))
			.digest("hex");
		return {
			root,
			id,
			fileCount: manifest.length,
			totalBytes,
			skippedPaths,
			verify: async () => (await snapshotId(root)) === id,
			cleanup: async () => await fs.rm(root, { recursive: true, force: true }),
		};
	} catch (error) {
		await fs.rm(root, { recursive: true, force: true });
		throw error;
	}
}

function lockedCriteria(state: RunState): AuditCriterion[] {
	return state.contract.requirements.map(item => ({
		id: `criterion-${item.id}`,
		requirementId: item.id,
		description: item.description,
		required: item.required,
	}));
}

async function safePath(root: string, input: string): Promise<string> {
	if (!input || path.isAbsolute(input)) throw new Error("Audit paths must be workspace-relative.");
	const lexical = path.resolve(root, input);
	if (lexical !== root && !lexical.startsWith(`${root}${path.sep}`)) throw new Error("Audit path escapes snapshot.");
	const existing = await fs.realpath(lexical);
	if (existing !== root && !existing.startsWith(`${root}${path.sep}`)) throw new Error("Audit path resolves outside snapshot.");
	return existing;
}

function bounded(text: string, limit = READ_CHARACTER_LIMIT): string {
	if (text.length <= limit) return text;
	const half = Math.floor((limit - 100) / 2);
	return `${text.slice(0, half)}\n... ${text.length - half * 2} characters omitted ...\n${text.slice(-half)}`;
}

function normalizedResult(
	submitted: SubmittedAudit,
	criteria: AuditCriterion[],
	evidence: SemanticAuditEvidence[],
): SubmittedAudit {
	const knownCriteria = new Set(criteria.map(item => item.id));
	const knownEvidence = new Set(evidence.map(item => item.id));
	const substantiveEvidence = new Set(evidence.filter(item => item.kind !== "list").map(item => item.id));
	const criterionResults = submitted.criterionResults.filter(item => knownCriteria.has(item.criterionId));
	const missingEvidence = [...submitted.missingEvidence];
	for (const result of criterionResults) {
		const unknown = result.evidenceIds.filter(id => !knownEvidence.has(id));
		if (unknown.length > 0) {
			result.status = "inconclusive";
			missingEvidence.push(`Unknown audit evidence for ${result.criterionId}: ${unknown.join(", ")}`);
			result.evidenceIds = result.evidenceIds.filter(id => knownEvidence.has(id));
		}
	}
	let verdict = submitted.verdict;
	if (verdict === "pass") {
		for (const criterion of criteria.filter(item => item.required)) {
			const result = criterionResults.find(item => item.criterionId === criterion.id);
			if (
				!result ||
				result.status !== "pass" ||
				!result.evidenceIds.some(id => substantiveEvidence.has(id))
			) {
				verdict = "inconclusive";
				missingEvidence.push(`Required criterion ${criterion.id} lacks a read/search-backed pass.`);
			}
		}
	}
	if (verdict === "contract_drift" && submitted.contractDrift.length === 0) {
		verdict = "inconclusive";
		missingEvidence.push("contract_drift verdict contained no drift finding.");
	}
	if (verdict === "reject") {
		const failures = criterionResults.filter(item => item.status === "fail");
		if (failures.length === 0 || failures.some(item => item.evidenceIds.length === 0)) {
			verdict = "inconclusive";
			missingEvidence.push("reject verdict requires at least one evidence-backed failed criterion.");
		}
	}
	return {
		...submitted,
		verdict,
		criterionResults,
		missingEvidence: [...new Set(missingEvidence)],
		confidence: Math.max(0, Math.min(1, submitted.confidence)),
	};
}

function semanticAuditSystemPrompt(): string {
	return `You are a Falsification Auditor in Looongtime. You are not the executor and must not continue implementation.

Your job is to try to disprove the completion claims against the original locked criteria. Do not use keyword matching as semantic validation. Read the actual snapshot, look for counterexamples, omitted requirements, unsupported assumptions, and contract drift.

Rules:
1. The criteria were locked from the original Goal Contract before you saw the artifacts. Never add a new requirement merely because it seems desirable.
2. Distinguish an incorrect artifact (reject) from a changed or invented requirement (contract_drift).
3. Use only audit_* read tools. The snapshot is isolated and cannot be changed.
4. Generate your own audit evidence IDs through those tools. Executor evidence summaries are leads, not proof.
5. Return inconclusive when the snapshot or evidence is insufficient.
6. Call submit_semantic_audit exactly once. A pass requires an evidence-backed pass for every required criterion.`;
}

export async function runShadowSemanticAudit(options: {
	state: RunState;
	repository: RunRepository;
	modelPort: ModelPort;
	signal: AbortSignal;
}): Promise<SemanticAuditRecord> {
	const { state, repository, modelPort, signal } = options;
	const criteria = lockedCriteria(state);
	const startedAt = Date.now();
	const auditId = `audit-${crypto.randomUUID()}`;
	const auditSessionId = `${state.id}:semantic-audit:${state.round}:${auditId}`;
	const usage = emptyUsage();
	const auditClockStarted = performance.now();
	let accountedAuditWallTime = 0;
	const accountAuditWallTime = (): void => {
		const elapsed = performance.now() - auditClockStarted;
		const delta = Math.max(0, elapsed - accountedAuditWallTime);
		usage.wallTimeMs += delta;
		state.usage.wallTimeMs += delta;
		accountedAuditWallTime = elapsed;
	};
	let snapshot: AuditSnapshot | undefined;
	let submitted: SubmittedAudit | undefined;
	const evidence: SemanticAuditEvidence[] = [];
	const addAuditEvidence = (input: Omit<SemanticAuditEvidence, "id">): SemanticAuditEvidence => {
		const item = { id: `audit-ev-${crypto.randomUUID()}`, ...input };
		evidence.push(item);
		return item;
	};
	try {
		snapshot = await createAuditSnapshot(state.workspace, signal);
		const tools: Tool[] = [
			{
				name: "audit_list_files",
				description: "List files in the isolated audit snapshot. This tool is read-only.",
				parameters: Type.Object({
					pattern: Type.Optional(Type.String({ maxLength: 1_000 })),
					limit: Type.Optional(Type.Number({ minimum: 1, maximum: 5_000 })),
				}),
			},
			{
				name: "audit_read_file",
				description: "Read a UTF-8 file from the isolated audit snapshot and create audit evidence.",
				parameters: Type.Object({
					path: Type.String({ maxLength: 1_000 }),
					offset: Type.Optional(Type.Number({ minimum: 1 })),
					limit: Type.Optional(Type.Number({ minimum: 1, maximum: 2_000 })),
				}),
			},
			{
				name: "audit_search",
				description: "Search snapshot text with a JavaScript regular expression and create audit evidence.",
				parameters: Type.Object({
					pattern: Type.String({ maxLength: 2_000 }),
					files: Type.Optional(Type.String({ maxLength: 1_000 })),
					limit: Type.Optional(Type.Number({ minimum: 1, maximum: 2_000 })),
				}),
			},
			{
				name: "submit_semantic_audit",
				description: "Submit the single structured falsification result and stop the audit.",
				parameters: Type.Object({
					verdict: Type.Union([
						Type.Literal("pass"),
						Type.Literal("reject"),
						Type.Literal("contract_drift"),
						Type.Literal("inconclusive"),
					]),
					criterionResults: Type.Array(
						Type.Object({
							criterionId: Type.String({ maxLength: 200 }),
							status: Type.Union([Type.Literal("pass"), Type.Literal("fail"), Type.Literal("inconclusive")]),
							reason: Type.String({ maxLength: 4_000 }),
							evidenceIds: Type.Array(Type.String({ maxLength: 200 }), { maxItems: 50 }),
						}),
						{ maxItems: 200 },
					),
					contractDrift: Type.Array(
						Type.Object({
							type: Type.Union([
								Type.Literal("missing_requirement"),
								Type.Literal("unsupported_added_constraint"),
								Type.Literal("changed_meaning"),
							]),
							description: Type.String({ maxLength: 4_000 }),
							claimId: Type.Optional(Type.String({ maxLength: 200 })),
						}),
						{ maxItems: 200 },
					),
					missingEvidence: Type.Array(Type.String({ maxLength: 2_000 }), { maxItems: 200 }),
					confidence: Type.Number({ minimum: 0, maximum: 1 }),
				}),
			},
		];
		const claims = state.proof.claims.map(claim => ({
			id: claim.id,
			requirementId: claim.requirementId,
			statement: claim.statement,
			status: claim.status,
			risk: claim.risk,
			evidence: currentEvidence(state, claim.evidenceIds).map(item => ({
				id: item.id,
				kind: item.kind,
				subject: item.subject,
				summary: item.summary,
				contentHash: item.contentHash,
			})),
		}));
		const recordedUsage = emptyUsage();
		await repository.append(state, "semantic_audit_started", {
			auditId,
			round: state.round,
			snapshotId: snapshot.id,
			criteria: criteria.length,
		});
		await repository.save(state);
		const result = await modelPort.runRound({
			model: state.auditModel ?? state.model,
			sessionId: auditSessionId,
			systemPrompt: semanticAuditSystemPrompt(),
			userPrompt: `Audit the locked criteria against the isolated snapshot.\n\n${JSON.stringify({
				originalObjective: state.contract.objective,
				originalConstraints: state.contract.constraints,
				criteria,
				claims,
				snapshot: {
					id: snapshot.id,
					fileCount: snapshot.fileCount,
					totalBytes: snapshot.totalBytes,
					skippedPaths: snapshot.skippedPaths,
				},
			}, null, 2)}`,
			tools,
			maxTurns: 12,
			maxOutputTokens: Math.max(1, Math.min(16_000, remainingTokens(state))),
			signal,
			onUsage: async increment => {
				accountAuditWallTime();
				addUsage(recordedUsage, increment);
				addUsage(usage, increment);
				addUsage(state.usage, increment);
				await repository.append(state, "model_usage_recorded", {
					round: state.round,
					phase: "semantic_audit",
					auditId,
					usage: increment,
				});
				await repository.save(state);
				if (budgetPhase(state) === "exhausted") {
					throw new Error("Run budget was exhausted during semantic audit.");
				}
			},
			executeTool: async (call: ModelToolCall): Promise<ModelToolResult> => {
				accountAuditWallTime();
				if (budgetPhase(state) === "exhausted") {
					return { text: "Error: run budget exhausted during semantic audit.", isError: true, stop: true };
				}
				if (state.usage.toolCalls >= state.budget.maxToolCalls) {
					return { text: "Error: run tool-call budget exhausted during semantic audit.", isError: true, stop: true };
				}
				state.usage.toolCalls += 1;
				usage.toolCalls += 1;
				await repository.save(state);
				try {
					const providerCall: ToolCall = {
						type: "toolCall",
						id: call.id,
						name: call.name,
						arguments: call.arguments,
					};
					validateToolCall(tools, providerCall);
				} catch (error) {
					return { text: `Error: ${error instanceof Error ? error.message : String(error)}`, isError: true };
				}
				if (call.name === "audit_list_files") {
					try {
						signal.throwIfAborted();
						const pattern = validateRelativeGlob(
							typeof call.arguments.pattern === "string" ? call.arguments.pattern : "**/*",
						);
						const limit = Math.max(1, Math.min(5_000, Number(call.arguments.limit ?? 500)));
						const files = [...new Bun.Glob(pattern).scanSync({ cwd: snapshot!.root, dot: true, onlyFiles: true })]
							.sort()
							.slice(0, limit);
						for (const relative of files) await safePath(snapshot!.root, relative);
						const item = addAuditEvidence({
							kind: "list",
							subject: pattern,
							summary: `Listed ${files.length} snapshot files`,
							excerpt: files.slice(0, 100).join("\n").slice(0, 4_000),
						});
						return { text: `${bounded(files.join("\n"))}\n[audit-evidence:${item.id}]`, isError: false };
					} catch (error) {
						return { text: `Error: ${error instanceof Error ? error.message : String(error)}`, isError: true };
					}
				}
				if (call.name === "audit_read_file") {
					try {
						signal.throwIfAborted();
						const requested = String(call.arguments.path ?? "");
						const file = await safePath(snapshot!.root, requested);
						const text = await Bun.file(file).text();
						const offset = Math.max(1, Math.floor(Number(call.arguments.offset ?? 1)));
						const limit = Math.max(1, Math.min(2_000, Math.floor(Number(call.arguments.limit ?? 300))));
						const body = text.split("\n").slice(offset - 1, offset - 1 + limit).map((line, index) => `${offset + index}:${line}`).join("\n");
						const item = addAuditEvidence({
							kind: "read",
							subject: requested,
							summary: `Read ${requested} lines ${offset}-${offset + limit - 1}`,
							contentHash: await hashFile(file),
							excerpt: body.slice(0, 4_000),
						});
						return { text: `${bounded(body)}\n[audit-evidence:${item.id}]`, isError: false };
					} catch (error) {
						return { text: `Error: ${error instanceof Error ? error.message : String(error)}`, isError: true };
					}
				}
				if (call.name === "audit_search") {
					try {
						const pattern = String(call.arguments.pattern ?? "");
						const expression = compileSearchRegex(pattern);
						const filesPattern = validateRelativeGlob(
							typeof call.arguments.files === "string" ? call.arguments.files : "**/*",
						);
						const limit = Math.max(1, Math.min(2_000, Number(call.arguments.limit ?? 300)));
						const matches: string[] = [];
						for (const relative of new Bun.Glob(filesPattern).scanSync({ cwd: snapshot!.root, dot: true, onlyFiles: true })) {
							signal.throwIfAborted();
							let text: string;
							try { text = await Bun.file(await safePath(snapshot!.root, relative)).text(); } catch { continue; }
							for (const [index, line] of text.split("\n").entries()) {
								if (index % 1_000 === 0) signal.throwIfAborted();
								if (!expression.test(line)) continue;
								matches.push(`${relative}:${index + 1}:${line.slice(0, 2_000)}`);
								if (matches.length >= limit) break;
							}
							if (matches.length >= limit) break;
						}
						const item = addAuditEvidence({
							kind: "search",
							subject: pattern,
							summary: `Found ${matches.length} snapshot matches`,
							excerpt: matches.slice(0, 50).join("\n").slice(0, 4_000),
						});
						return { text: `${bounded(matches.join("\n") || "No matches.")}\n[audit-evidence:${item.id}]`, isError: false };
					} catch (error) {
						return { text: `Error: ${error instanceof Error ? error.message : String(error)}`, isError: true };
					}
				}
				if (call.name === "submit_semantic_audit") {
					const args = call.arguments;
					submitted = normalizedResult(
						{
							verdict: String(args.verdict ?? "inconclusive") as SemanticAuditVerdict,
							criterionResults: Array.isArray(args.criterionResults) ? args.criterionResults as SemanticCriterionResult[] : [],
							contractDrift: Array.isArray(args.contractDrift) ? args.contractDrift as ContractDriftFinding[] : [],
							missingEvidence: Array.isArray(args.missingEvidence) ? args.missingEvidence.map(String) : [],
							confidence: Number(args.confidence ?? 0),
						},
						criteria,
						evidence,
					);
					return { text: "Semantic audit result recorded.", isError: false, stop: true };
				}
				return { text: `Error: unknown audit tool '${call.name}'.`, isError: true };
			},
		});
		accountAuditWallTime();
		addUsage(usage, usageDifference(result.usage, recordedUsage));
		addUsage(state.usage, usageDifference(result.usage, recordedUsage));
		if (!submitted) throw new Error("Semantic Auditor did not submit a structured result.");
		if (submitted.verdict === "pass" && snapshot.skippedPaths.length > 0) {
			submitted = {
				...submitted,
				verdict: "inconclusive",
				missingEvidence: [
					...new Set([
						...submitted.missingEvidence,
						`Audit snapshot omitted ${snapshot.skippedPaths.length} path(s) because of size limits.`,
					]),
				],
			};
		}
		if (!(await snapshot.verify())) throw new Error("Semantic audit snapshot changed during read-only review.");
		const record: SemanticAuditRecord = {
			id: auditId,
			round: state.round,
			mode: "shadow",
			status: "completed",
			snapshotId: snapshot.id,
			snapshotFileCount: snapshot.fileCount,
			snapshotBytes: snapshot.totalBytes,
			skippedPaths: snapshot.skippedPaths,
			criteria,
			verdict: submitted.verdict,
			criterionResults: submitted.criterionResults,
			contractDrift: submitted.contractDrift,
			missingEvidence: submitted.missingEvidence,
			confidence: submitted.confidence,
			evidence,
			usage,
			startedAt,
			finishedAt: Date.now(),
		};
		state.semanticAudits.push(record);
		await repository.append(state, "semantic_audit_completed", {
			auditId,
			verdict: record.verdict,
			confidence: record.confidence,
			evidence: record.evidence.length,
			mode: record.mode,
		});
		await repository.save(state);
		return record;
	} catch (error) {
		accountAuditWallTime();
		const record: SemanticAuditRecord = {
			id: auditId,
			round: state.round,
			mode: "shadow",
			status: "failed",
			snapshotId: snapshot?.id ?? "snapshot-unavailable",
			snapshotFileCount: snapshot?.fileCount ?? 0,
			snapshotBytes: snapshot?.totalBytes ?? 0,
			skippedPaths: snapshot?.skippedPaths ?? [],
			criteria,
			criterionResults: [],
			contractDrift: [],
			missingEvidence: [],
			evidence,
			usage,
			startedAt,
			finishedAt: Date.now(),
			error: error instanceof Error ? error.message : String(error),
		};
		state.semanticAudits.push(record);
		await repository.append(state, "semantic_audit_completed", {
			auditId,
			status: "failed",
			error: record.error,
			mode: record.mode,
		});
		await repository.save(state);
		return record;
	} finally {
		modelPort.closeSession?.(auditSessionId);
		await snapshot?.cleanup();
	}
}
