import * as path from "node:path";
import type {
	Artifact,
	BudgetConfig,
	CompletionDecision,
	Evidence,
	GoalContract,
	ModelSelection,
	PermissionMode,
	Requirement,
	RunState,
	StateReport,
} from "./types";
import { DEFAULT_BUDGET, emptyUsage } from "./types";
import {
	applyProofClaims,
	currentEvidence as currentProofEvidence,
	defaultAuditDecision,
	emptyProofGraph,
	ensureProofState,
	evidenceIsCurrent,
	factIsCurrent,
} from "./proof";
import { evidenceVerifiesRequirement } from "./verification";

const MAX_RETAINED_EVIDENCE = 2_000;
const MAX_REQUIREMENT_EVIDENCE = 200;
const MAX_CLAIM_EVIDENCE = 50;
const MAX_FACT_EVIDENCE = 20;
const MAX_RETAINED_CLAIMS = 500;
const MAX_RETAINED_FACTS = 1_000;
const MAX_RETAINED_AUDITS = 100;
const MAX_CONTRACT_REQUIREMENTS = 200;
const MAX_RETAINED_ARTIFACTS = 2_000;
const MAX_RETAINED_UNKNOWNS = 1_000;
const MAX_RETAINED_CONFLICTS = 1_000;
const UNKNOWN_OVERFLOW = "Additional unresolved unknowns were omitted by bounded state compaction.";
const CONFLICT_OVERFLOW = "Additional conflicts were omitted by bounded state compaction.";
const WORKSPACE_CHANGE_INTENT =
	/\b(?:add|build|change|create|develop|edit|fix|implement|migrate|modify|refactor|remove|rename|replace|ship|update|write)\b|(?:\u4fee\u590d|\u5b9e\u73b0|\u521b\u5efa|\u65b0\u5efa|\u4fee\u6539|\u66f4\u65b0|\u4f18\u5316|\u91cd\u6784|\u7f16\u5199|\u6dfb\u52a0|\u5220\u9664|\u6784\u5efa|\u5f00\u53d1|\u8fc1\u79fb|\u66ff\u6362|\u91cd\u547d\u540d)/iu;

function finitePositive(value: number | undefined, fallback: number): number {
	return Number.isFinite(value) && (value ?? 0) > 0 ? Math.floor(value as number) : fallback;
}

export function normalizeBudget(input: Partial<BudgetConfig> = {}): BudgetConfig {
	const hardTokenLimit = finitePositive(input.hardTokenLimit, DEFAULT_BUDGET.hardTokenLimit);
	const reserveTokens = Math.min(
		finitePositive(input.reserveTokens, DEFAULT_BUDGET.reserveTokens),
		Math.max(1, hardTokenLimit - 1),
	);
	const observeAfterTokens = Math.min(
		finitePositive(input.observeAfterTokens, DEFAULT_BUDGET.observeAfterTokens),
		Math.max(1, hardTokenLimit - reserveTokens),
	);
	const modelRetryBaseDelayMs = finitePositive(
		input.modelRetryBaseDelayMs,
		DEFAULT_BUDGET.modelRetryBaseDelayMs,
	);
	return {
		observeAfterTokens,
		hardTokenLimit,
		reserveTokens,
		maxToolCalls: finitePositive(input.maxToolCalls, DEFAULT_BUDGET.maxToolCalls),
		maxWallTimeMs: finitePositive(input.maxWallTimeMs, DEFAULT_BUDGET.maxWallTimeMs),
		maxStalledRounds: finitePositive(input.maxStalledRounds, DEFAULT_BUDGET.maxStalledRounds),
		maxRounds: finitePositive(input.maxRounds, DEFAULT_BUDGET.maxRounds),
		maxConsecutiveModelErrors: finitePositive(
			input.maxConsecutiveModelErrors,
			DEFAULT_BUDGET.maxConsecutiveModelErrors,
		),
		modelRetryBaseDelayMs,
		modelRetryMaxDelayMs: Math.max(
			modelRetryBaseDelayMs,
			finitePositive(input.modelRetryMaxDelayMs, DEFAULT_BUDGET.modelRetryMaxDelayMs),
		),
		maxRoundTimeMs: finitePositive(input.maxRoundTimeMs, DEFAULT_BUDGET.maxRoundTimeMs),
		...(input.maxCostUsd !== undefined
			? {
					maxCostUsd:
						Number.isFinite(input.maxCostUsd) && input.maxCostUsd > 0
							? input.maxCostUsd
							: DEFAULT_BUDGET.maxCostUsd,
				}
			: DEFAULT_BUDGET.maxCostUsd !== undefined
				? { maxCostUsd: DEFAULT_BUDGET.maxCostUsd }
				: {}),
	};
}

export function applyBudgetOverrides(state: RunState, overrides: Partial<BudgetConfig>): void {
	state.budget = normalizeBudget({ ...state.budget, ...overrides });
}

export function normalizeRunState(state: RunState): RunState {
	state.budget = normalizeBudget(state.budget);
	state.health ??= { consecutiveModelErrors: 0, totalModelErrors: 0 };
	ensureProofState(state);
	state.semanticAuditMode ??= "off";
	state.semanticAudits ??= [];
	state.facts ??= [];
	state.allowNetwork ??= false;
	state.contract.constraints ??= [];
	state.contract.verificationCommands ??= [];
	// Preserve completion behavior for runs created before this contract field existed.
	state.contract.requiresWorkspaceChange ??= false;
	state.contract.lockedAt ??= state.contract.createdAt;
	state.progress.lastDelta.diagnosticEvidence ??= 0;
	return state;
}

export function compactRunState(state: RunState): void {
	ensureProofState(state);
	const currentEvidenceIds = new Set(
		state.evidence.filter(item => evidenceIsCurrent(state, item)).map(item => item.id),
	);
	for (const requirement of state.requirements) {
		requirement.evidenceIds = requirement.evidenceIds
			.filter(id => currentEvidenceIds.has(id))
			.slice(-MAX_REQUIREMENT_EVIDENCE);
	}
	for (const claim of state.proof.claims) {
		if (
			claim.status === "supported" &&
			(claim.evidenceIds.length === 0 || claim.evidenceIds.some(id => !currentEvidenceIds.has(id)))
		) {
			claim.status = "stale";
			claim.invalidatedAt = Date.now();
			claim.invalidationReason = "Supporting evidence is no longer current.";
			claim.updatedAt = Date.now();
		}
	}
	const prioritizedClaims = [...state.proof.claims]
		.sort((left, right) => {
			const supported = Number(right.status === "supported") - Number(left.status === "supported");
			return supported || right.updatedAt - left.updatedAt;
		})
		.slice(0, MAX_RETAINED_CLAIMS);
	const retainedClaimIds = new Set(prioritizedClaims.map(item => item.id));
	state.proof.claims = state.proof.claims.filter(item => retainedClaimIds.has(item.id));
	for (const claim of state.proof.claims) claim.evidenceIds = claim.evidenceIds.slice(-MAX_CLAIM_EVIDENCE);
	state.facts = state.facts.slice(-MAX_RETAINED_FACTS);
	for (const fact of state.facts) fact.evidenceIds = fact.evidenceIds.slice(-MAX_FACT_EVIDENCE);
	state.semanticAudits = state.semanticAudits.slice(-MAX_RETAINED_AUDITS);
	state.artifacts = [...state.artifacts]
		.sort((left, right) => left.updatedAt - right.updatedAt)
		.slice(-MAX_RETAINED_ARTIFACTS);
	if (state.unknowns.length > MAX_RETAINED_UNKNOWNS) {
		state.unknowns = [UNKNOWN_OVERFLOW, ...state.unknowns.slice(-(MAX_RETAINED_UNKNOWNS - 1))];
	}
	if (state.conflicts.length > MAX_RETAINED_CONFLICTS) {
		const existingOverflow = state.conflicts.find(item => item.open && item.description === CONFLICT_OVERFLOW);
		const overflow = existingOverflow ?? {
			id: `conflict-${crypto.randomUUID()}`,
			description: CONFLICT_OVERFLOW,
			open: true,
			createdAt: Date.now(),
		};
		const open = state.conflicts.filter(item => item.open && item.id !== overflow.id);
		const retainedOpen = open.slice(-(MAX_RETAINED_CONFLICTS - 1));
		if (open.length >= MAX_RETAINED_CONFLICTS - 1) {
			state.conflicts = [overflow, ...retainedOpen];
		} else {
			const capacity = MAX_RETAINED_CONFLICTS - open.length - 1;
			const closed = capacity > 0 ? state.conflicts.filter(item => !item.open).slice(-capacity) : [];
			state.conflicts = [overflow, ...closed, ...open];
		}
	}

	const requirementEvidenceIds = new Set(state.requirements.flatMap(item => item.evidenceIds));
	const supportedClaimEvidenceIds = new Set(
		state.proof.claims.filter(item => item.status === "supported").flatMap(item => item.evidenceIds),
	);
	const factEvidenceIds = new Set(
		state.facts.filter(item => factIsCurrent(state, item)).flatMap(item => item.evidenceIds),
	);
	const protectedIds = new Set([
		...requirementEvidenceIds,
		...factEvidenceIds,
		...state.proof.claims.flatMap(item => item.evidenceIds),
	]);
	let retained = state.evidence.filter(
		item => protectedIds.has(item.id) || item.kind === "user" || evidenceIsCurrent(state, item),
	);
	if (retained.length > MAX_RETAINED_EVIDENCE) {
		const originalIndex = new Map(state.evidence.map((item, index) => [item.id, index]));
		retained = retained
			.sort((left, right) => {
				const score = (item: Evidence): number =>
					Number(requirementEvidenceIds.has(item.id)) * 8 +
					Number(supportedClaimEvidenceIds.has(item.id)) * 4 +
					Number(factEvidenceIds.has(item.id)) * 2 +
					Number(item.kind === "user");
				return score(right) - score(left) || (originalIndex.get(right.id) ?? 0) - (originalIndex.get(left.id) ?? 0);
			})
			.slice(0, MAX_RETAINED_EVIDENCE)
			.sort((left, right) => (originalIndex.get(left.id) ?? 0) - (originalIndex.get(right.id) ?? 0));
	}
	state.evidence = retained;
	const available = new Set(state.evidence.map(item => item.id));
	for (const requirement of state.requirements) {
		requirement.evidenceIds = requirement.evidenceIds.filter(id => available.has(id));
	}
	for (const claim of state.proof.claims) {
		const expected = new Set(claim.evidenceIds).size;
		claim.evidenceIds = claim.evidenceIds.filter(id => available.has(id));
		if (claim.status === "supported" && (claim.evidenceIds.length === 0 || claim.evidenceIds.length < expected)) {
			claim.status = "stale";
			claim.invalidatedAt = Date.now();
			claim.invalidationReason = "Supporting evidence was evicted during bounded state compaction.";
			claim.updatedAt = Date.now();
		}
	}
	state.facts = state.facts.filter(
		fact => fact.evidenceIds.length > 0 && fact.evidenceIds.every(id => available.has(id)) && factIsCurrent(state, fact),
	);
}

export function createGoalContract(
	objective: string,
	requirements?: readonly string[],
	constraints: readonly string[] = [],
	verificationCommands: readonly string[] = [],
	requiresWorkspaceChange = WORKSPACE_CHANGE_INTENT.test(objective),
): GoalContract {
	const now = Date.now();
	const lockedObjective = objective.trim();
	if (!lockedObjective) throw new Error("A Goal Contract requires a non-empty objective.");
	const uniqueConstraints = uniqueStrings(constraints);
	const seen = new Set<string>();
	const criteria = [
		{ description: lockedObjective, origin: "objective" as const },
		...(requirements ?? []).map(description => ({ description, origin: "requirement" as const })),
		...uniqueConstraints.map(description => ({ description, origin: "constraint" as const })),
	]
		.map(item => ({ ...item, description: item.description.trim() }))
		.filter(item => {
			if (!item.description || seen.has(item.description)) return false;
			seen.add(item.description);
			return true;
		});
	if (criteria.length > MAX_CONTRACT_REQUIREMENTS) {
		throw new Error(`A Goal Contract supports at most ${MAX_CONTRACT_REQUIREMENTS} required criteria.`);
	}
	return {
		objective: lockedObjective,
		requirements: criteria.map((criterion, index): Requirement => ({
			id: `req-${index + 1}`,
			description: criterion.description,
			origin: criterion.origin,
			required: true,
			status: "pending",
			evidenceIds: [],
			updatedAt: now,
		})),
		constraints: uniqueConstraints,
		verificationCommands: uniqueStrings(verificationCommands),
		requiresWorkspaceChange,
		createdAt: now,
		lockedAt: now,
	};
}

export function createRunState(options: {
	objective: string;
	workspace: string;
	model: ModelSelection;
	auditModel?: ModelSelection;
	permissionMode?: PermissionMode;
	semanticAuditMode?: RunState["semanticAuditMode"];
	allowNetwork?: boolean;
	requirements?: readonly string[];
	constraints?: readonly string[];
	verificationCommands?: readonly string[];
	requiresWorkspaceChange?: boolean;
	budget?: Partial<BudgetConfig>;
}): RunState {
	const contract = createGoalContract(
		options.objective,
		options.requirements,
		options.constraints,
		options.verificationCommands,
		options.requiresWorkspaceChange,
	);
	const now = Date.now();
	return {
		version: 1,
		id: crypto.randomUUID(),
		workspace: path.resolve(options.workspace),
		status: "running",
		contract,
		model: structuredClone(options.model),
		...(options.auditModel ? { auditModel: structuredClone(options.auditModel) } : {}),
		permissionMode: options.permissionMode ?? "autonomous",
		allowNetwork: options.allowNetwork ?? false,
		requirements: structuredClone(contract.requirements),
		evidence: [],
		artifacts: [],
		facts: [],
		unknowns: [],
		conflicts: [],
		frontier: contract.objective,
		mutationEpoch: 0,
		round: 0,
		eventSequence: 0,
		progress: {
			lastScore: 0,
			lastProgressRound: 0,
			stalledRounds: 0,
			lastDelta: {
				verifiedRequirements: 0,
				supportedClaims: 0,
				validEvidence: 0,
				artifacts: 0,
				resolvedUnknowns: 0,
				resolvedConflicts: 0,
				mutationEpochs: 0,
				diagnosticEvidence: 0,
				verifiedFacts: 0,
				score: 0,
			},
		},
		health: {
			consecutiveModelErrors: 0,
			totalModelErrors: 0,
		},
		budget: normalizeBudget(options.budget),
		usage: emptyUsage(),
		proof: emptyProofGraph(),
		audit: defaultAuditDecision(),
		semanticAuditMode: options.semanticAuditMode ?? "off",
		semanticAudits: [],
		startedAt: now,
		updatedAt: now,
	};
}

export function addEvidence(
	state: RunState,
	input: Omit<Evidence, "id" | "observedAt" | "mutationEpoch"> & { mutationEpoch?: number },
): Evidence {
	const evidence: Evidence = {
		id: `ev-${crypto.randomUUID()}`,
		kind: input.kind,
		source: input.source,
		subject: input.subject,
		summary: input.summary,
		mutationEpoch: input.mutationEpoch ?? state.mutationEpoch,
		observedAt: Date.now(),
		...(input.contentHash ? { contentHash: input.contentHash } : {}),
		...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
		...(input.outcome ? { outcome: input.outcome } : {}),
		...(input.verifiesRequirementIds?.length
			? { verifiesRequirementIds: uniqueStrings(input.verifiesRequirementIds) }
			: {}),
		...(input.commandHash ? { commandHash: input.commandHash } : {}),
		...(input.dependencyPaths?.length ? { dependencyPaths: [...input.dependencyPaths] } : {}),
		...(input.globalScope ? { globalScope: true } : {}),
	};
	state.evidence.push(evidence);
	return evidence;
}

export function upsertArtifact(state: RunState, input: Omit<Artifact, "id" | "updatedAt">): Artifact {
	const existing = state.artifacts.find(item => item.path === input.path);
	if (existing) {
		existing.contentHash = input.contentHash;
		existing.mutationEpoch = input.mutationEpoch;
		existing.updatedAt = Date.now();
		return existing;
	}
	const artifact: Artifact = {
		id: `artifact-${crypto.randomUUID()}`,
		path: input.path,
		contentHash: input.contentHash,
		mutationEpoch: input.mutationEpoch,
		updatedAt: Date.now(),
	};
	state.artifacts.push(artifact);
	return artifact;
}

function uniqueStrings(items: readonly string[]): string[] {
	return [...new Set(items.map(item => item.trim()).filter(Boolean))];
}

export function applyStateReport(state: RunState, report: StateReport): void {
	ensureProofState(state);
	state.frontier = report.nextFrontier.trim() || state.frontier;
	state.unknowns = uniqueStrings([
		...state.unknowns.filter(item => !report.resolvedUnknowns.includes(item)),
		...report.unknowns,
	]);
	for (const description of report.conflicts) {
		if (state.conflicts.some(item => item.open && item.description === description)) continue;
		state.conflicts.push({
			id: `conflict-${crypto.randomUUID()}`,
			description,
			open: true,
			createdAt: Date.now(),
		});
	}
	for (const id of report.resolvedConflictIds) {
		const conflict = state.conflicts.find(item => item.id === id);
		if (conflict) conflict.open = false;
	}
	const submittedEvidence = new Set(report.evidenceIds);
	for (const requirementId of report.requirementIds) {
		const requirement = state.requirements.find(item => item.id === requirementId);
		if (!requirement) continue;
		requirement.status = report.status === "blocked" ? "blocked" : "claimed";
		requirement.evidenceIds = uniqueStrings([...requirement.evidenceIds, ...submittedEvidence]);
		requirement.updatedAt = Date.now();
	}
	applyProofClaims(state, report);
	for (const submission of report.facts ?? []) {
		const statement = submission.statement.trim();
		if (!statement) continue;
		const evidence = currentProofEvidence(state, submission.evidenceIds);
		if (submission.evidenceIds.length === 0 || evidence.length !== new Set(submission.evidenceIds).size) continue;
		const existing = state.facts.find(item => item.statement === statement);
		if (existing) {
			existing.evidenceIds = uniqueStrings(submission.evidenceIds);
			existing.verifiedAt = Date.now();
			delete existing.invalidatedAt;
			delete existing.invalidationReason;
		} else {
			state.facts.push({
				id: `fact-${crypto.randomUUID()}`,
				statement,
				evidenceIds: uniqueStrings(submission.evidenceIds),
				verifiedAt: Date.now(),
			});
		}
	}
}

function currentEvidence(state: RunState, ids: readonly string[]): Evidence[] {
	return currentProofEvidence(state, ids);
}

export function decideCompletion(state: RunState, report: StateReport): CompletionDecision {
	const reasons: string[] = [];
	if (report.status !== "complete") reasons.push("Executor did not submit a completion claim.");
	if (state.contract.requiresWorkspaceChange) {
		if (state.mutationEpoch === 0) {
			reasons.push("The Goal Contract requires a workspace change, but no workspace mutation was recorded.");
		} else if (
			state.baselineWorkspaceFingerprint &&
			state.workspaceFingerprint === state.baselineWorkspaceFingerprint
		) {
			reasons.push("The Goal Contract requires a net workspace change, but the workspace matches its starting state.");
		}
	}
	const knownRequirementIds = new Set(state.requirements.map(item => item.id));
	const unknownRequirements = report.requirementIds.filter(id => !knownRequirementIds.has(id));
	if (unknownRequirements.length > 0) reasons.push(`Unknown requirement ids: ${unknownRequirements.join(", ")}.`);
	const evidence = currentEvidence(state, report.evidenceIds);
	if (report.evidenceIds.length === 0) reasons.push("The completion claim contains no host evidence.");
	if (evidence.length !== new Set(report.evidenceIds).size) {
		reasons.push("Some cited evidence is missing or stale after the latest workspace mutation.");
	}
	const submittedRequirements = new Set(report.requirementIds);
	for (const requirement of state.requirements) {
		if (requirement.required && !submittedRequirements.has(requirement.id)) {
			reasons.push(`Required criterion '${requirement.id}' was not included in the completion claim.`);
		}
		const supportedClaims = state.proof.claims.filter(
			claim => claim.requirementId === requirement.id && claim.status === "supported",
		);
		if (requirement.required && submittedRequirements.has(requirement.id) && supportedClaims.length === 0) {
			reasons.push(`Required criterion '${requirement.id}' has no current supported proof claim.`);
		}
		if (state.mutationEpoch > 0 && requirement.required && submittedRequirements.has(requirement.id)) {
			const verificationIds = new Set(
				evidence.filter(item => evidenceVerifiesRequirement(item, requirement.id)).map(item => item.id),
			);
			if (verificationIds.size === 0) {
				reasons.push(`Required criterion '${requirement.id}' has no trusted verification evidence.`);
			} else if (!supportedClaims.some(claim => claim.evidenceIds.some(id => verificationIds.has(id)))) {
				reasons.push(`Required criterion '${requirement.id}' has no proof claim linked to its verification evidence.`);
			}
		}
	}
	if (state.audit.route === "human_review") reasons.push("Completion requires explicit human review.");
	if (state.semanticAuditMode === "gate" && state.audit.route === "semantic_audit") {
		const audit = state.semanticAudits.at(-1);
		if (!audit || audit.round !== state.round || audit.status !== "completed" || audit.verdict !== "pass") {
			reasons.push("The mandatory semantic audit did not produce a current passing verdict.");
		}
	}
	if (state.conflicts.some(item => item.open)) reasons.push("Open conflicts remain.");
	if (report.unknowns.length > 0 || state.unknowns.length > 0) reasons.push("Open unknowns remain.");
	return {
		complete: reasons.length === 0,
		reasons,
		acceptedEvidenceIds: evidence.map(item => item.id),
	};
}

export function commitCompletion(state: RunState, report: StateReport, decision: CompletionDecision): void {
	if (!decision.complete) return;
	const now = Date.now();
	const accepted = new Set(decision.acceptedEvidenceIds);
	for (const requirement of state.requirements) {
		requirement.status = "verified";
		requirement.evidenceIds = requirement.evidenceIds.filter(id => accepted.has(id));
		requirement.updatedAt = now;
	}
	state.status = "completed";
	state.completedAt = now;
	delete state.recoveryGuidance;
}
