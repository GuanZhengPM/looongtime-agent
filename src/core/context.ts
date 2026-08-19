import { budgetPhase } from "./budget";
import type { RunState } from "./types";
import { ensureProofState, evidenceIsCurrent } from "./proof";

let executorSystemPrompt: string | undefined;

async function loadSystemPrompt(): Promise<string> {
	executorSystemPrompt ??= await Bun.file(new URL("../prompts/executor.md", import.meta.url)).text();
	return executorSystemPrompt;
}

export interface CompiledContext {
	systemPrompt: string;
	userPrompt: string;
}

export async function compileContext(state: RunState): Promise<CompiledContext> {
	ensureProofState(state);
	const phase = budgetPhase(state);
	const evidenceLimit = phase === "normal" ? 40 : phase === "observe" ? 20 : 10;
	const artifactLimit = phase === "normal" ? 100 : phase === "observe" ? 50 : 25;
	const factLimit = phase === "normal" ? 100 : phase === "observe" ? 50 : 25;
	const evidence = state.evidence
		.filter(item => evidenceIsCurrent(state, item))
		.slice(-evidenceLimit)
		.map(item => ({
			id: item.id,
			kind: item.kind,
			subject: item.subject,
			summary: item.summary,
			mutationEpoch: item.mutationEpoch,
		}));
	const payload = {
		runId: state.id,
		round: state.round,
		budgetPhase: phase,
		objective: state.contract.objective,
		constraints: state.contract.constraints,
		frontier: state.frontier,
		recoveryGuidance: state.recoveryGuidance,
		mutationEpoch: state.mutationEpoch,
		requirements: state.requirements.map(item => ({
			id: item.id,
			description: item.description,
			required: item.required,
			status: item.status,
			evidenceIds: item.evidenceIds,
		})),
		verifiedFacts: state.facts.slice(-factLimit),
		verifiedFactCount: state.facts.length,
		artifacts: [...state.artifacts].sort((left, right) => left.updatedAt - right.updatedAt).slice(-artifactLimit),
		artifactCount: state.artifacts.length,
		currentEvidence: evidence,
		proofClaims: state.proof.claims.slice(-100).map(item => ({
			id: item.id,
			requirementId: item.requirementId,
			statement: item.statement,
			status: item.status,
			risk: item.risk,
			evidenceIds: item.evidenceIds,
			dependencyPaths: item.dependencyPaths,
		})),
		proofClaimCount: state.proof.claims.length,
		auditDecision: state.audit,
		unknowns: state.unknowns.slice(-100),
		unknownCount: state.unknowns.length,
		conflicts: state.conflicts.filter(item => item.open).slice(-100),
		openConflictCount: state.conflicts.filter(item => item.open).length,
		progress: state.progress,
	};
	return {
		systemPrompt: await loadSystemPrompt(),
		userPrompt: `Work on the current frontier using the durable run state below.\n\n${JSON.stringify(payload, null, 2)}`,
	};
}
