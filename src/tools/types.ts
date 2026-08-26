import type { Tool } from "@earendil-works/pi-ai";
import type { ModelToolCall } from "../core/model-port";
import type { RunRepository } from "../core/repository";
import type { Evidence, PermissionMode, RunState, StateReport } from "../core/types";

export type ShellRisk = "low" | "medium" | "high";

export interface ToolOutcome {
	text: string;
	isError: boolean;
	evidence: Evidence[];
	report?: StateReport;
}

export interface ToolExecutionContext {
	state: RunState;
	repository: RunRepository;
	signal: AbortSignal;
	permissionMode: PermissionMode;
	allowNetwork?: boolean;
	authorize?: (input: { command: string; risk: ShellRisk; reason: string }) => boolean | Promise<boolean>;
}

export interface ExecutableTool {
	definition: Tool;
	execute(call: ModelToolCall, context: ToolExecutionContext): Promise<ToolOutcome>;
}
