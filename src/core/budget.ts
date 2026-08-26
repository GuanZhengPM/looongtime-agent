import type { BudgetPhase, BudgetUsage, RunState } from "./types";

export function activeTokens(usage: BudgetUsage): number {
	return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

export function budgetPhase(state: RunState): BudgetPhase {
	const tokens = activeTokens(state.usage);
	if (
		tokens >= state.budget.hardTokenLimit ||
		state.usage.toolCalls >= state.budget.maxToolCalls ||
		state.usage.wallTimeMs >= state.budget.maxWallTimeMs ||
		(state.budget.maxCostUsd !== undefined && state.usage.costUsd >= state.budget.maxCostUsd) ||
		state.round >= state.budget.maxRounds
	) {
		return "exhausted";
	}
	if (tokens >= state.budget.hardTokenLimit - state.budget.reserveTokens) return "reserve";
	if (tokens >= state.budget.observeAfterTokens) return "observe";
	return "normal";
}

export function remainingTokens(state: RunState): number {
	return Math.max(0, state.budget.hardTokenLimit - activeTokens(state.usage));
}

export function executionTokenAllowance(state: RunState): number {
	const remaining = remainingTokens(state);
	const reserve = budgetPhase(state) === "reserve" ? 0 : state.budget.reserveTokens;
	return Math.max(0, remaining - reserve);
}
