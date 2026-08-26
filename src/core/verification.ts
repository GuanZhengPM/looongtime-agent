import type { Evidence, EvidenceKind, RunState } from "./types";
import * as path from "node:path";

const CONTROL_OPERATOR = /(?:\r|\n|&&|\|\||[;|`<>]|\$\()/;
const INTERPRETER_ESCAPE = /^\s*(?:bash|sh|zsh|fish|cmd|powershell|pwsh)\b.*(?:\s-c\b|\s-command\b)/i;
const INLINE_PROGRAM = /^\s*(?:python3?|node|ruby|perl|php)\b.*(?:\s-c\b|\s-e\b)/i;
const MASKED_FAILURE = /(?:\|\|\s*(?:true|:|exit\s+0)\b|;\s*exit\s+0\b|\bset\s+\+e\b|--passWithNoTests\b|--allow-no-tests\b|--if-present\b)/i;
const UNSAFE_EXIT_FLOW = /(?:\r|\n|\|\||;|(^|[^|])\|(?!\|)|(^|[^&])&(?!&))/m;
const TRIVIAL_COMMAND = /^\s*(?::|true|exit\s+0|echo(?:\s+.*)?|printf(?:\s+.*)?|pwd|sleep\s+\S+)\s*$/i;
const PACKAGE_SCRIPT_CALL = /\b(?:(?:npm|pnpm|yarn)\s+(?:run\s+)?([\w:.-]+)|bun\s+run\s+([\w:.-]+))/gi;

export function normalizeVerificationCommand(command: string): string {
	return command.trim().replace(/\s+/g, " ");
}

export function verificationCommandHash(command: string): string {
	return new Bun.CryptoHasher("sha256").update(normalizeVerificationCommand(command)).digest("hex");
}

function recognizedVerificationKind(command: string): Extract<EvidenceKind, "test" | "build"> | undefined {
	const normalized = normalizeVerificationCommand(command);
	if (/^(?:bun|npm|pnpm|yarn)\s+(?:test(?:\s|$)|run\s+test(?:\s|$))/i.test(normalized)) return "test";
	if (/^(?:go\s+test|cargo\s+test|pytest(?:\s|$)|python3?\s+-m\s+pytest(?:\s|$))/i.test(normalized)) {
		if (/\b(?:--collect-only|--no-run|-list(?:=|\s|$))\b/i.test(normalized)) return undefined;
		return "test";
	}
	if (/^(?:bun|npm|pnpm|yarn)\s+run\s+(?:build|check|lint|typecheck)(?:\s|$)/i.test(normalized)) return "build";
	if (/^(?:go\s+(?:build|vet)|cargo\s+(?:build|check|clippy)|tsc(?:\s|$)|make(?:\s|$)|gmake(?:\s|$)|cmake\s+--build)/i.test(normalized)) {
		return "build";
	}
	// POSIX file assertions are useful for artifact-producing, non-code tasks.
	if (/^test\s+-(?:e|f|d|s|r|w|x)\s+\S+/i.test(normalized)) return "test";
	return undefined;
}

export function verificationKindFor(
	state: RunState,
	command: string,
): Extract<EvidenceKind, "test" | "build"> | undefined {
	const normalized = normalizeVerificationCommand(command);
	const declared = state.contract.verificationCommands.some(
		item => normalizeVerificationCommand(item) === normalized,
	);
	if (!declared && (CONTROL_OPERATOR.test(command) || INTERPRETER_ESCAPE.test(command) || INLINE_PROGRAM.test(command))) {
		return undefined;
	}
	return recognizedVerificationKind(command) ?? (declared ? "test" : undefined);
}

export async function assertVerificationCommandSafe(workspace: string, command: string): Promise<void> {
	if (TRIVIAL_COMMAND.test(command)) throw new Error("Verification command is a trivial no-op.");
	if (MASKED_FAILURE.test(command) || UNSAFE_EXIT_FLOW.test(command)) {
		throw new Error("Verification command can mask or detach failure, or accept a missing test suite.");
	}
	const normalized = normalizeVerificationCommand(command);
	// `bun test` invokes Bun's test runner directly; only `bun run test` invokes
	// package.json. npm/pnpm/yarn use their package script for both forms.
	const match = normalized.match(/^(?:(?:npm|pnpm|yarn)\s+(?:run\s+)?([^\s]+)|bun\s+run\s+([^\s]+))/i);
	if (!match) return;
	const matchedName = match[1] ?? match[2];
	const requested = matchedName?.toLowerCase();
	const scriptName = requested === "test" ? "test" : matchedName;
	if (!scriptName) return;
	try {
		const manifest = await Bun.file(path.join(workspace, "package.json")).json() as {
			scripts?: Record<string, unknown>;
		};
		const scripts = manifest.scripts ?? {};
		const checked = new Set<string>();
		const inspect = (name: string): void => {
			if (checked.has(name)) return;
			checked.add(name);
			const script = scripts[name];
			if (typeof script !== "string") return;
			if (TRIVIAL_COMMAND.test(script)) {
				throw new Error(`package.json script '${name}' is a trivial no-op and cannot verify completion.`);
			}
			if (MASKED_FAILURE.test(script) || UNSAFE_EXIT_FLOW.test(script)) {
				throw new Error(`package.json script '${name}' can mask or detach failure, or accept a missing test suite.`);
			}
			for (const match of script.matchAll(PACKAGE_SCRIPT_CALL)) {
				const dependency = match[1] ?? match[2];
				if (dependency && dependency !== name && dependency in scripts) inspect(dependency);
			}
		};
		inspect(scriptName);
	} catch (error) {
		if (error instanceof Error && error.message.includes("can mask or detach failure")) throw error;
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

export function evidenceVerifiesRequirement(evidence: Evidence, requirementId: string): boolean {
	return (
		(evidence.kind === "test" || evidence.kind === "build") &&
		evidence.source === "verify" &&
		evidence.exitCode === 0 &&
		evidence.outcome === "passed" &&
		Boolean(evidence.commandHash) &&
		Boolean(evidence.verifiesRequirementIds?.includes(requirementId))
	);
}
