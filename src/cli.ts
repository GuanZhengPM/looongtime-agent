#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { loadConfig, parseModelSelection } from "./config";
import { runHarness } from "./core/harness";
import { RunRepository } from "./core/repository";
import { applyBudgetOverrides, createRunState } from "./core/state";
import type { BudgetConfig, ModelSelection, PermissionMode, RunState, SemanticAuditMode } from "./core/types";
import { PiModelsPort } from "./providers/pi-models";
import { looongtimeModel } from "./paths";
import { runAuthCommand } from "./providers/auth-cli";
import { createTools } from "./tools/registry";
import { Workspace } from "./tools/workspace";
import { createTerminalObserver, printRunSummary } from "./ui/terminal";
import { runInteractive } from "./ui/interactive";

const HELP = `Looongtime — progress-driven long-running coding agent

Usage:
  looongtime                         Interactive π-style terminal
  looongtime chat [options]          Interactive terminal
  looongtime run [options] <task>
  looongtime resume [options] <run-id>
  looongtime status <run-id>
  looongtime events <run-id>
  looongtime models [provider]
  looongtime auth list
  looongtime auth <status|login|logout> <provider> [api_key|oauth]
  looongtime auth import-codex       Reuse the current Codex CLI ChatGPT login

Run options:
  --model <provider/model-id>     Model from the pi-ai catalog
  --audit-model <provider/model>  Model used for semantic audit (default: executor model)
  --reasoning <level>            minimal|low|medium|high|xhigh|max
  --cwd <path>                   Workspace (default: current directory)
  --permission <mode>            autonomous|guarded|locked
  --semantic-audit <mode>        off|shadow|gate (gate can reject completion)
  --require <criterion>          Add a hard requirement; may repeat
  --constraint <text>            Add a locked task constraint; may repeat
  --verify-command <command>     Allow a task-specific completion command; may repeat
  --require-change               Require a net workspace change before completion
  --allow-no-change              Allow evidence-only completion for an analysis/check task
  --max-tokens <number>          Run-level hard token limit
  --observe-after <number>       Enter token-observation mode
  --max-stalls <number>          Consecutive no-progress rounds before blocking
  --endurance <24h|48h|72h>     Apply a long-run budget profile
  --max-hours <number>           Active model/tool wall-time limit
  --max-rounds <number>          Maximum frontier rounds
  --max-tools <number>           Maximum host tool calls
  --max-retries <number>         Consecutive transient model errors to retry
  --round-timeout-minutes <n>    Timeout for one model/tool round
  --max-cost <usd>               Stop when recorded model cost reaches this USD limit
  --detach                       Run independently of the current terminal
  --allow-network                Permit sandboxed tools to access the network
  --deny-network                 Disable network access when resuming a run
  --allow-high-risk              Pre-authorize high-risk shell commands
  --quiet                        Hide streaming model/tool output

Environment:
  LOOONGTIME_MODEL                 Default provider/model-id
  LOOONGTIME_HOME                  State directory (default: ~/.looongtime)
  Provider API keys are resolved by @earendil-works/pi-ai.
`;

const REASONING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
const PERMISSION_MODES = ["autonomous", "guarded", "locked"] as const;
const SEMANTIC_AUDIT_MODES = ["off", "shadow", "gate"] as const;

interface RunArguments {
	model?: string;
	auditModel?: string;
	reasoning?: ModelSelection["reasoning"];
	cwd: string;
	cwdSpecified: boolean;
	permission?: PermissionMode;
	semanticAuditMode?: SemanticAuditMode;
	requirements: string[];
	constraints: string[];
	verificationCommands: string[];
	requiresWorkspaceChange?: boolean;
	budget: Partial<BudgetConfig>;
	enduranceHours?: 24 | 48 | 72;
	allowHighRisk: boolean;
	networkOverride?: boolean;
	detach: boolean;
	quiet: boolean;
	positionals: string[];
}

function parseReasoning(value: string): ModelSelection["reasoning"] {
	const match = REASONING_LEVELS.find(item => item === value);
	if (!match) throw new Error(`Unknown reasoning level '${value}'.`);
	return match;
}

function parsePermission(value: string): PermissionMode {
	const match = PERMISSION_MODES.find(item => item === value);
	if (!match) throw new Error(`Unknown permission mode '${value}'.`);
	return match;
}

function parseSemanticAuditMode(value: string): SemanticAuditMode {
	const match = SEMANTIC_AUDIT_MODES.find(item => item === value);
	if (!match) throw new Error(`Unknown semantic audit mode '${value}'.`);
	return match;
}

function positiveInteger(value: string, label: string): number {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer.`);
	return parsed;
}

function positiveNumber(value: string, label: string): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be a positive number.`);
	return parsed;
}

function enduranceHours(value: string): 24 | 48 | 72 {
	const normalized = value.toLowerCase().replace(/h$/, "");
	const parsed = Number(normalized);
	if (parsed !== 24 && parsed !== 48 && parsed !== 72) throw new Error("--endurance must be 24h, 48h, or 72h.");
	return parsed;
}

function enduranceBudget(hours: 24 | 48 | 72): Partial<BudgetConfig> {
	const scale = hours / 24;
	const hardTokenLimit = hours === 24 ? 100_000_000 : hours === 48 ? 250_000_000 : 500_000_000;
	return {
		hardTokenLimit,
		observeAfterTokens: Math.floor(hardTokenLimit * 0.8),
		reserveTokens: Math.floor(hardTokenLimit * 0.05),
		maxWallTimeMs: hours * 60 * 60_000,
		maxRounds: Math.floor(4_000 * scale),
		maxToolCalls: Math.floor(25_000 * scale),
		maxStalledRounds: 12,
		maxConsecutiveModelErrors: 12,
		modelRetryBaseDelayMs: 2_000,
		modelRetryMaxDelayMs: 120_000,
		maxRoundTimeMs: 45 * 60_000,
		maxCostUsd: hours === 24 ? 250 : hours === 48 ? 500 : 1_000,
	};
}

function requiredValue(args: string[], index: number, option: string): string {
	const value = args[index];
	if (!value) throw new Error(`${option} requires a value.`);
	return value;
}

function parseRunArguments(args: string[]): RunArguments {
	const result: RunArguments = {
		cwd: process.cwd(),
		cwdSpecified: false,
		requirements: [],
		constraints: [],
		verificationCommands: [],
		budget: {},
		allowHighRisk: false,
		detach: false,
		quiet: false,
		positionals: [],
	};
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--model") result.model = requiredValue(args, ++index, arg);
		else if (arg === "--audit-model") result.auditModel = requiredValue(args, ++index, arg);
		else if (arg === "--reasoning") result.reasoning = parseReasoning(requiredValue(args, ++index, arg));
		else if (arg === "--cwd") {
			result.cwd = path.resolve(requiredValue(args, ++index, arg));
			result.cwdSpecified = true;
		}
		else if (arg === "--permission") result.permission = parsePermission(requiredValue(args, ++index, arg));
		else if (arg === "--semantic-audit")
			result.semanticAuditMode = parseSemanticAuditMode(requiredValue(args, ++index, arg));
		else if (arg === "--require") result.requirements.push(requiredValue(args, ++index, arg));
		else if (arg === "--constraint") result.constraints.push(requiredValue(args, ++index, arg));
		else if (arg === "--verify-command") result.verificationCommands.push(requiredValue(args, ++index, arg));
		else if (arg === "--require-change") {
			if (result.requiresWorkspaceChange === false) throw new Error("--require-change conflicts with --allow-no-change.");
			result.requiresWorkspaceChange = true;
		} else if (arg === "--allow-no-change") {
			if (result.requiresWorkspaceChange === true) throw new Error("--allow-no-change conflicts with --require-change.");
			result.requiresWorkspaceChange = false;
		} else if (arg === "--max-tokens")
			result.budget.hardTokenLimit = positiveInteger(requiredValue(args, ++index, arg), arg);
		else if (arg === "--observe-after")
			result.budget.observeAfterTokens = positiveInteger(requiredValue(args, ++index, arg), arg);
		else if (arg === "--max-stalls")
			result.budget.maxStalledRounds = positiveInteger(requiredValue(args, ++index, arg), arg);
		else if (arg === "--endurance") result.enduranceHours = enduranceHours(requiredValue(args, ++index, arg));
		else if (arg === "--max-hours")
			result.budget.maxWallTimeMs = positiveInteger(requiredValue(args, ++index, arg), arg) * 60 * 60_000;
		else if (arg === "--max-rounds")
			result.budget.maxRounds = positiveInteger(requiredValue(args, ++index, arg), arg);
		else if (arg === "--max-tools")
			result.budget.maxToolCalls = positiveInteger(requiredValue(args, ++index, arg), arg);
		else if (arg === "--max-retries")
			result.budget.maxConsecutiveModelErrors = positiveInteger(requiredValue(args, ++index, arg), arg);
		else if (arg === "--round-timeout-minutes")
			result.budget.maxRoundTimeMs = positiveInteger(requiredValue(args, ++index, arg), arg) * 60_000;
		else if (arg === "--max-cost")
			result.budget.maxCostUsd = positiveNumber(requiredValue(args, ++index, arg), arg);
		else if (arg === "--detach") result.detach = true;
		else if (arg === "--allow-network") result.networkOverride = true;
		else if (arg === "--deny-network") result.networkOverride = false;
		else if (arg === "--allow-high-risk") result.allowHighRisk = true;
		else if (arg === "--quiet") result.quiet = true;
		else if (arg?.startsWith("--")) throw new Error(`Unknown option '${arg}'.`);
		else if (arg) result.positionals.push(arg);
	}
	result.requirements = result.requirements.map(item => item.trim()).filter(Boolean);
	result.constraints = result.constraints.map(item => item.trim()).filter(Boolean);
	result.verificationCommands = result.verificationCommands.map(item => item.trim()).filter(Boolean);
	if (result.enduranceHours) result.budget = { ...enduranceBudget(result.enduranceHours), ...result.budget };
	return result;
}

async function spawnDetachedResume(
	state: RunState,
	repository: RunRepository,
	options: { allowHighRisk: boolean },
): Promise<void> {
	await fs.mkdir(repository.runDirectory, { recursive: true });
	const logPath = path.join(repository.runDirectory, "runner.log");
	const log = await fs.open(logPath, "a", 0o600);
	const command = [process.execPath, path.resolve(import.meta.dir, "cli.ts"), "resume", state.id, "--quiet"];
	if (options.allowHighRisk) command.push("--allow-high-risk");
	let child: ReturnType<typeof Bun.spawn>;
	try {
		await repository.append(state, "run_detached", { logPath });
		await repository.save(state);
		child = Bun.spawn(command, {
			cwd: state.workspace,
			env: process.env,
			detached: true,
			stdin: "ignore",
			stdout: log.fd,
			stderr: log.fd,
		});
		child.unref();
	} finally {
		await log.close();
	}
	process.stdout.write(`${JSON.stringify({ runId: state.id, status: "detached", pid: child.pid, logPath }, null, 2)}\n`);
}

async function runWithProcessSignals(options: Parameters<typeof runHarness>[0]): Promise<RunState> {
	const controller = new AbortController();
	let signals = 0;
	const interrupt = (name: NodeJS.Signals): void => {
		signals += 1;
		if (signals > 1) {
			process.stderr.write(`second ${name}; exiting immediately\n`);
			process.exit(130);
		}
		process.stderr.write(`${name}; checkpointing and pausing run ${options.state.id}\n`);
		controller.abort(new Error(`Interrupted by ${name}.`));
	};
	const onInterrupt = (): void => interrupt("SIGINT");
	const onTerminate = (): void => interrupt("SIGTERM");
	process.on("SIGINT", onInterrupt);
	process.on("SIGTERM", onTerminate);
	try {
		return await runHarness({ ...options, signal: controller.signal });
	} finally {
		process.off("SIGINT", onInterrupt);
		process.off("SIGTERM", onTerminate);
	}
}

async function selectedModel(args: RunArguments): Promise<ModelSelection> {
	const config = await loadConfig();
	const model = args.model ?? looongtimeModel() ?? config.defaultModel;
	if (!model) throw new Error("No model selected. Pass --model provider/model-id or set LOOONGTIME_MODEL.");
	return parseModelSelection(model, args.reasoning ?? config.reasoning ?? "high");
}

async function readTask(positionals: string[]): Promise<string> {
	const task = positionals.join(" ").trim();
	if (task) return task;
	if (!process.stdin.isTTY) return (await Bun.stdin.text()).trim();
	throw new Error("A task is required.");
}

async function runNew(args: string[]): Promise<void> {
	const parsed = parseRunArguments(args);
	const config = await loadConfig();
	const state = createRunState({
		objective: await readTask(parsed.positionals),
		workspace: parsed.cwd,
		model: await selectedModel(parsed),
		...(parsed.auditModel
			? { auditModel: parseModelSelection(parsed.auditModel, parsed.reasoning ?? config.reasoning ?? "high") }
			: {}),
		permissionMode: parsed.permission ?? config.permissionMode ?? "autonomous",
		semanticAuditMode: parsed.semanticAuditMode ?? config.semanticAuditMode ?? "off",
		allowNetwork: parsed.networkOverride ?? false,
		...(parsed.requirements.length > 0 ? { requirements: parsed.requirements } : {}),
		...(parsed.constraints.length > 0 ? { constraints: parsed.constraints } : {}),
		...(parsed.verificationCommands.length > 0 ? { verificationCommands: parsed.verificationCommands } : {}),
		...(parsed.requiresWorkspaceChange !== undefined
			? { requiresWorkspaceChange: parsed.requiresWorkspaceChange }
			: {}),
		budget: parsed.budget,
	});
	const initialFingerprint = await (await Workspace.open(state.workspace)).fingerprint();
	state.baselineWorkspaceFingerprint = initialFingerprint;
	state.workspaceFingerprint = initialFingerprint;
	state.workspaceFingerprintAt = Date.now();
	const repository = new RunRepository(state.workspace, state.id);
	await repository.append(state, "run_created", {
		objective: state.contract.objective,
		workspace: state.workspace,
		model: state.model,
		permissionMode: state.permissionMode,
	});
	await repository.save(state);
	process.stderr.write(`run ${state.id}\n`);
	if (parsed.detach) {
		await spawnDetachedResume(state, repository, parsed);
		return;
	}
	const final = await runWithProcessSignals({
		state,
		repository,
		modelPort: new PiModelsPort(),
		tools: await createTools(state.workspace),
		observer: createTerminalObserver({ quiet: parsed.quiet, allowHighRisk: parsed.allowHighRisk }),
	});
	printRunSummary(final);
	if (final.status !== "completed") process.exitCode = final.status === "paused" ? 130 : 1;
}

async function resume(args: string[]): Promise<void> {
	const parsed = parseRunArguments(args);
	const runId = parsed.positionals.shift();
	if (!runId) throw new Error("resume requires a run id.");
	if (parsed.positionals.length > 0) throw new Error("resume accepts only one run id.");
	const repository = await RunRepository.find(runId);
	const state = await repository.load();
	if (state.status === "completed") throw new Error("Completed runs cannot be resumed.");
	if (parsed.cwdSpecified && parsed.cwd !== state.workspace) {
		throw new Error("A resumed run cannot move to a different locked workspace.");
	}
	if (parsed.requirements.length > 0 || parsed.constraints.length > 0 || parsed.verificationCommands.length > 0) {
		throw new Error("A resumed run cannot change its locked requirements, constraints, or verification commands.");
	}
	if (parsed.model || parsed.reasoning) {
		const current = `${state.model.provider}/${state.model.modelId}`;
		state.model = parseModelSelection(parsed.model ?? current, parsed.reasoning ?? state.model.reasoning);
	}
	if (parsed.auditModel) {
		state.auditModel = parseModelSelection(parsed.auditModel, parsed.reasoning ?? state.model.reasoning);
	}
	if (parsed.permission) state.permissionMode = parsed.permission;
	if (parsed.semanticAuditMode) state.semanticAuditMode = parsed.semanticAuditMode;
	if (
		parsed.requiresWorkspaceChange !== undefined &&
		parsed.requiresWorkspaceChange !== state.contract.requiresWorkspaceChange
	) {
		throw new Error("A resumed run cannot change its locked workspace-change requirement.");
	}
	if (parsed.networkOverride !== undefined) state.allowNetwork = parsed.networkOverride;
	applyBudgetOverrides(state, parsed.budget);
	state.status = "running";
	state.progress.stalledRounds = 0;
	if (parsed.detach) {
		await repository.save(state);
		await spawnDetachedResume(state, repository, parsed);
		return;
	}
	await repository.append(state, "run_resumed", {
		model: state.model,
		permissionMode: state.permissionMode,
		semanticAuditMode: state.semanticAuditMode,
		budget: state.budget,
	});
	await repository.save(state);
	const final = await runWithProcessSignals({
		state,
		repository,
		modelPort: new PiModelsPort(),
		tools: await createTools(state.workspace),
		observer: createTerminalObserver({ quiet: parsed.quiet, allowHighRisk: parsed.allowHighRisk }),
	});
	printRunSummary(final);
	if (final.status !== "completed") process.exitCode = final.status === "paused" ? 130 : 1;
}

async function showStatus(runId: string | undefined): Promise<void> {
	if (!runId) throw new Error("status requires a run id.");
	const repository = await RunRepository.find(runId);
	printRunSummary(await repository.load());
}

async function showEvents(runId: string | undefined): Promise<void> {
	if (!runId) throw new Error("events requires a run id.");
	const repository = await RunRepository.find(runId);
	for (const event of await repository.readEvents()) process.stdout.write(`${JSON.stringify(event)}\n`);
}

async function showModels(provider?: string): Promise<void> {
	const port = new PiModelsPort();
	if (!provider) {
		const counts = new Map<string, number>();
		for (const model of port.list()) counts.set(model.provider, (counts.get(model.provider) ?? 0) + 1);
		for (const [id, count] of [...counts].sort()) process.stdout.write(`${id}\t${count}\n`);
		return;
	}
	for (const model of port.list(provider)) {
		process.stdout.write(
			`${model.provider}/${model.id}\t${model.api}\tctx=${model.contextWindow}\treasoning=${String(model.reasoning)}\n`,
		);
	}
}

async function main(): Promise<void> {
	const [command, ...args] = process.argv.slice(2);
	if (!command && process.stdin.isTTY && process.stdout.isTTY) {
		const config = await loadConfig();
		const configured = looongtimeModel() ?? config.defaultModel;
		await runInteractive({
			workspace: process.cwd(),
			...(configured ? { model: parseModelSelection(configured, config.reasoning ?? "high") } : {}),
			permissionMode: config.permissionMode ?? "autonomous",
			semanticAuditMode: config.semanticAuditMode ?? "off",
			allowNetwork: false,
			modelPort: new PiModelsPort(),
		});
		return;
	}
	if (!command || command === "help" || command === "--help" || command === "-h") {
		process.stdout.write(HELP);
		return;
	}
	if (command === "chat") {
		const parsed = parseRunArguments(args);
		const config = await loadConfig();
		const modelValue = parsed.model ?? looongtimeModel() ?? config.defaultModel;
		await runInteractive({
			workspace: parsed.cwd,
			...(modelValue
				? { model: parseModelSelection(modelValue, parsed.reasoning ?? config.reasoning ?? "high") }
				: {}),
			permissionMode: parsed.permission ?? config.permissionMode ?? "autonomous",
			semanticAuditMode: parsed.semanticAuditMode ?? config.semanticAuditMode ?? "off",
			allowNetwork: parsed.networkOverride ?? false,
			modelPort: new PiModelsPort(),
		});
	} else if (command === "run") await runNew(args);
	else if (command === "resume") await resume(args);
	else if (command === "status") await showStatus(args[0]);
	else if (command === "events") await showEvents(args[0]);
	else if (command === "models") await showModels(args[0]);
	else if (command === "auth") await runAuthCommand(new PiModelsPort(), args);
	else throw new Error(`Unknown command '${command}'.\n\n${HELP}`);
}

await main().catch(error => {
	process.stderr.write(`looongtime: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
