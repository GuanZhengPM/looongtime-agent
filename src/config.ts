import * as path from "node:path";
import type { ModelSelection, PermissionMode, SemanticAuditMode } from "./core/types";
import { looongtimeHome } from "./paths";

export interface LooongtimeConfig {
	defaultModel?: string;
	reasoning?: ModelSelection["reasoning"];
	permissionMode?: PermissionMode;
	semanticAuditMode?: SemanticAuditMode;
}

export function configPath(): string {
	return path.join(looongtimeHome(), "config.json");
}

export async function loadConfig(): Promise<LooongtimeConfig> {
	try {
		return (await Bun.file(configPath()).json()) as LooongtimeConfig;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
}

export function parseModelSelection(
	value: string,
	reasoning: ModelSelection["reasoning"] = "high",
): ModelSelection {
	const separator = value.indexOf("/");
	if (separator <= 0 || separator === value.length - 1) {
		throw new Error(`Model must use provider/model-id form, received '${value}'.`);
	}
	return {
		provider: value.slice(0, separator),
		modelId: value.slice(separator + 1),
		reasoning,
	};
}
