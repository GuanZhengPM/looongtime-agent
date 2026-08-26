import type { ProgressDelta, RunState, StateSnapshot } from "./types";
import { ensureProofState, evidenceIsCurrent, factIsCurrent } from "./proof";

function evidenceSignature(item: RunState["evidence"][number]): string {
	return [
		item.kind,
		item.source,
		item.subject,
		item.summary,
		item.contentHash ?? "",
		String(item.exitCode ?? ""),
		item.outcome ?? "",
		(item.verifiesRequirementIds ?? []).slice().sort().join(","),
		item.commandHash ?? "",
		(item.dependencyPaths ?? []).slice().sort().join(","),
		String(Boolean(item.globalScope)),
		String(item.mutationEpoch),
	].join("\u0000");
}

function novelCount(before: readonly string[], after: readonly string[]): number {
	const previous = new Set(before);
	return new Set(after.filter(item => !previous.has(item))).size;
}

export function snapshotState(state: RunState): StateSnapshot {
	ensureProofState(state);
	const current = state.evidence.filter(item => evidenceIsCurrent(state, item));
	const valid = current.filter(item => ["file", "test", "build", "user"].includes(item.kind));
	const diagnostic = current.filter(item => item.outcome === "failed" || item.kind === "observation");
	return {
		verifiedRequirements: state.requirements.filter(item => item.status === "verified").length,
		supportedClaims: state.proof.claims.filter(item => item.status === "supported").length,
		validEvidence: valid.length,
		artifacts: state.artifacts.length,
		unknowns: state.unknowns.length,
		openConflicts: state.conflicts.filter(item => item.open).length,
		mutationEpoch: state.mutationEpoch,
		diagnosticEvidence: diagnostic.length,
		verifiedFacts: state.facts.filter(item => factIsCurrent(state, item)).length,
		validEvidenceSignatures: valid.map(evidenceSignature),
		diagnosticEvidenceSignatures: diagnostic.map(evidenceSignature),
		artifactSignatures: state.artifacts.map(item => `${item.path}\u0000${item.contentHash}`),
	};
}

export function measureProgress(before: StateSnapshot, after: StateSnapshot): ProgressDelta {
	const delta: ProgressDelta = {
		verifiedRequirements: Math.max(0, after.verifiedRequirements - before.verifiedRequirements),
		supportedClaims: Math.max(0, after.supportedClaims - before.supportedClaims),
		validEvidence: novelCount(before.validEvidenceSignatures, after.validEvidenceSignatures),
		artifacts: novelCount(before.artifactSignatures, after.artifactSignatures),
		resolvedUnknowns: Math.max(0, before.unknowns - after.unknowns),
		resolvedConflicts: Math.max(0, before.openConflicts - after.openConflicts),
		mutationEpochs: Math.max(0, after.mutationEpoch - before.mutationEpoch),
		diagnosticEvidence: novelCount(before.diagnosticEvidenceSignatures, after.diagnosticEvidenceSignatures),
		verifiedFacts: Math.max(0, after.verifiedFacts - before.verifiedFacts),
		score: 0,
	};
	delta.score =
		delta.verifiedRequirements * 12 +
		delta.supportedClaims * 5 +
		delta.validEvidence * 3 +
		delta.diagnosticEvidence +
		delta.verifiedFacts * 3 +
		delta.artifacts * 4 +
		delta.resolvedUnknowns * 3 +
		delta.resolvedConflicts * 5;
	return delta;
}

export function applyProgress(state: RunState, delta: ProgressDelta): void {
	state.progress.lastDelta = delta;
	state.progress.lastScore = delta.score;
	if (delta.score > 0) {
		state.progress.lastProgressRound = state.round;
		state.progress.stalledRounds = 0;
	} else {
		state.progress.stalledRounds += 1;
	}
}

export function recoveryGuidance(state: RunState): string {
	const stalls = state.progress.stalledRounds;
	if (stalls <= 1) {
		return "No trusted state delta was committed. Re-read the current frontier and choose a different concrete action.";
	}
	if (stalls === 2) {
		return "The previous strategy stalled twice. Narrow the frontier, inspect primary evidence, and test a different hypothesis.";
	}
	return "Repeated no-progress rounds detected. Stop repeating prior calls; identify the blocking assumption and attempt one bounded recovery path.";
}
