import * as path from "node:path";
import type {
	AuditDecision,
	ClaimRisk,
	ClaimSubmission,
	Evidence,
	ProofClaim,
	ProofGraph,
	RunState,
	StateReport,
} from "./types";

const MAX_CLAIMS = 500;

function unique(items: readonly string[]): string[] {
	return [...new Set(items.map(item => item.trim()).filter(Boolean))];
}

function normalizedDependency(value: string): string {
	const normalized = path.normalize(value.trim()).replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
	return normalized === "." ? "" : normalized;
}

function dependenciesIntersect(left: string, right: string): boolean {
	const a = normalizedDependency(left);
	const b = normalizedDependency(right);
	if (!a || !b) return true;
	return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function emptyProofGraph(): ProofGraph {
	return { claims: [] };
}

export function defaultAuditDecision(): AuditDecision {
	return {
		route: "continue",
		riskScore: 0,
		reasons: [],
		claimIds: [],
		advisory: true,
		updatedAt: Date.now(),
	};
}

export function ensureProofState(state: RunState): void {
	state.proof ??= emptyProofGraph();
	state.proof.claims ??= [];
	state.audit ??= defaultAuditDecision();
	state.progress.lastDelta.supportedClaims ??= 0;
}

export function evidenceIsCurrent(state: RunState, evidence: Evidence): boolean {
	if (evidence.invalidatedAt !== undefined) return false;
	if (evidence.globalScope || (evidence.dependencyPaths?.length ?? 0) > 0) return true;
	// Legacy evidence has no dependency metadata, so preserve the original
	// mutation-epoch semantics when resuming old runs.
	return evidence.mutationEpoch >= state.mutationEpoch;
}

export function currentEvidence(state: RunState, ids?: readonly string[]): Evidence[] {
	const requested = ids ? new Set(ids) : undefined;
	return state.evidence.filter(
		item => (!requested || requested.has(item.id)) && evidenceIsCurrent(state, item),
	);
}

function inferRisk(state: RunState, submission: ClaimSubmission, evidence: Evidence[]): ClaimRisk {
	if (submission.risk) return submission.risk;
	const requirement = state.requirements.find(item => item.id === submission.requirementId)?.description ?? "";
	const text = `${requirement} ${submission.statement}`;
	if (/\b(?:production|deploy|publish|payment|credential|secret|security|delete|irreversible|legal)\b/i.test(text)) {
		return "high";
	}
	if (/\b(?:visual|design|layout|document|presentation|semantic|quality|user experience|gui)\b/i.test(text)) {
		return "high";
	}
	if (evidence.some(item => item.kind === "test" || item.kind === "build")) return "low";
	return "medium";
}

function dependenciesFor(submission: ClaimSubmission, evidence: Evidence[]): string[] {
	return unique([
		...(submission.dependencyPaths ?? []),
		...evidence.flatMap(item => item.dependencyPaths ?? []),
	].map(normalizedDependency));
}

function claimKey(requirementId: string, statement: string): string {
	return `${requirementId}\u0000${statement.trim()}`;
}

export function applyProofClaims(state: RunState, report: StateReport): ProofClaim[] {
	ensureProofState(state);
	const submissions: ClaimSubmission[] = report.claims?.length
		? report.claims
		: report.status === "complete"
			? report.requirementIds.map(requirementId => ({
					requirementId,
					statement: report.summary || `Requirement ${requirementId} is complete.`,
					evidenceIds: [...report.evidenceIds],
				}))
			: [];
	const changed: ProofClaim[] = [];
	for (const submission of submissions) {
		const statement = submission.statement.trim();
		if (!statement) continue;
		const evidence = currentEvidence(state, submission.evidenceIds);
		const allEvidenceCurrent =
			submission.evidenceIds.length > 0 && evidence.length === new Set(submission.evidenceIds).size;
		const status = allEvidenceCurrent ? "supported" : submission.evidenceIds.length > 0 ? "stale" : "proposed";
		const now = Date.now();
		const existing = state.proof.claims.find(
			item => claimKey(item.requirementId, item.statement) === claimKey(submission.requirementId, statement),
		);
		if (existing) {
			existing.status = status;
			existing.evidenceIds = unique(submission.evidenceIds);
			existing.dependencyPaths = dependenciesFor(submission, evidence);
			existing.risk = inferRisk(state, submission, evidence);
			existing.updatedAt = now;
			if (status === "supported") {
				delete existing.invalidatedAt;
				delete existing.invalidationReason;
			}
			changed.push(existing);
			continue;
		}
		const claim: ProofClaim = {
			id: `claim-${crypto.randomUUID()}`,
			requirementId: submission.requirementId,
			statement,
			status,
			risk: inferRisk(state, submission, evidence),
			evidenceIds: unique(submission.evidenceIds),
			dependencyPaths: dependenciesFor(submission, evidence),
			createdAt: now,
			updatedAt: now,
		};
		state.proof.claims.push(claim);
		changed.push(claim);
	}
	if (state.proof.claims.length > MAX_CLAIMS) {
		const protectedClaims = state.proof.claims.filter(item => item.status === "supported");
		const protectedIds = new Set(protectedClaims.map(item => item.id));
		const capacity = Math.max(0, MAX_CLAIMS - protectedClaims.length);
		const recent = state.proof.claims.filter(item => !protectedIds.has(item.id)).slice(-capacity);
		state.proof.claims = [...protectedClaims, ...recent].slice(-MAX_CLAIMS);
	}
	return changed;
}

export function recordMutation(
	state: RunState,
	changedPaths: readonly string[],
	reason: string,
): { mutationEpoch: number; invalidatedEvidenceIds: string[]; staleClaimIds: string[] } {
	ensureProofState(state);
	state.mutationEpoch += 1;
	const normalized = unique(changedPaths.map(normalizedDependency));
	const invalidatedEvidenceIds: string[] = [];
	for (const evidence of state.evidence) {
		if (evidence.invalidatedAt !== undefined) continue;
		const scoped = evidence.globalScope || (evidence.dependencyPaths?.length ?? 0) > 0;
		if (!scoped) continue;
		const affected =
			Boolean(evidence.globalScope) ||
			(evidence.dependencyPaths ?? []).some(dependency =>
				normalized.some(changed => dependenciesIntersect(dependency, changed)),
			);
		if (!affected) continue;
		evidence.invalidatedAt = Date.now();
		evidence.invalidatedByMutationEpoch = state.mutationEpoch;
		evidence.invalidationReason = reason;
		invalidatedEvidenceIds.push(evidence.id);
	}
	const staleClaimIds: string[] = [];
	const invalidated = new Set(invalidatedEvidenceIds);
	for (const claim of state.proof.claims) {
		if (claim.status === "stale" || claim.status === "rejected") continue;
		if (!claim.evidenceIds.some(id => invalidated.has(id))) continue;
		claim.status = "stale";
		claim.invalidatedAt = Date.now();
		claim.invalidationReason = reason;
		claim.updatedAt = Date.now();
		staleClaimIds.push(claim.id);
	}
	return { mutationEpoch: state.mutationEpoch, invalidatedEvidenceIds, staleClaimIds };
}

function hasDeterministicEvidence(state: RunState, claim: ProofClaim): boolean {
	return currentEvidence(state, claim.evidenceIds).some(item => item.kind === "test" || item.kind === "build");
}

export function assessAuditRisk(state: RunState, report?: StateReport): AuditDecision {
	ensureProofState(state);
	const reasons: string[] = [];
	const claimIds = new Set<string>();
	let riskScore = 0;
	let route: AuditDecision["route"] = "continue";
	const supported = state.proof.claims.filter(item => item.status === "supported");
	const stale = state.proof.claims.filter(item => item.status === "stale");
	if (stale.length > 0) {
		riskScore += 55;
		route = "semantic_audit";
		reasons.push(`${stale.length} proof claim(s) became stale after workspace changes.`);
		stale.forEach(item => claimIds.add(item.id));
	}
	const highRisk = supported.filter(item => item.risk === "high" || item.risk === "critical");
	if (highRisk.length > 0) {
		riskScore += highRisk.some(item => item.risk === "critical") ? 60 : 40;
		route = "semantic_audit";
		reasons.push(`${highRisk.length} supported claim(s) are high-risk or semantic.`);
		highRisk.forEach(item => claimIds.add(item.id));
	}
	const unsupportedSemantics = supported.filter(item => !hasDeterministicEvidence(state, item) && item.risk !== "low");
	if (report?.status === "complete" && unsupportedSemantics.length > 0) {
		riskScore += 35;
		route = "semantic_audit";
		reasons.push(`${unsupportedSemantics.length} completion claim(s) lack deterministic test/build evidence.`);
		unsupportedSemantics.forEach(item => claimIds.add(item.id));
	}
	const current = currentEvidence(state);
	if (
		state.mutationEpoch > 0 &&
		report?.status === "complete" &&
		!current.some(item => item.kind === "test" || item.kind === "build")
	) {
		riskScore += 30;
		if (route === "continue") route = "verify";
		reasons.push("The latest workspace mutation has no current deterministic verification evidence.");
	}
	if (state.progress.stalledRounds >= 2) {
		riskScore += 25;
		route = "semantic_audit";
		reasons.push(`The run has stalled for ${state.progress.stalledRounds} rounds.`);
	}
	if (state.conflicts.some(item => item.open)) {
		riskScore += 35;
		route = "semantic_audit";
		reasons.push("Open evidence conflicts require independent review.");
	}
	const authorityText = [...state.unknowns, ...state.conflicts.filter(item => item.open).map(item => item.description)].join(" ");
	if (/\b(?:authorization|approval|credential|secret|payment|legal authority|publish externally)\b/i.test(authorityText)) {
		riskScore = Math.max(riskScore, 90);
		route = "human_review";
		reasons.push("The remaining uncertainty requires external authority or sensitive input.");
	}
	return {
		route,
		riskScore: Math.min(100, riskScore),
		reasons: unique(reasons),
		claimIds: [...claimIds],
		advisory: true,
		updatedAt: Date.now(),
	};
}
