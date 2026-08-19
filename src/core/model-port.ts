import type { BudgetUsage, ModelSelection, StateReport } from "./types";

export interface ModelToolSpec {
	name: string;
	description: string;
	parameters: object;
}

export interface ModelToolCall {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export interface ModelToolResult {
	text: string;
	isError: boolean;
	report?: StateReport;
	stop?: boolean;
}

export interface ModelRoundRequest {
	model: ModelSelection;
	sessionId?: string;
	systemPrompt: string;
	userPrompt: string;
	tools: ModelToolSpec[];
	maxTurns: number;
	maxOutputTokens: number;
	signal: AbortSignal;
	onText?: (delta: string) => void;
	onUsage?: (usage: BudgetUsage) => void | Promise<void>;
	onToolCall?: (call: ModelToolCall) => void | Promise<void>;
	executeTool(call: ModelToolCall): Promise<ModelToolResult>;
}

export interface ModelRoundResult {
	output: string;
	report?: StateReport;
	usage: BudgetUsage;
	turns: number;
}

export interface ModelDescriptor {
	provider: string;
	id: string;
	name: string;
	api: string;
	contextWindow: number;
	maxOutputTokens: number;
	reasoning: boolean;
}

export interface ModelPort {
	list(provider?: string): ModelDescriptor[];
	assertAvailable(selection: ModelSelection, signal?: AbortSignal): Promise<void>;
	runRound(request: ModelRoundRequest): Promise<ModelRoundResult>;
	closeSession?(sessionId: string): void;
}
