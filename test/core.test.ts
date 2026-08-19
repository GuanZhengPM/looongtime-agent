import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { budgetPhase } from "../src/core/budget";
import { compileContext } from "../src/core/context";
import { runHarness } from "../src/core/harness";
import type { ModelDescriptor, ModelPort, ModelRoundRequest, ModelRoundResult } from "../src/core/model-port";
import { measureProgress, snapshotState } from "../src/core/progress";
import {
	assessAuditRisk,
	evidenceIsCurrent,
	recordMutation,
} from "../src/core/proof";
import { RunRepository } from "../src/core/repository";
import {
	addEvidence,
	applyStateReport,
	commitCompletion,
	compactRunState,
	createRunState,
	decideCompletion,
	applyBudgetOverrides,
	normalizeRunState,
	upsertArtifact,
} from "../src/core/state";
import { emptyUsage, type ModelSelection, type StateReport } from "../src/core/types";
import { createTools } from "../src/tools/registry";
import {
	classifyShellRisk,
	hashText,
	runShell,
	shellCommandInvocation,
	shellEvidenceKind,
	shellSandboxAvailable,
	Workspace,
} from "../src/tools/workspace";
import { FileCredentialStore } from "../src/providers/credential-store";
import { importCodexCliAuth } from "../src/providers/auth-cli";
import { PiModelsPort } from "../src/providers/pi-models";
import { longtimeHome, longtimeModel } from "../src/paths";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@earendil-works/pi-ai";

const temporaryDirectories: string[] = [];
const selection: ModelSelection = { provider: "faux", modelId: "coding", reasoning: "high" };
const originalLongtimeHome = process.env.LONGTIME_HOME;
const originalContinuumHome = process.env.CONTINUUM_HOME;
const originalLongtimeModel = process.env.LONGTIME_MODEL;
const originalContinuumModel = process.env.CONTINUUM_MODEL;

async function temporaryDirectory(prefix: string): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(item => fs.rm(item, { recursive: true, force: true })));
	if (originalLongtimeHome === undefined) delete process.env.LONGTIME_HOME;
	else process.env.LONGTIME_HOME = originalLongtimeHome;
	if (originalContinuumHome === undefined) delete process.env.CONTINUUM_HOME;
	else process.env.CONTINUUM_HOME = originalContinuumHome;
	if (originalLongtimeModel === undefined) delete process.env.LONGTIME_MODEL;
	else process.env.LONGTIME_MODEL = originalLongtimeModel;
	if (originalContinuumModel === undefined) delete process.env.CONTINUUM_MODEL;
	else process.env.CONTINUUM_MODEL = originalContinuumModel;
});

function report(overrides: Partial<StateReport> = {}): StateReport {
	return {
		status: "continue",
		summary: "continue",
		requirementIds: [],
		evidenceIds: [],
		nextFrontier: "next",
		unknowns: [],
		conflicts: [],
		resolvedUnknowns: [],
		resolvedConflictIds: [],
		...overrides,
	};
}

class ScriptedModel implements ModelPort {
	#rounds: Array<(request: ModelRoundRequest) => Promise<ModelRoundResult>>;
	calls = 0;

	constructor(rounds: Array<(request: ModelRoundRequest) => Promise<ModelRoundResult>>) {
		this.#rounds = rounds;
	}

	list(): ModelDescriptor[] {
		return [];
	}

	async assertAvailable(): Promise<void> {}

	async runRound(request: ModelRoundRequest): Promise<ModelRoundResult> {
		const round = this.#rounds[this.calls++];
		if (!round) return { output: "", usage: emptyUsage(), turns: 1 };
		return await round(request);
	}
}

describe("completion kernel", () => {
	test("rejects unsupported completion claims even when no files changed", () => {
		const state = createRunState({ objective: "inspect feature", workspace: process.cwd(), model: selection });
		const unsupported = report({ status: "complete", requirementIds: ["req-1"], nextFrontier: "done" });
		applyStateReport(state, unsupported);
		expect(decideCompletion(state, unsupported).complete).toBe(false);
		expect(decideCompletion(state, unsupported).reasons).toContain("The completion claim contains no host evidence.");
	});

	test("requires current post-mutation test or build evidence", () => {
		const state = createRunState({ objective: "implement feature", workspace: process.cwd(), model: selection });
		state.mutationEpoch = 1;
		const file = addEvidence(state, {
			kind: "file",
			source: "write",
			subject: "src/feature.ts",
			summary: "written",
			mutationEpoch: 1,
		});
		const staleTest = addEvidence(state, {
			kind: "test",
			source: "shell",
			subject: "bun test",
			summary: "passed before edit",
			mutationEpoch: 0,
		});
		const staleReport = report({
			status: "complete",
			requirementIds: ["req-1"],
			evidenceIds: [file.id, staleTest.id],
		});
		applyStateReport(state, staleReport);
		expect(decideCompletion(state, staleReport).complete).toBe(false);

		const currentTest = addEvidence(state, {
			kind: "test",
			source: "shell",
			subject: "bun test",
			summary: "passed after edit",
			mutationEpoch: 1,
		});
		const currentReport = report({
			status: "complete",
			requirementIds: ["req-1"],
			evidenceIds: [file.id, currentTest.id],
		});
		applyStateReport(state, currentReport);
		const decision = decideCompletion(state, currentReport);
		expect(decision.complete).toBe(true);
		expect(state.proof.claims.some(item => item.requirementId === "req-1" && item.status === "supported")).toBe(true);
		commitCompletion(state, currentReport, decision);
		expect(state.status).toBe("completed");
		expect(state.requirements[0]?.status).toBe("verified");
	});
});

describe("proof graph and adaptive audit routing", () => {
	test("invalidates only evidence and claims that depend on a changed path", () => {
		const state = createRunState({ objective: "prove two files", workspace: process.cwd(), model: selection });
		const first = addEvidence(state, {
			kind: "observation",
			source: "read_file",
			subject: "src/a.ts",
			summary: "read a",
			dependencyPaths: ["src/a.ts"],
		});
		const second = addEvidence(state, {
			kind: "observation",
			source: "read_file",
			subject: "src/b.ts",
			summary: "read b",
			dependencyPaths: ["src/b.ts"],
		});
		applyStateReport(
			state,
			report({
				claims: [
					{ requirementId: "req-1", statement: "a is correct", evidenceIds: [first.id] },
					{ requirementId: "req-1", statement: "b is correct", evidenceIds: [second.id] },
				],
			}),
		);
		const invalidation = recordMutation(state, ["src/a.ts"], "edited a");
		expect(invalidation.invalidatedEvidenceIds).toEqual([first.id]);
		expect(evidenceIsCurrent(state, first)).toBe(false);
		expect(evidenceIsCurrent(state, second)).toBe(true);
		expect(state.proof.claims.find(item => item.statement === "a is correct")?.status).toBe("stale");
		expect(state.proof.claims.find(item => item.statement === "b is correct")?.status).toBe("supported");
	});

	test("invalidates global verification evidence after any mutation", () => {
		const state = createRunState({ objective: "verify", workspace: process.cwd(), model: selection });
		const verification = addEvidence(state, {
			kind: "test",
			source: "verify",
			subject: "bun test",
			summary: "passed",
			globalScope: true,
		});
		recordMutation(state, ["README.md"], "edited docs");
		expect(evidenceIsCurrent(state, verification)).toBe(false);
	});

	test("routes deterministic gaps to verify and semantic risk to an auditor", () => {
		const state = createRunState({ objective: "complete safely", workspace: process.cwd(), model: selection });
		recordMutation(state, ["result.txt"], "created result");
		const file = addEvidence(state, {
			kind: "file",
			source: "write_file",
			subject: "result.txt",
			summary: "written",
			dependencyPaths: ["result.txt"],
		});
		const deterministicReport = report({
			status: "complete",
			requirementIds: ["req-1"],
			evidenceIds: [file.id],
			claims: [{ requirementId: "req-1", statement: "result exists", evidenceIds: [file.id], risk: "low" }],
		});
		applyStateReport(state, deterministicReport);
		expect(assessAuditRisk(state, deterministicReport).route).toBe("verify");

		const semanticReport = report({
			status: "complete",
			requirementIds: ["req-1"],
			evidenceIds: [file.id],
			claims: [{ requirementId: "req-1", statement: "the design looks professional", evidenceIds: [file.id], risk: "high" }],
		});
		applyStateReport(state, semanticReport);
		expect(assessAuditRisk(state, semanticReport).route).toBe("semantic_audit");
	});

	test("loads version-one states created before proof routing existed", () => {
		const state = createRunState({ objective: "resume", workspace: process.cwd(), model: selection });
		delete (state as Partial<typeof state>).proof;
		delete (state as Partial<typeof state>).audit;
		delete (state.progress.lastDelta as Partial<typeof state.progress.lastDelta>).supportedClaims;
		normalizeRunState(state);
		expect(state.proof.claims).toEqual([]);
		expect(state.audit.route).toBe("continue");
		expect(state.progress.lastDelta.supportedClaims).toBe(0);
	});
});

describe("progress and budget", () => {
	test("counts durable deltas and uses soft budget phases", () => {
		const state = createRunState({ objective: "task", workspace: process.cwd(), model: selection });
		const before = snapshotState(state);
		state.mutationEpoch = 1;
		addEvidence(state, {
			kind: "file",
			source: "write",
			subject: "x.ts",
			summary: "created",
		});
		const delta = measureProgress(before, snapshotState(state));
		expect(delta.score).toBeGreaterThan(0);
		expect(budgetPhase(state)).toBe("normal");
		state.usage.inputTokens = state.budget.observeAfterTokens;
		expect(budgetPhase(state)).toBe("observe");
		state.usage.inputTokens = state.budget.hardTokenLimit - state.budget.reserveTokens;
		expect(budgetPhase(state)).toBe("reserve");
	});

	test("applies endurance-sized resume overrides without invalid budget phases", () => {
		const state = createRunState({ objective: "task", workspace: process.cwd(), model: selection });
		applyBudgetOverrides(state, {
			hardTokenLimit: 500_000_000,
			observeAfterTokens: 400_000_000,
			maxWallTimeMs: 72 * 60 * 60_000,
			maxRounds: 12_000,
			maxToolCalls: 75_000,
		});
		expect(state.budget.hardTokenLimit).toBe(500_000_000);
		expect(state.budget.maxWallTimeMs).toBe(72 * 60 * 60_000);
		expect(budgetPhase(state)).toBe("normal");
	});
});

describe("permission policy", () => {
	test("separates routine checks from irreversible shell commands", () => {
		expect(classifyShellRisk("bun test")).toBe("low");
		expect(classifyShellRisk("git status --short")).toBe("low");
		expect(classifyShellRisk("bun install")).toBe("medium");
		expect(classifyShellRisk("git push origin main")).toBe("high");
		expect(classifyShellRisk("rm -rf src")).toBe("high");
	});

	test("does not mistake test filenames for executed tests", () => {
		expect(shellEvidenceKind("find lib -name '*test.go' -print")).toBe("command");
		expect(shellEvidenceKind("go test ./lib/srv -list '^Test'")).toBe("command");
		expect(shellEvidenceKind("python -m pytest --collect-only")).toBe("command");
		expect(shellEvidenceKind("cargo test --no-run")).toBe("command");
		expect(shellEvidenceKind('GOCACHE="$PWD/.cache" go test ./lib/utils/parse')).toBe("test");
		expect(shellEvidenceKind("go test ./first -list '^Test' && go test ./second")).toBe("test");
		expect(shellEvidenceKind("bun run check")).toBe("build");
		expect(shellEvidenceKind("make -C /app/sqlite sqlite3")).toBe("build");
		expect(shellEvidenceKind("cmake --build build --target app")).toBe("build");
	});

	test("uses a shell that exists on the target operating system", () => {
		expect(shellCommandInvocation("pwd", "darwin", () => null)).toEqual(["/bin/zsh", "-lc", "pwd"]);
		expect(shellCommandInvocation("pwd", "linux", name => (name === "bash" ? "/usr/bin/bash" : null))).toEqual([
			"/usr/bin/bash",
			"-lc",
			"pwd",
		]);
		expect(shellCommandInvocation("pwd", "linux", () => null)).toEqual(["/bin/sh", "-lc", "pwd"]);
	});

	test("ignores disposable build caches when detecting workspace mutations", async () => {
		const root = await temporaryDirectory("longtime-snapshot-caches-");
		await Promise.all(
			[".cache", ".gocache", ".gomodcache", ".pytest_cache", "node_modules"].map(directory =>
				fs.mkdir(path.join(root, directory), { recursive: true }),
			),
		);
		await Promise.all([
			Bun.write(path.join(root, ".gocache", "entry"), "generated"),
			Bun.write(path.join(root, ".pytest_cache", "entry"), "generated"),
			Bun.write(path.join(root, "coverage.gcda"), "generated"),
			Bun.write(path.join(root, "coverage.gcno"), "generated"),
			Bun.write(path.join(root, "source.ts"), "export {};\n"),
		]);
		const snapshot = await (await Workspace.open(root)).snapshot();
		expect([...snapshot.keys()]).toEqual(["source.ts"]);
	});

	test("creates explicit current verification evidence for nonstandard tasks", async () => {
		const workspace = await temporaryDirectory("longtime-explicit-verify-");
		const home = await temporaryDirectory("longtime-explicit-verify-home-");
		process.env.LONGTIME_HOME = home;
		await Bun.write(path.join(workspace, "result.json"), '{"score":1}\n');
		const state = createRunState({ objective: "produce result", workspace, model: selection });
		state.mutationEpoch = 1;
		const repository = new RunRepository(workspace, state.id);
		const verifyTool = (await createTools(workspace)).find(item => item.definition.name === "verify")!;
		const context = {
			state,
			repository,
			signal: new AbortController().signal,
			permissionMode: "autonomous" as const,
			authorize: async () => true,
		};
		const trivial = await verifyTool.execute(
			{ id: "trivial", name: "verify", arguments: { command: "true" } },
			context,
		);
		expect(trivial.isError).toBe(true);
		const verified = await verifyTool.execute(
			{ id: "verify", name: "verify", arguments: { command: "test -s result.json" } },
			context,
		);
		expect(verified.isError).toBe(false);
		expect(verified.evidence.some(item => item.kind === "test" && item.mutationEpoch === 1)).toBe(true);
	});

	test("rejects stale completion evidence during the report tool call", async () => {
		const workspace = await temporaryDirectory("longtime-report-evidence-");
		const home = await temporaryDirectory("longtime-report-evidence-home-");
		process.env.LONGTIME_HOME = home;
		const state = createRunState({ objective: "finish", workspace, model: selection });
		const stale = addEvidence(state, {
			kind: "observation",
			source: "read_file",
			subject: "before.ts",
			summary: "before mutation",
		});
		state.mutationEpoch = 1;
		const current = addEvidence(state, {
			kind: "test",
			source: "shell",
			subject: "bun test",
			summary: "passed",
		});
		const repository = new RunRepository(workspace, state.id);
		const reportTool = (await createTools(workspace)).find(item => item.definition.name === "report_state")!;
		const context = {
			state,
			repository,
			signal: new AbortController().signal,
			permissionMode: "autonomous" as const,
		};
		const argumentsBase = {
			status: "complete",
			summary: "done",
			requirementIds: ["req-1"],
			nextFrontier: "done",
			unknowns: [],
			conflicts: [],
		};
		const rejected = await reportTool.execute(
			{
				id: "stale-report",
				name: "report_state",
				arguments: { ...argumentsBase, evidenceIds: [stale.id, current.id] },
			},
			context,
		);
		expect(rejected.isError).toBe(true);
		expect(rejected.text).toContain(stale.id);
		const accepted = await reportTool.execute(
			{
				id: "current-report",
				name: "report_state",
				arguments: {
					...argumentsBase,
					evidenceIds: [current.id],
					claims: [
						{
							requirementId: "req-1",
							statement: "the current task is verified",
							evidenceIds: [current.id],
							dependencyPaths: ["result.json"],
							risk: "low",
						},
					],
				},
			},
			context,
		);
		expect(accepted.isError).toBe(false);
		expect(accepted.report?.status).toBe("complete");
		expect(accepted.report?.claims?.[0]?.statement).toBe("the current task is verified");
	});

	test("captures large shell output without retaining or returning the full stream", async () => {
		const workspace = await temporaryDirectory("longtime-shell-output-");
		const result = await runShell({
			command: `bun -e 'process.stdout.write("BEGIN\\n" + "x".repeat(120000) + "\\nEND\\n")'`,
			cwd: workspace,
			timeoutSeconds: 10,
			signal: new AbortController().signal,
			sandbox: false,
		});
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("BEGIN");
		expect(result.output).toContain("END");
		expect(result.output).toContain("omitted");
		expect(result.output.length).toBeLessThan(61_000);
	});

	test("terminates descendant processes when a shell command times out", async () => {
		const workspace = await temporaryDirectory("longtime-shell-timeout-");
		const pidFile = path.join(workspace, "child.pid");
		const result = await runShell({
			command: `sleep 30 & child=$!; printf '%s' "$child" > ${JSON.stringify(pidFile)}; wait "$child"`,
			cwd: workspace,
			timeoutSeconds: 0.2,
			signal: new AbortController().signal,
			sandbox: false,
		});
		expect(result.exitCode).not.toBe(0);
		const childPid = Number(await Bun.file(pidFile).text());
		expect(Number.isSafeInteger(childPid)).toBe(true);
		expect(() => process.kill(childPid, 0)).toThrow();
	});

	test("keeps sandboxed build caches outside the source workspace", async () => {
		const workspace = await temporaryDirectory("longtime-tool-cache-workspace-");
		const result = await runShell({
			command: 'printf "%s\\n%s\\n%s\\n" "$GOCACHE" "$GOMODCACHE" "$XDG_CACHE_HOME"',
			cwd: workspace,
			timeoutSeconds: 10,
			signal: new AbortController().signal,
			sandbox: false,
		});
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain(path.join(os.tmpdir(), "longtime-tool-cache"));
		expect(result.output).not.toContain(workspace);
	});

	test("returns read hashes that can be passed directly to snapshot-checked writes", async () => {
		const workspace = await temporaryDirectory("longtime-read-hash-");
		const home = await temporaryDirectory("longtime-read-hash-home-");
		process.env.LONGTIME_HOME = home;
		await Bun.write(path.join(workspace, "value.txt"), "before\n");
		const state = createRunState({ objective: "edit", workspace, model: selection });
		const repository = new RunRepository(workspace, state.id);
		const tools = await createTools(workspace);
		const read = tools.find(item => item.definition.name === "read_file")!;
		const write = tools.find(item => item.definition.name === "write_file")!;
		const context = {
			state,
			repository,
			signal: new AbortController().signal,
			permissionMode: "autonomous" as const,
		};
		const readResult = await read.execute({ id: "read", name: "read_file", arguments: { path: "value.txt" } }, context);
		const expectedHash = readResult.text.match(/\[hash:([a-f0-9]{64})\]/)?.[1];
		expect(expectedHash).toBe(hashText("before\n"));
		const writeResult = await write.execute(
			{ id: "write", name: "write_file", arguments: { path: "value.txt", content: "after\n", expectedHash } },
			context,
		);
		expect(writeResult.isError).toBe(false);
		expect(await Bun.file(path.join(workspace, "value.txt")).text()).toBe("after\n");
	});

	test("inherits an outer Codex sandbox instead of nesting sandbox-exec", async () => {
		const workspace = await temporaryDirectory("longtime-inherited-sandbox-");
		const previous = process.env.CODEX_SANDBOX;
		process.env.CODEX_SANDBOX = "seatbelt";
		try {
			expect(shellSandboxAvailable()).toBe(true);
			const result = await runShell({
				command: "printf inherited",
				cwd: workspace,
				timeoutSeconds: 10,
				signal: new AbortController().signal,
				sandbox: true,
			});
			expect(result.exitCode).toBe(0);
			expect(result.sandboxed).toBe(true);
			expect(result.output).toContain("inherited");
		} finally {
			if (previous === undefined) delete process.env.CODEX_SANDBOX;
			else process.env.CODEX_SANDBOX = previous;
		}
	});

	test("detects shell workspace mutations and invalidates earlier verification", async () => {
		const workspace = await temporaryDirectory("longtime-shell-mutation-");
		const home = await temporaryDirectory("longtime-shell-home-");
		process.env.LONGTIME_HOME = home;
		const state = createRunState({ objective: "write generated file", workspace, model: selection });
		const staleTest = addEvidence(state, {
			kind: "test",
			source: "shell",
			subject: "bun test",
			summary: "passed before shell edit",
			exitCode: 0,
		});
		const repository = new RunRepository(workspace, state.id);
		const shell = (await createTools(workspace)).find(item => item.definition.name === "shell");
		expect(shell).toBeDefined();
		const outcome = await shell!.execute(
			{ id: "shell-write", name: "shell", arguments: { command: "printf hello > generated.txt" } },
			{
				state,
				repository,
				signal: new AbortController().signal,
				permissionMode: "autonomous",
				authorize: async () => true,
			},
		);
		expect(outcome.isError).toBe(false);
		expect(state.mutationEpoch).toBe(1);
		const mutation = outcome.evidence.find(item => item.kind === "file");
		expect(mutation?.subject).toContain("generated.txt");
		const completion = report({
			status: "complete",
			requirementIds: ["req-1"],
			evidenceIds: [staleTest.id, mutation!.id],
			nextFrontier: "done",
		});
		applyStateReport(state, completion);
		expect(decideCompletion(state, completion).complete).toBe(false);
		expect(decideCompletion(state, completion).reasons).toContain(
			"The latest workspace mutation has no current test or build evidence.",
		);
	});
});

describe("credential isolation", () => {
	test("prefers Longtime configuration while accepting legacy Continuum environment aliases", async () => {
		const current = await temporaryDirectory("longtime-current-home-");
		const legacy = await temporaryDirectory("longtime-legacy-home-");
		process.env.LONGTIME_HOME = current;
		process.env.CONTINUUM_HOME = legacy;
		process.env.LONGTIME_MODEL = "openai/gpt-current";
		process.env.CONTINUUM_MODEL = "openai/gpt-legacy";
		expect(longtimeHome()).toBe(current);
		expect(longtimeModel()).toBe("openai/gpt-current");
		delete process.env.LONGTIME_HOME;
		delete process.env.LONGTIME_MODEL;
		expect(longtimeHome()).toBe(legacy);
		expect(longtimeModel()).toBe("openai/gpt-legacy");
	});

	test("persists provider credentials outside run events with owner-only permissions", async () => {
		const home = await temporaryDirectory("longtime-credentials-");
		process.env.LONGTIME_HOME = home;
		const store = new FileCredentialStore();
		await store.modify("example", async () => ({ type: "api_key", key: "test-secret" }));
		expect(await store.read("example")).toEqual({ type: "api_key", key: "test-secret" });
		expect(await store.list()).toEqual([{ providerId: "example", type: "api_key" }]);
		const stat = await fs.stat(path.join(home, "credentials.json"));
		expect(stat.mode & 0o777).toBe(0o600);
		await store.delete("example");
		expect(await store.read("example")).toBeUndefined();
	});

	test("imports an existing Codex CLI ChatGPT login without exposing tokens", async () => {
		const home = await temporaryDirectory("longtime-import-home-");
		const codexHome = await temporaryDirectory("longtime-codex-home-");
		const previousCodexHome = process.env.CODEX_HOME;
		process.env.LONGTIME_HOME = home;
		process.env.CODEX_HOME = codexHome;
		const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1_000) + 3_600 })).toString("base64url");
		await Bun.write(
			path.join(codexHome, "auth.json"),
			JSON.stringify({
				tokens: {
					access_token: `header.${payload}.signature`,
					refresh_token: "refresh-secret",
					account_id: "account",
				},
			}),
		);
		try {
			await importCodexCliAuth();
			const credential = await new FileCredentialStore().read("openai-codex");
			expect(credential?.type).toBe("oauth");
			expect(credential && "accountId" in credential ? credential.accountId : undefined).toBe("account");
		} finally {
			if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
			else process.env.CODEX_HOME = previousCodexHome;
		}
	});
});

describe("durable long-run state", () => {
	test("bounds hot state and compiled context while preserving recent artifacts", async () => {
		const state = createRunState({ objective: "large task", workspace: process.cwd(), model: selection });
		for (let index = 0; index < 2_500; index += 1) {
			addEvidence(state, {
				kind: "observation",
				source: "read_file",
				subject: `file-${index}.ts`,
				summary: "read",
			});
		}
		for (let index = 0; index < 150; index += 1) {
			upsertArtifact(state, {
				path: `src/file-${index}.ts`,
				contentHash: String(index).padStart(64, "0"),
				mutationEpoch: 0,
			});
		}
		compactRunState(state);
		expect(state.evidence).toHaveLength(2_000);
		const context = await compileContext(state);
		expect(context.userPrompt).toContain('"artifactCount": 150');
		expect(context.userPrompt).toContain("src/file-149.ts");
		expect(context.userPrompt).not.toContain("src/file-0.ts");
	});

	test("prevents two processes from owning the same run and recovers after release", async () => {
		const workspace = await temporaryDirectory("longtime-lease-workspace-");
		const home = await temporaryDirectory("longtime-lease-home-");
		process.env.LONGTIME_HOME = home;
		const state = createRunState({ objective: "lease", workspace, model: selection });
		const repository = new RunRepository(workspace, state.id);
		const first = await repository.acquireLease();
		await expect(repository.acquireLease()).rejects.toThrow(`Run is already active in process ${process.pid}.`);
		await first.release();
		const second = await repository.acquireLease();
		await second.release();
	});

	test("recovers a run lease left by a dead process", async () => {
		const workspace = await temporaryDirectory("longtime-dead-lease-workspace-");
		const home = await temporaryDirectory("longtime-dead-lease-home-");
		process.env.LONGTIME_HOME = home;
		const state = createRunState({ objective: "dead lease", workspace, model: selection });
		const repository = new RunRepository(workspace, state.id);
		await fs.mkdir(repository.runDirectory, { recursive: true });
		await Bun.write(
			repository.leasePath,
			JSON.stringify({ token: "dead", pid: 2_147_483_647, acquiredAt: 1, heartbeatAt: 1 }),
		);
		const lease = await repository.acquireLease();
		expect(await Bun.file(repository.leasePath).exists()).toBe(true);
		await lease.release();
		expect(await Bun.file(repository.leasePath).exists()).toBe(false);
	});

	test("reconciles event sequence after a crash and ignores only a truncated tail", async () => {
		const workspace = await temporaryDirectory("longtime-event-tail-workspace-");
		const home = await temporaryDirectory("longtime-event-tail-home-");
		process.env.LONGTIME_HOME = home;
		const state = createRunState({ objective: "events", workspace, model: selection });
		const repository = new RunRepository(workspace, state.id);
		await repository.save(state);
		await repository.append(state, "round_started", { round: 1 });
		await fs.appendFile(repository.eventsPath, '{"incomplete":');
		const loaded = await repository.load();
		expect(loaded.eventSequence).toBe(1);
		expect(await Bun.file(repository.eventsPath).text()).toEndWith("\n");
		expect(await repository.readEvents()).toHaveLength(1);
		await repository.append(loaded, "run_resumed", { repaired: true });
		const events = await repository.readEvents();
		expect(events.map(event => event.sequence)).toEqual([1, 2]);
	});
});

describe("pi-ai provider bridge", () => {
	test("exposes the pinned pi-ai authentication catalog without resolving secrets", () => {
		const providers = new PiModelsPort().listAuthProviders();
		const byId = new Map(providers.map(provider => [provider.id, provider]));
		expect(byId.get("openai-codex")?.oauth?.subscription).toBe(true);
		expect(byId.get("anthropic")?.apiKey?.interactive).toBe(true);
		expect(byId.get("anthropic")?.oauth?.subscription).toBe(true);
		expect(byId.get("kimi-coding")?.apiKey?.interactive).toBe(true);
		expect(byId.get("kimi-coding")?.oauth?.subscription).toBe(true);
		expect(byId.get("zai")?.apiKey?.interactive).toBe(true);
		expect(byId.get("zai")?.oauth).toBeUndefined();
		expect(byId.get("qwen-token-plan-cn")?.apiKey?.interactive).toBe(true);
	});

	test("streams a tool call through the neutral model port", async () => {
		const faux = fauxProvider({ provider: "faux-longtime", models: [{ id: "model" }] });
		const models = createModels();
		models.setProvider(faux.provider);
		let observedSessionId: string | undefined;
		let observedCacheRetention: string | undefined;
		faux.setResponses([
			(_context, options) => {
				observedSessionId = options?.sessionId;
				observedCacheRetention = options?.cacheRetention;
				return fauxAssistantMessage(
					fauxToolCall("report_state", {
						status: "continue",
						summary: "inspected",
						requirementIds: [],
						evidenceIds: [],
						nextFrontier: "edit",
						unknowns: [],
						conflicts: [],
					}),
					{ stopReason: "toolUse" },
				);
			},
		]);
		const port = new PiModelsPort(models);
		const result = await port.runRound({
			model: { provider: "faux-longtime", modelId: "model", reasoning: "low" },
			sessionId: "run-session",
			systemPrompt: "system",
			userPrompt: "task",
			tools: [
				{
					name: "report_state",
					description: "report",
					parameters: Type.Object({ status: Type.String() }),
				},
			],
			maxTurns: 2,
			maxOutputTokens: 1000,
			signal: new AbortController().signal,
			async executeTool(call) {
				return {
					text: "accepted",
					isError: false,
					report: report({ status: "continue", summary: String(call.arguments.summary), nextFrontier: "edit" }),
				};
			},
		});
		expect(result.report?.nextFrontier).toBe("edit");
		expect(result.turns).toBe(1);
		expect(faux.state.callCount).toBe(1);
		expect(observedSessionId).toBe("run-session");
		expect(observedCacheRetention).toBe("long");
	});

	test("nudges once for report_state when the model returns prose only", async () => {
		const faux = fauxProvider({ provider: "faux-report", models: [{ id: "model" }] });
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses([
			fauxAssistantMessage("implementation finished"),
			fauxAssistantMessage(
				fauxToolCall("report_state", {
					status: "continue",
					summary: "reported after reminder",
					requirementIds: [],
					evidenceIds: [],
					nextFrontier: "verify",
					unknowns: [],
					conflicts: [],
				}),
				{ stopReason: "toolUse" },
			),
		]);
		const port = new PiModelsPort(models);
		const result = await port.runRound({
			model: { provider: "faux-report", modelId: "model", reasoning: "low" },
			systemPrompt: "system",
			userPrompt: "task",
			tools: [{ name: "report_state", description: "report", parameters: Type.Object({}) }],
			maxTurns: 3,
			maxOutputTokens: 1_000,
			signal: new AbortController().signal,
			async executeTool() {
				return { text: "accepted", isError: false, report: report({ summary: "reported", nextFrontier: "verify" }) };
			},
		});
		expect(result.report?.nextFrontier).toBe("verify");
		expect(faux.state.callCount).toBe(2);
	});

	test("does not spend the completion budget on large cached tool-loop input", async () => {
		const faux = fauxProvider({
			provider: "faux-large-context",
			models: [{ id: "model", contextWindow: 128_000, maxTokens: 8_000 }],
		});
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("read_file", { path: "large.go" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(
				fauxToolCall("report_state", {
					status: "continue",
					summary: "inspection preserved",
					requirementIds: [],
					evidenceIds: ["ev-read"],
					nextFrontier: "implement",
					unknowns: [],
					conflicts: [],
				}),
				{ stopReason: "toolUse" },
			),
		]);
		const port = new PiModelsPort(models);
		const result = await port.runRound({
			model: { provider: "faux-large-context", modelId: "model", reasoning: "low" },
			sessionId: "large-context-run",
			systemPrompt: "large stable prefix ".repeat(1_000),
			userPrompt: "inspect and continue",
			tools: [
				{ name: "read_file", description: "read", parameters: Type.Object({ path: Type.String() }) },
				{ name: "report_state", description: "report", parameters: Type.Object({}) },
			],
			maxTurns: 3,
			maxOutputTokens: 100,
			signal: new AbortController().signal,
			async executeTool(call) {
				if (call.name === "read_file") return { text: "contents", isError: false };
				return {
					text: "accepted",
					isError: false,
					report: report({
						summary: String(call.arguments.summary),
						nextFrontier: String(call.arguments.nextFrontier),
					}),
				};
			},
		});
		expect(result.report?.nextFrontier).toBe("implement");
		expect(result.turns).toBe(2);
		expect(faux.state.callCount).toBe(2);
		expect(result.usage.inputTokens + result.usage.cacheReadTokens).toBeGreaterThan(100);
	});

	test("reserves the final model turn for a durable state handoff", async () => {
		const faux = fauxProvider({ provider: "faux-final-handoff", models: [{ id: "model" }] });
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("read_file", { path: "one.go" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("read_file", { path: "two.go" }), { stopReason: "toolUse" }),
			context => {
				expect(context.tools?.map(tool => tool.name)).toEqual(["report_state"]);
				return fauxAssistantMessage(
					fauxToolCall("report_state", {
						status: "continue",
						summary: "handoff preserved",
						requirementIds: [],
						evidenceIds: ["ev-one", "ev-two"],
						nextFrontier: "write implementation",
						unknowns: [],
						conflicts: [],
					}),
					{ stopReason: "toolUse" },
				);
			},
		]);
		const port = new PiModelsPort(models);
		const result = await port.runRound({
			model: { provider: "faux-final-handoff", modelId: "model", reasoning: "low" },
			systemPrompt: "system",
			userPrompt: "inspect",
			tools: [
				{ name: "read_file", description: "read", parameters: Type.Object({ path: Type.String() }) },
				{ name: "report_state", description: "report", parameters: Type.Object({}) },
			],
			maxTurns: 3,
			maxOutputTokens: 1_000,
			signal: new AbortController().signal,
			async executeTool(call) {
				if (call.name === "read_file") return { text: "contents", isError: false };
				return {
					text: "accepted",
					isError: false,
					report: report({ summary: "handoff preserved", nextFrontier: "write implementation" }),
				};
			},
		});
		expect(result.report?.nextFrontier).toBe("write implementation");
		expect(result.turns).toBe(3);
		expect(faux.state.callCount).toBe(3);
	});
});

describe("long-running harness", () => {
	test("returns a stable not-found error when no run store exists", async () => {
		const home = await temporaryDirectory("longtime-empty-home-");
		process.env.LONGTIME_HOME = home;
		await expect(RunRepository.find("missing-run")).rejects.toThrow("Run 'missing-run' was not found.");
	});

	test("continues across productive rounds and commits only after current verification", async () => {
		const workspace = await temporaryDirectory("longtime-workspace-");
		const home = await temporaryDirectory("longtime-home-");
		process.env.LONGTIME_HOME = home;
		await Bun.write(
			path.join(workspace, "smoke.test.ts"),
			'import { expect, test } from "bun:test"; test("smoke", () => expect(1).toBe(1));',
		);
		let writeEvidence = "";
		const model = new ScriptedModel([
			async request => {
				const result = await request.executeTool({
					id: "write-1",
					name: "write_file",
					arguments: { path: "src/result.ts", content: "export const result = 1;\n" },
				});
				writeEvidence = result.text.match(/\[evidence:(ev-[^\]]+)\]/)?.[1] ?? "";
				return {
					output: "implemented",
					report: report({
						summary: "implementation written",
						evidenceIds: [writeEvidence],
						nextFrontier: "run verification",
					}),
					usage: emptyUsage(),
					turns: 1,
				};
			},
			async request => {
				const result = await request.executeTool({
					id: "test-1",
					name: "shell",
					arguments: { command: "bun test smoke.test.ts" },
				});
				const testEvidence = result.text.match(/\[evidence:(ev-[^\]]+)\]/)?.[1] ?? "";
				return {
					output: "verified",
					report: report({
						status: "complete",
						summary: "implementation and smoke test complete",
						requirementIds: ["req-1"],
						evidenceIds: [writeEvidence, testEvidence],
						nextFrontier: "done",
					}),
					usage: emptyUsage(),
					turns: 1,
				};
			},
		]);
		const state = createRunState({ objective: "implement result", workspace, model: selection });
		const repository = new RunRepository(workspace, state.id);
		await repository.save(state);
		const final = await runHarness({
			state,
			repository,
			modelPort: model,
			tools: await createTools(workspace),
		});
		expect(final.status).toBe("completed");
		expect(final.round).toBe(2);
		expect(model.calls).toBe(2);
		expect((await repository.readEvents()).some(event => event.type === "run_completed")).toBe(true);
	});

	test("blocks only after the configured number of no-progress rounds", async () => {
		const workspace = await temporaryDirectory("longtime-stall-workspace-");
		const home = await temporaryDirectory("longtime-stall-home-");
		process.env.LONGTIME_HOME = home;
		const model = new ScriptedModel([]);
		const state = createRunState({
			objective: "impossible task",
			workspace,
			model: selection,
			budget: { maxStalledRounds: 3 },
		});
		const repository = new RunRepository(workspace, state.id);
		await repository.save(state);
		const final = await runHarness({
			state,
			repository,
			modelPort: model,
			tools: await createTools(workspace),
		});
		expect(final.status).toBe("blocked");
		expect(final.round).toBe(3);
		expect(final.recoveryGuidance).toContain("No trusted state delta");
	});

	test("preserves actionable completion-rejection guidance for out-of-scope unknowns", async () => {
		const workspace = await temporaryDirectory("longtime-unknown-guidance-workspace-");
		const home = await temporaryDirectory("longtime-unknown-guidance-home-");
		process.env.LONGTIME_HOME = home;
		const model = new ScriptedModel([
			async request => {
				const inspected = await request.executeTool({ id: "list", name: "list_files", arguments: {} });
				const evidenceId = inspected.text.match(/\[evidence:(ev-[^\]]+)\]/)?.[1] ?? "";
				return {
					output: "inspection complete",
					report: report({
						status: "complete",
						requirementIds: ["req-1"],
						evidenceIds: [evidenceId],
						unknowns: ["A future implementation language is unspecified."],
					}),
					usage: emptyUsage(),
					turns: 1,
				};
			},
		]);
		const state = createRunState({
			objective: "inspect only",
			workspace,
			model: selection,
			budget: { maxStalledRounds: 1 },
		});
		const repository = new RunRepository(workspace, state.id);
		await repository.save(state);
		const final = await runHarness({ state, repository, modelPort: model, tools: await createTools(workspace) });
		expect(final.status).toBe("blocked");
		expect(final.recoveryGuidance).toContain("include its exact string in resolvedUnknowns");
		expect(final.recoveryGuidance).toContain("No trusted state delta");
	});

	test("retries transient model failures with durable health events", async () => {
		const workspace = await temporaryDirectory("longtime-retry-workspace-");
		const home = await temporaryDirectory("longtime-retry-home-");
		process.env.LONGTIME_HOME = home;
		const model = new ScriptedModel([
			async () => {
				throw new Error("503 upstream temporarily unavailable");
			},
			async () => ({ output: "", report: report(), usage: emptyUsage(), turns: 1 }),
		]);
		const state = createRunState({
			objective: "retry",
			workspace,
			model: selection,
			budget: { maxStalledRounds: 1, modelRetryBaseDelayMs: 1, modelRetryMaxDelayMs: 1 },
		});
		const repository = new RunRepository(workspace, state.id);
		await repository.save(state);
		const delays: number[] = [];
		const final = await runHarness({
			state,
			repository,
			modelPort: model,
			tools: await createTools(workspace),
			retryDelay: async milliseconds => {
				delays.push(milliseconds);
			},
		});
		const events = await repository.readEvents();
		expect(final.status).toBe("blocked");
		expect(final.health.totalModelErrors).toBe(1);
		expect(final.health.consecutiveModelErrors).toBe(0);
		expect(model.calls).toBe(2);
		expect(delays).toEqual([1]);
		expect(events.some(event => event.type === "model_retry_scheduled")).toBe(true);
	});

	test("fails fast on deterministic authentication errors", async () => {
		const workspace = await temporaryDirectory("longtime-auth-failure-workspace-");
		const home = await temporaryDirectory("longtime-auth-failure-home-");
		process.env.LONGTIME_HOME = home;
		const model = new ScriptedModel([
			async () => {
				throw new Error("401 invalid bearer token");
			},
		]);
		const state = createRunState({ objective: "auth", workspace, model: selection });
		const repository = new RunRepository(workspace, state.id);
		await repository.save(state);
		await expect(
			runHarness({ state, repository, modelPort: model, tools: await createTools(workspace) }),
		).rejects.toThrow("401 invalid bearer token");
		const events = await repository.readEvents();
		expect(state.status).toBe("failed");
		expect(model.calls).toBe(1);
		expect(events.some(event => event.type === "model_retry_scheduled")).toBe(false);
		expect(await Bun.file(repository.leasePath).exists()).toBe(false);
	});

	test("checkpoints an interrupted one-shot run as paused instead of failed", async () => {
		const workspace = await temporaryDirectory("longtime-pause-workspace-");
		const home = await temporaryDirectory("longtime-pause-home-");
		process.env.LONGTIME_HOME = home;
		const controller = new AbortController();
		const model = new ScriptedModel([
			async request => {
				await request.onUsage?.({
					...emptyUsage(),
					inputTokens: 123,
					outputTokens: 45,
					cacheReadTokens: 67,
					reasoningTokens: 20,
				});
				await new Promise<void>((resolve, reject) => {
					const onAbort = (): void => reject(request.signal.reason ?? new Error("aborted"));
					request.signal.addEventListener("abort", onAbort, { once: true });
				});
				return { output: "", usage: emptyUsage(), turns: 1 };
			},
		]);
		const state = createRunState({ objective: "pause", workspace, model: selection });
		const repository = new RunRepository(workspace, state.id);
		await repository.save(state);
		setTimeout(() => controller.abort(new Error("test interrupt")), 10);
		const final = await runHarness({
			state,
			repository,
			modelPort: model,
			tools: await createTools(workspace),
			signal: controller.signal,
		});
		const events = await repository.readEvents();
		expect(final.status).toBe("paused");
		expect(final.usage.inputTokens).toBe(123);
		expect(final.usage.outputTokens).toBe(45);
		expect(final.usage.cacheReadTokens).toBe(67);
		expect(final.usage.reasoningTokens).toBe(20);
		expect((await repository.load()).status).toBe("paused");
		expect((await repository.load()).usage.inputTokens).toBe(123);
		expect(events.some(event => event.type === "model_usage_recorded")).toBe(true);
		expect(events.some(event => event.type === "run_paused")).toBe(true);
		expect(events.some(event => event.type === "run_failed")).toBe(false);
	});

	test("cuts off identical tool-call loops inside a model round", async () => {
		const workspace = await temporaryDirectory("longtime-repeat-workspace-");
		const home = await temporaryDirectory("longtime-repeat-home-");
		process.env.LONGTIME_HOME = home;
		const model = new ScriptedModel([
			async request => {
				let last: Awaited<ReturnType<ModelRoundRequest["executeTool"]>> | undefined;
				for (let index = 0; index < 3; index += 1) {
					last = await request.executeTool({ id: `list-${index}`, name: "list_files", arguments: { pattern: "**/*" } });
				}
				return { output: "", ...(last?.report ? { report: last.report } : {}), usage: emptyUsage(), turns: 3 };
			},
		]);
		const state = createRunState({
			objective: "inspect",
			workspace,
			model: selection,
			budget: { maxStalledRounds: 1 },
		});
		const repository = new RunRepository(workspace, state.id);
		await repository.save(state);
		const final = await runHarness({ state, repository, modelPort: model, tools: await createTools(workspace) });
		const events = await repository.readEvents();
		expect(final.status).toBe("blocked");
		expect(events.filter(event => event.type === "evidence_recorded")).toHaveLength(2);
		expect(events.some(event => event.type === "tool_completed" && event.payload.repeated === true)).toBe(true);
	});
});

describe("minimal shadow semantic auditor", () => {
	test("uses the same model in a fresh read-only snapshot without blocking completion", async () => {
		const workspace = await temporaryDirectory("longtime-semantic-audit-workspace-");
		const home = await temporaryDirectory("longtime-semantic-audit-home-");
		process.env.LONGTIME_HOME = home;
		await Bun.write(path.join(workspace, "README.md"), "This guide assumes expert knowledge.\n");
		const model = new ScriptedModel([
			async request => {
				const inspected = await request.executeTool({ id: "read", name: "read_file", arguments: { path: "README.md" } });
				const evidenceId = inspected.text.match(/\[evidence:(ev-[^\]]+)\]/)?.[1] ?? "";
				return {
					output: "complete",
					report: report({
						status: "complete",
						summary: "The guide is suitable for beginners.",
						requirementIds: ["req-1"],
						evidenceIds: [evidenceId],
						claims: [
							{
								requirementId: "req-1",
								statement: "The guide is suitable for beginners.",
								evidenceIds: [evidenceId],
								dependencyPaths: ["README.md"],
								risk: "high",
							},
						],
						nextFrontier: "done",
					}),
					usage: emptyUsage(),
					turns: 1,
				};
			},
			async request => {
				expect(request.sessionId).toContain(":semantic-audit:");
				expect(request.tools.some(tool => tool.name === "write_file" || tool.name === "shell")).toBe(false);
				const read = await request.executeTool({ id: "audit-read", name: "audit_read_file", arguments: { path: "README.md" } });
				if (read.isError) throw new Error(read.text);
				const auditEvidenceId = read.text.match(/\[audit-evidence:(audit-ev-[^\]]+)\]/)?.[1] ?? "";
				await request.executeTool({
					id: "submit",
					name: "submit_semantic_audit",
					arguments: {
						verdict: "reject",
						criterionResults: [
							{
								criterionId: "criterion-req-1",
								status: "fail",
								reason: "The guide explicitly assumes expert knowledge.",
								evidenceIds: [auditEvidenceId],
							},
						],
						contractDrift: [],
						missingEvidence: [],
						confidence: 0.95,
					},
				});
				return { output: "audit submitted", usage: emptyUsage(), turns: 1 };
			},
		]);
		const state = createRunState({
			objective: "Write a beginner-friendly guide",
			workspace,
			model: selection,
			semanticAuditMode: "shadow",
		});
		const repository = new RunRepository(workspace, state.id);
		await repository.save(state);
		const final = await runHarness({ state, repository, modelPort: model, tools: await createTools(workspace) });
		const events = await repository.readEvents();
		expect(final.status).toBe("completed");
		expect(final.audit.route).toBe("semantic_audit");
		expect(final.semanticAudits).toHaveLength(1);
		if (final.semanticAudits[0]?.status === "failed") throw new Error(final.semanticAudits[0].error);
		expect(final.semanticAudits[0]?.verdict).toBe("reject");
		expect(final.semanticAudits[0]?.snapshotFileCount).toBe(1);
		expect(final.semanticAudits[0]?.evidence).toHaveLength(1);
		expect(model.calls).toBe(2);
		expect(events.some(event => event.type === "semantic_audit_started")).toBe(true);
		expect(events.some(event => event.type === "semantic_audit_completed")).toBe(true);
	});
});
