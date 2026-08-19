export type RunStatus = "running" | "paused" | "blocked" | "completed" | "failed";
export type RequirementStatus = "pending" | "active" | "claimed" | "verified" | "blocked";
export type EvidenceKind = "file" | "command" | "test" | "build" | "observation" | "user";
export type PermissionMode = "autonomous" | "guarded" | "locked";
export type BudgetPhase = "normal" | "observe" | "reserve" | "exhausted";
export type ReportStatus = "continue" | "complete" | "blocked";
export type ClaimStatus = "proposed" | "supported" | "stale" | "rejected";
export type ClaimRisk = "low" | "medium" | "high" | "critical";
export type AuditRoute = "continue" | "verify" | "semantic_audit" | "human_review";
export type SemanticAuditMode = "off" | "shadow";
export type SemanticAuditVerdict = "pass" | "reject" | "contract_drift" | "inconclusive";

export interface Requirement {
	id: string;
	description: string;
	required: boolean;
	status: RequirementStatus;
	evidenceIds: string[];
	updatedAt: number;
}

export interface GoalContract {
	objective: string;
	requirements: Requirement[];
	constraints: string[];
	createdAt: number;
}

export interface Evidence {
	id: string;
	kind: EvidenceKind;
	source: string;
	subject: string;
	summary: string;
	mutationEpoch: number;
	observedAt: number;
	contentHash?: string;
	exitCode?: number;
	dependencyPaths?: string[];
	globalScope?: boolean;
	invalidatedAt?: number;
	invalidatedByMutationEpoch?: number;
	invalidationReason?: string;
}

export interface ClaimSubmission {
	requirementId: string;
	statement: string;
	evidenceIds: string[];
	dependencyPaths?: string[];
	risk?: ClaimRisk;
}

export interface ProofClaim {
	id: string;
	requirementId: string;
	statement: string;
	status: ClaimStatus;
	risk: ClaimRisk;
	evidenceIds: string[];
	dependencyPaths: string[];
	createdAt: number;
	updatedAt: number;
	invalidatedAt?: number;
	invalidationReason?: string;
}

export interface ProofGraph {
	claims: ProofClaim[];
}

export interface AuditDecision {
	route: AuditRoute;
	riskScore: number;
	reasons: string[];
	claimIds: string[];
	advisory: boolean;
	updatedAt: number;
}

export interface AuditCriterion {
	id: string;
	requirementId: string;
	description: string;
	required: boolean;
}

export interface SemanticAuditEvidence {
	id: string;
	kind: "read" | "list" | "search";
	subject: string;
	summary: string;
	contentHash?: string;
	excerpt?: string;
}

export interface SemanticCriterionResult {
	criterionId: string;
	status: "pass" | "fail" | "inconclusive";
	reason: string;
	evidenceIds: string[];
}

export interface ContractDriftFinding {
	type: "missing_requirement" | "unsupported_added_constraint" | "changed_meaning";
	description: string;
	claimId?: string;
}

export interface SemanticAuditRecord {
	id: string;
	round: number;
	mode: "shadow";
	status: "completed" | "failed";
	snapshotId: string;
	snapshotFileCount: number;
	snapshotBytes: number;
	skippedPaths: string[];
	criteria: AuditCriterion[];
	verdict?: SemanticAuditVerdict;
	criterionResults: SemanticCriterionResult[];
	contractDrift: ContractDriftFinding[];
	missingEvidence: string[];
	confidence?: number;
	evidence: SemanticAuditEvidence[];
	usage: BudgetUsage;
	startedAt: number;
	finishedAt: number;
	error?: string;
}

export interface Artifact {
	id: string;
	path: string;
	contentHash: string;
	mutationEpoch: number;
	updatedAt: number;
}

export interface VerifiedFact {
	id: string;
	statement: string;
	evidenceIds: string[];
	verifiedAt: number;
}

export interface Conflict {
	id: string;
	description: string;
	open: boolean;
	createdAt: number;
}

export interface ProgressState {
	lastScore: number;
	lastProgressRound: number;
	stalledRounds: number;
	lastDelta: ProgressDelta;
}

export interface ProgressDelta {
	verifiedRequirements: number;
	supportedClaims: number;
	validEvidence: number;
	artifacts: number;
	resolvedUnknowns: number;
	resolvedConflicts: number;
	mutationEpochs: number;
	score: number;
}

export interface BudgetConfig {
	observeAfterTokens: number;
	hardTokenLimit: number;
	reserveTokens: number;
	maxToolCalls: number;
	maxWallTimeMs: number;
	maxStalledRounds: number;
	maxRounds: number;
	maxConsecutiveModelErrors: number;
	modelRetryBaseDelayMs: number;
	modelRetryMaxDelayMs: number;
	maxRoundTimeMs: number;
}

export interface BudgetUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	reasoningTokens: number;
	costUsd: number;
	toolCalls: number;
	wallTimeMs: number;
}

export interface ModelSelection {
	provider: string;
	modelId: string;
	reasoning: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

export interface RunHealth {
	consecutiveModelErrors: number;
	totalModelErrors: number;
	lastModelError?: string;
	lastModelErrorAt?: number;
}

export interface RunState {
	version: 1;
	id: string;
	workspace: string;
	status: RunStatus;
	contract: GoalContract;
	model: ModelSelection;
	permissionMode: PermissionMode;
	requirements: Requirement[];
	evidence: Evidence[];
	artifacts: Artifact[];
	facts: VerifiedFact[];
	unknowns: string[];
	conflicts: Conflict[];
	frontier: string;
	recoveryGuidance?: string;
	mutationEpoch: number;
	round: number;
	eventSequence: number;
	progress: ProgressState;
	health: RunHealth;
	budget: BudgetConfig;
	usage: BudgetUsage;
	proof: ProofGraph;
	audit: AuditDecision;
	semanticAuditMode: SemanticAuditMode;
	semanticAudits: SemanticAuditRecord[];
	startedAt: number;
	updatedAt: number;
	completedAt?: number;
}

export interface StateReport {
	status: ReportStatus;
	summary: string;
	requirementIds: string[];
	evidenceIds: string[];
	nextFrontier: string;
	unknowns: string[];
	conflicts: string[];
	resolvedUnknowns: string[];
	resolvedConflictIds: string[];
	claims?: ClaimSubmission[];
}

export interface RunEvent {
	id: string;
	runId: string;
	sequence: number;
	at: number;
	type:
		| "run_created"
		| "run_detached"
		| "run_resumed"
		| "round_started"
		| "model_started"
		| "model_completed"
		| "model_usage_recorded"
		| "model_failed"
		| "model_retry_scheduled"
		| "tool_started"
		| "tool_completed"
		| "evidence_recorded"
		| "state_reported"
		| "audit_routed"
		| "semantic_audit_started"
		| "semantic_audit_completed"
		| "progress_measured"
		| "recovery_selected"
		| "run_blocked"
		| "run_completed"
		| "run_paused"
		| "run_failed";
	payload: Record<string, unknown>;
}

export interface StateSnapshot {
	verifiedRequirements: number;
	supportedClaims: number;
	validEvidence: number;
	artifacts: number;
	unknowns: number;
	openConflicts: number;
	mutationEpoch: number;
}

export interface CompletionDecision {
	complete: boolean;
	reasons: string[];
	acceptedEvidenceIds: string[];
}

export const DEFAULT_BUDGET: BudgetConfig = {
	observeAfterTokens: 750_000,
	hardTokenLimit: 1_000_000,
	reserveTokens: 100_000,
	maxToolCalls: 1_000,
	maxWallTimeMs: 12 * 60 * 60_000,
	maxStalledRounds: 4,
	maxRounds: 200,
	maxConsecutiveModelErrors: 8,
	modelRetryBaseDelayMs: 1_000,
	modelRetryMaxDelayMs: 60_000,
	maxRoundTimeMs: 30 * 60_000,
};

export function emptyUsage(): BudgetUsage {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		reasoningTokens: 0,
		costUsd: 0,
		toolCalls: 0,
		wallTimeMs: 0,
	};
}
