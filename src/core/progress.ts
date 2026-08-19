import type { ProgressDelta, RunState, StateSnapshot } from "./types";
import { ensureProofState, evidenceIsCurrent } from "./proof";

export function snapshotState(state: RunState): StateSnapshot {
	ensureProofState(state);
	return {
		verifiedRequirements: state.requirements.filter(item => item.status === "verified").length,
		supportedClaims: state.proof.claims.filter(item => item.status === "supported").length,
		validEvidence: state.evidence.filter(
			item => evidenceIsCurrent(state, item) && ["file", "test", "build", "user"].includes(item.kind),
		).length,
		artifacts: state.artifacts.length,
		unknowns: state.unknowns.length,
		openConflicts: state.conflicts.filter(item => item.open).length,
		mutationEpoch: state.mutationEpoch,
	};
}

export function measureProgress(before: StateSnapshot, after: StateSnapshot): ProgressDelta {
	const delta: ProgressDelta = {
		verifiedRequirements: Math.max(0, after.verifiedRequirements - before.verifiedRequirements),
		supportedClaims: Math.max(0, after.supportedClaims - before.supportedClaims),
		validEvidence: Math.max(0, after.validEvidence - before.validEvidence),
		artifacts: Math.max(0, after.artifacts - before.artifacts),
		resolvedUnknowns: Math.max(0, before.unknowns - after.unknowns),
		resolvedConflicts: Math.max(0, before.openConflicts - after.openConflicts),
		mutationEpochs: Math.max(0, after.mutationEpoch - before.mutationEpoch),
		score: 0,
	};
	delta.score =
		delta.verifiedRequirements * 12 +
		delta.validEvidence * 3 +
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
