import * as readline from "node:readline/promises";
import type { HarnessObserver } from "../core/harness";
import type { RunState } from "../core/types";

const dim = "\u001b[2m";
const cyan = "\u001b[36m";
const yellow = "\u001b[33m";
const green = "\u001b[32m";
const reset = "\u001b[0m";

export interface TerminalObserverOptions {
	quiet?: boolean;
	allowHighRisk?: boolean;
}

export function createTerminalObserver(options: TerminalObserverOptions = {}): HarnessObserver {
	let lineOpen = false;
	return {
		onText(delta) {
			if (options.quiet) return;
			lineOpen = true;
			process.stdout.write(delta);
		},
		onEvent(event) {
			if (options.quiet) return;
			const prefix = lineOpen ? "\n" : "";
			lineOpen = false;
			if (event.type === "round_started") {
				process.stderr.write(
					`${prefix}${cyan}round ${String(event.payload.round)}${reset} ${dim}${String(event.payload.phase)} · ${String(event.payload.frontier).slice(0, 120)}${reset}\n`,
				);
			} else if (event.type === "tool_started") {
				process.stderr.write(`${prefix}${dim}→ ${String(event.payload.tool)} ${String(event.payload.target ?? "")}${reset}\n`);
			} else if (event.type === "tool_completed" && event.payload.success === false) {
				process.stderr.write(`${prefix}${yellow}tool failed: ${String(event.payload.error ?? event.payload.tool)}${reset}\n`);
			} else if (event.type === "progress_measured") {
				const delta = event.payload.delta as { score?: number } | undefined;
				process.stderr.write(
					`${prefix}${dim}progress +${String(delta?.score ?? 0)} · stalled ${String(event.payload.stalledRounds)}${reset}\n`,
				);
			} else if (event.type === "audit_routed") {
				process.stderr.write(
					`${prefix}${dim}audit ${String(event.payload.route)} · risk ${String(event.payload.riskScore)}${reset}\n`,
				);
			} else if (event.type === "semantic_audit_started") {
				process.stderr.write(`${prefix}${dim}semantic audit shadow started${reset}\n`);
			} else if (event.type === "semantic_audit_completed") {
				process.stderr.write(
					`${prefix}${dim}semantic audit ${String(event.payload.verdict ?? event.payload.status)}${reset}\n`,
				);
			} else if (event.type === "run_completed") {
				process.stderr.write(`${prefix}${green}verified completion${reset}\n`);
			} else if (event.type === "run_blocked") {
				process.stderr.write(`${prefix}${yellow}blocked: ${String(event.payload.reason)}${reset}\n`);
			}
		},
		async authorize(input) {
			if (options.allowHighRisk) return true;
			if (!process.stdin.isTTY || !process.stderr.isTTY) return false;
			const prompt = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
			try {
				process.stderr.write(`\n${yellow}${input.reason}${reset}\n  ${input.command}\n`);
				const answer = await prompt.question("Authorize once? [y/N] ");
				return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
			} finally {
				prompt.close();
			}
		},
	};
}

export function printRunSummary(state: RunState): void {
	const verified = state.requirements.filter(item => item.status === "verified").length;
	const total = state.requirements.filter(item => item.required).length;
	process.stdout.write(
		`${JSON.stringify(
			{
				runId: state.id,
				status: state.status,
				workspace: state.workspace,
				model: `${state.model.provider}/${state.model.modelId}`,
				round: state.round,
				frontier: state.frontier,
				verified: `${verified}/${total}`,
				mutationEpoch: state.mutationEpoch,
				stalledRounds: state.progress.stalledRounds,
				usage: state.usage,
				recoveryGuidance: state.recoveryGuidance,
				proof: {
					supported: state.proof.claims.filter(item => item.status === "supported").length,
					stale: state.proof.claims.filter(item => item.status === "stale").length,
					total: state.proof.claims.length,
				},
				audit: state.audit,
				semanticAudit: {
					mode: state.semanticAuditMode,
					count: state.semanticAudits.length,
					last: state.semanticAudits.at(-1),
				},
			},
			null,
			2,
		)}\n`,
	);
}
