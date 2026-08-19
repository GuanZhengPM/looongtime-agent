import * as path from "node:path";
import type {
	Artifact,
	BudgetConfig,
	CompletionDecision,
	Evidence,
	EvidenceKind,
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
} from "./proof";

const MAX_RETAINED_EVIDENCE = 2_000;
const MAX_REQUIREMENT_EVIDENCE = 200;

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
	return state;
}

export function compactRunState(state: RunState): void {
	ensureProofState(state);
	const protectedIds = new Set([
		...state.requirements.flatMap(item => item.evidenceIds),
		...state.facts.flatMap(item => item.evidenceIds),
		...state.proof.claims.flatMap(item => item.evidenceIds),
	]);
	const retained = state.evidence.filter(
		item => protectedIds.has(item.id) || item.kind === "user" || evidenceIsCurrent(state, item),
	);
	if (retained.length > MAX_RETAINED_EVIDENCE) {
		const protectedEvidence = retained.filter(item => protectedIds.has(item.id) || item.kind === "user");
		const protectedSet = new Set(protectedEvidence.map(item => item.id));
		const capacity = Math.max(0, MAX_RETAINED_EVIDENCE - protectedEvidence.length);
		const recent = retained.filter(item => !protectedSet.has(item.id)).slice(-capacity);
		state.evidence = [...protectedEvidence, ...recent].slice(-MAX_RETAINED_EVIDENCE);
	} else {
		state.evidence = retained;
	}
	const available = new Set(state.evidence.map(item => item.id));
	for (const requirement of state.requirements) {
		requirement.evidenceIds = requirement.evidenceIds.filter(id => available.has(id)).slice(-MAX_REQUIREMENT_EVIDENCE);
	}
}

export function createGoalContract(objective: string, requirements?: readonly string[]): GoalContract {
	const now = Date.now();
	const descriptions = requirements?.length ? [...requirements] : [objective];
	return {
		objective,
		requirements: descriptions.map((description, index): Requirement => ({
			id: `req-${index + 1}`,
			description,
			required: true,
			status: "pending",
			evidenceIds: [],
			updatedAt: now,
		})),
		constraints: [],
		createdAt: now,
	};
}

export function createRunState(options: {
	objective: string;
	workspace: string;
	model: ModelSelection;
	permissionMode?: PermissionMode;
	semanticAuditMode?: RunState["semanticAuditMode"];
	requirements?: readonly string[];
	budget?: Partial<BudgetConfig>;
}): RunState {
	const contract = createGoalContract(options.objective, options.requirements);
	const now = Date.now();
	return {
		version: 1,
		id: crypto.randomUUID(),
		workspace: path.resolve(options.workspace),
		status: "running",
		contract,
		model: structuredClone(options.model),
		permissionMode: options.permissionMode ?? "autonomous",
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
}

function currentEvidence(state: RunState, ids: readonly string[]): Evidence[] {
	return currentProofEvidence(state, ids);
}

function supportsCodingCompletion(kind: EvidenceKind): boolean {
	return kind === "test" || kind === "build";
}

export function decideCompletion(state: RunState, report: StateReport): CompletionDecision {
	const reasons: string[] = [];
	if (report.status !== "complete") reasons.push("Executor did not submit a completion claim.");
	const knownRequirementIds = new Set(state.requirements.map(item => item.id));
	const unknownRequirements = report.requirementIds.filter(id => !knownRequirementIds.has(id));
	if (unknownRequirements.length > 0) reasons.push(`Unknown requirement ids: ${unknownRequirements.join(", ")}.`);
	const evidence = currentEvidence(state, report.evidenceIds);
	if (report.evidenceIds.length === 0) reasons.push("The completion claim contains no host evidence.");
	if (evidence.length !== new Set(report.evidenceIds).size) {
		reasons.push("Some cited evidence is missing or stale after the latest workspace mutation.");
	}
	if (state.mutationEpoch > 0 && !evidence.some(item => supportsCodingCompletion(item.kind))) {
		reasons.push("The latest workspace mutation has no current test or build evidence.");
	}
	const submittedRequirements = new Set(report.requirementIds);
	for (const requirement of state.requirements) {
		if (requirement.required && !submittedRequirements.has(requirement.id)) {
			reasons.push(`Required criterion '${requirement.id}' was not included in the completion claim.`);
		}
		if (
			requirement.required &&
			submittedRequirements.has(requirement.id) &&
			!state.proof.claims.some(claim => claim.requirementId === requirement.id && claim.status === "supported")
		) {
			reasons.push(`Required criterion '${requirement.id}' has no current supported proof claim.`);
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
