import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Type, validateToolCall, type Tool, type ToolCall } from "@earendil-works/pi-ai";
import type { ModelToolCall } from "../core/model-port";
import { addEvidence, upsertArtifact } from "../core/state";
import { evidenceIsCurrent, recordMutation } from "../core/proof";
import type { ClaimRisk, ClaimSubmission, FactSubmission, StateReport } from "../core/types";
import { validateRelativeGlob } from "../path-policy";
import { compileSearchRegex } from "../regex-policy";
import {
	assertVerificationCommandSafe,
	evidenceVerifiesRequirement,
	verificationCommandHash,
	verificationKindFor,
} from "../core/verification";
import type { ExecutableTool, ToolExecutionContext, ToolOutcome } from "./types";
import {
	classifyShellRisk,
	hashText,
	runShell,
	shellSandboxAvailable,
	Workspace,
} from "./workspace";

const MAX_TEXT_FILE_BYTES = 20 * 1024 * 1024;
const MAX_SEARCH_BYTES = 100 * 1024 * 1024;
const MAX_TOOL_RESPONSE_CHARACTERS = 120_000;
const MAX_WRITE_CHARACTERS = 5_000_000;

function boundedToolText(value: string): string {
	if (value.length <= MAX_TOOL_RESPONSE_CHARACTERS) return value;
	const half = Math.floor((MAX_TOOL_RESPONSE_CHARACTERS - 100) / 2);
	return `${value.slice(0, half)}\n… ${value.length - half * 2} characters omitted …\n${value.slice(-half)}`;
}

async function atomicWriteWorkspaceFile(file: string, content: string, mode?: number): Promise<void> {
	const directory = path.dirname(file);
	await fs.mkdir(directory, { recursive: true });
	const temporary = path.join(directory, `.${path.basename(file)}.${crypto.randomUUID()}.longtime-tmp`);
	const handle = await fs.open(temporary, "wx", mode ?? 0o666);
	let renamed = false;
	try {
		try {
			await handle.writeFile(content, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		if (mode !== undefined) await fs.chmod(temporary, mode);
		await fs.rename(temporary, file);
		renamed = true;
	} finally {
		if (!renamed) await fs.unlink(temporary).catch(() => {});
	}
}

function success(text: string, evidence: ToolOutcome["evidence"] = [], report?: StateReport): ToolOutcome {
	return { text, isError: false, evidence, ...(report ? { report } : {}) };
}

function failure(error: unknown): ToolOutcome {
	return {
		text: `Error: ${error instanceof Error ? error.message : String(error)}`,
		isError: true,
		evidence: [],
	};
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function validate(definition: Tool, call: ModelToolCall): unknown {
	const providerCall: ToolCall = {
		type: "toolCall",
		id: call.id,
		name: call.name,
		arguments: call.arguments,
	};
	return validateToolCall([definition], providerCall);
}

export async function createTools(root: string): Promise<ExecutableTool[]> {
	const workspace = await Workspace.open(root);
	const readFile: ExecutableTool = {
		definition: {
			name: "read_file",
			description: "Read a UTF-8 file inside the workspace with numbered lines and return its full-file content hash.",
			parameters: Type.Object({
				path: Type.String({ minLength: 1, maxLength: 1_000 }),
				offset: Type.Optional(Type.Number({ minimum: 1 })),
				limit: Type.Optional(Type.Number({ minimum: 1, maximum: 2000 })),
			}),
		},
		async execute(call, context) {
			try {
				context.signal.throwIfAborted();
				const args = validate(this.definition, call) as { path: string; offset?: number; limit?: number };
				const file = await workspace.resolveExisting(args.path);
				const stat = await fs.stat(file);
				if (!stat.isFile()) throw new Error("read_file requires a regular file.");
				if (stat.size > MAX_TEXT_FILE_BYTES) {
					throw new Error(`File exceeds the ${MAX_TEXT_FILE_BYTES}-byte text-read limit.`);
				}
				const text = await Bun.file(file).text();
				const lines = text.split("\n");
				const offset = Math.floor(args.offset ?? 1);
				const limit = Math.floor(args.limit ?? 300);
				const body = lines
					.slice(offset - 1, offset - 1 + limit)
					.map((line, index) => `${offset + index}:${line.slice(0, 4_000)}`)
					.join("\n");
				const evidence = addEvidence(context.state, {
					kind: "observation",
					source: "read_file",
					subject: workspace.relative(file),
					summary: `Read lines ${offset}-${Math.min(lines.length, offset + limit - 1)} of ${workspace.relative(file)}`,
					contentHash: hashText(text),
					dependencyPaths: [workspace.relative(file)],
				});
				return success(`${boundedToolText(body)}\n[hash:${evidence.contentHash}]\n[evidence:${evidence.id}]`, [evidence]);
			} catch (error) {
				return failure(error);
			}
		},
	};

	const listFiles: ExecutableTool = {
		definition: {
			name: "list_files",
			description: "List workspace files matching a glob. node_modules, .git, .longtime, and .continuum are excluded.",
			parameters: Type.Object({
				pattern: Type.Optional(Type.String({ maxLength: 1_000 })),
				limit: Type.Optional(Type.Number({ minimum: 1, maximum: 5000 })),
			}),
		},
		async execute(call, context) {
			try {
				const args = validate(this.definition, call) as { pattern?: string; limit?: number };
				const pattern = validateRelativeGlob(args.pattern ?? "**/*");
				const files: string[] = [];
				let skippedUnsafePaths = 0;
				for await (const file of new Bun.Glob(pattern).scan({
					cwd: workspace.root,
					dot: true,
					onlyFiles: true,
				})) {
					context.signal.throwIfAborted();
					let relative: string;
					try {
						relative = workspace.relative(await workspace.resolveExisting(file));
					} catch {
						skippedUnsafePaths += 1;
						continue;
					}
					if (
						relative.startsWith(".git/") ||
						relative.startsWith("node_modules/") ||
						relative.startsWith(".longtime/") ||
						relative.startsWith(".continuum/")
					)
						continue;
					files.push(relative);
					if (files.length >= (args.limit ?? 500)) break;
				}
				files.sort();
				const evidence = addEvidence(context.state, {
					kind: "observation",
					source: "list_files",
					subject: pattern,
					summary: `Listed ${files.length} workspace files; skipped ${skippedUnsafePaths} unsafe paths`,
					globalScope: true,
				});
				return success(`${boundedToolText(files.join("\n") || "No files.")}\n[evidence:${evidence.id}]`, [evidence]);
			} catch (error) {
				return failure(error);
			}
		},
	};

	const search: ExecutableTool = {
		definition: {
			name: "search",
			description: "Search UTF-8 workspace files using a JavaScript regular expression.",
			parameters: Type.Object({
				pattern: Type.String({ minLength: 1, maxLength: 2_000 }),
				files: Type.Optional(Type.String({ maxLength: 1_000 })),
				caseSensitive: Type.Optional(Type.Boolean()),
				limit: Type.Optional(Type.Number({ minimum: 1, maximum: 2000 })),
			}),
		},
		async execute(call, context) {
			try {
				const args = validate(this.definition, call) as {
					pattern: string;
					files?: string;
					caseSensitive?: boolean;
					limit?: number;
				};
				const expression = compileSearchRegex(args.pattern, args.caseSensitive === false ? "i" : "");
				const filesPattern = validateRelativeGlob(args.files ?? "**/*");
				const matches: string[] = [];
				let skippedUnsafePaths = 0;
				let skippedLargePaths = 0;
				let scannedBytes = 0;
				for await (const file of new Bun.Glob(filesPattern).scan({
					cwd: workspace.root,
					dot: true,
					onlyFiles: true,
				})) {
					context.signal.throwIfAborted();
					let absolute: string;
					let relative: string;
					try {
						absolute = await workspace.resolveExisting(file);
						relative = workspace.relative(absolute);
					} catch {
						skippedUnsafePaths += 1;
						continue;
					}
					if (
						relative.startsWith(".git/") ||
						relative.startsWith("node_modules/") ||
						relative.startsWith(".longtime/") ||
						relative.startsWith(".continuum/")
					)
						continue;
					let stat: import("node:fs").Stats;
					try {
						stat = await fs.stat(absolute);
					} catch {
						continue;
					}
					if (!stat.isFile() || stat.size > MAX_TEXT_FILE_BYTES || scannedBytes + stat.size > MAX_SEARCH_BYTES) {
						skippedLargePaths += 1;
						continue;
					}
					scannedBytes += stat.size;
					let text: string;
					try {
						text = await Bun.file(absolute).text();
					} catch {
						continue;
					}
					for (const [index, line] of text.split("\n").entries()) {
						if (index % 1_000 === 0) context.signal.throwIfAborted();
						if (!expression.test(line)) continue;
						matches.push(`${relative}:${index + 1}:${line.slice(0, 2000)}`);
						if (matches.length >= (args.limit ?? 300)) break;
					}
					if (matches.length >= (args.limit ?? 300)) break;
				}
				const evidence = addEvidence(context.state, {
					kind: "observation",
					source: "search",
					subject: args.pattern,
					summary: `Found ${matches.length} matching lines; skipped ${skippedUnsafePaths} unsafe paths and ${skippedLargePaths} over-limit paths`,
					globalScope: true,
				});
				return success(`${boundedToolText(matches.join("\n") || "No matches.")}\n[evidence:${evidence.id}]`, [evidence]);
			} catch (error) {
				return failure(error);
			}
		},
	};

	const writeFile: ExecutableTool = {
		definition: {
			name: "write_file",
			description: "Create or replace a UTF-8 workspace file. Supply expectedHash when replacing a file read earlier.",
			parameters: Type.Object({
				path: Type.String({ minLength: 1, maxLength: 1_000 }),
				content: Type.String({ maxLength: MAX_WRITE_CHARACTERS }),
				expectedHash: Type.Optional(Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" })),
			}),
		},
		async execute(call, context) {
			try {
				const args = validate(this.definition, call) as {
					path: string;
					content: string;
					expectedHash?: string;
				};
				const file = await workspace.resolveWritable(args.path);
				let mode: number | undefined;
				try {
					const current = await Bun.file(file).text();
					if (!args.expectedHash) throw new Error("Replacing a file requires expectedHash from a previous read.");
					if (hashText(current) !== args.expectedHash) throw new Error("File changed since it was read; re-read before writing.");
					mode = (await fs.stat(file)).mode & 0o777;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
				const relative = workspace.relative(file);
				context.signal.throwIfAborted();
				await atomicWriteWorkspaceFile(file, args.content, mode);
				recordMutation(context.state, [relative], `write_file changed ${relative}`);
				const contentHash = hashText(args.content);
				upsertArtifact(context.state, { path: relative, contentHash, mutationEpoch: context.state.mutationEpoch });
				const evidence = addEvidence(context.state, {
					kind: "file",
					source: "write_file",
					subject: relative,
					summary: `Wrote ${args.content.length} characters`,
					contentHash,
					dependencyPaths: [relative],
				});
				return success(`Wrote ${relative}.\n[hash:${contentHash}]\n[evidence:${evidence.id}]`, [evidence]);
			} catch (error) {
				return failure(error);
			}
		},
	};

	const replaceInFile: ExecutableTool = {
		definition: {
			name: "replace_in_file",
			description: "Replace one unique text occurrence in a workspace file using an expected content hash.",
			parameters: Type.Object({
				path: Type.String({ minLength: 1, maxLength: 1_000 }),
				expectedHash: Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" }),
				oldText: Type.String({ minLength: 1, maxLength: MAX_WRITE_CHARACTERS }),
				newText: Type.String({ maxLength: MAX_WRITE_CHARACTERS }),
			}),
		},
		async execute(call, context) {
			try {
				const args = validate(this.definition, call) as {
					path: string;
					expectedHash: string;
					oldText: string;
					newText: string;
				};
				const file = await workspace.resolveExisting(args.path);
				const current = await Bun.file(file).text();
				if (hashText(current) !== args.expectedHash) throw new Error("File changed since it was read; re-read before editing.");
				const first = current.indexOf(args.oldText);
				if (first < 0) throw new Error("oldText was not found.");
				if (current.indexOf(args.oldText, first + 1) >= 0) throw new Error("oldText is not unique; include more context.");
				const next = `${current.slice(0, first)}${args.newText}${current.slice(first + args.oldText.length)}`;
				const relative = workspace.relative(file);
				context.signal.throwIfAborted();
				await atomicWriteWorkspaceFile(file, next, (await fs.stat(file)).mode & 0o777);
				recordMutation(context.state, [relative], `replace_in_file changed ${relative}`);
				const contentHash = hashText(next);
				upsertArtifact(context.state, { path: relative, contentHash, mutationEpoch: context.state.mutationEpoch });
				const evidence = addEvidence(context.state, {
					kind: "file",
					source: "replace_in_file",
					subject: relative,
					summary: "Applied one snapshot-checked replacement",
					contentHash,
					dependencyPaths: [relative],
				});
				return success(`Updated ${relative}.\n[hash:${contentHash}]\n[evidence:${evidence.id}]`, [evidence]);
			} catch (error) {
				return failure(error);
			}
		},
	};

	const shell: ExecutableTool = {
		definition: {
			name: "shell",
			description:
				"Run a local shell command in the workspace. High-impact commands require explicit authorization. Set timeoutSeconds explicitly for builds or tests that can take longer than the 180-second default.",
			parameters: Type.Object({
				command: Type.String({ minLength: 1, maxLength: 20_000 }),
				timeoutSeconds: Type.Optional(Type.Number({ minimum: 1, maximum: 3600 })),
			}),
		},
		async execute(call, context) {
			try {
				const args = validate(this.definition, call) as { command: string; timeoutSeconds?: number };
				const risk = classifyShellRisk(args.command);
				const sandboxAvailable = shellSandboxAvailable();
				const automaticallyAllowed =
					context.permissionMode === "autonomous"
						? risk !== "high" && sandboxAvailable
						: context.permissionMode === "guarded"
							? risk === "low" && sandboxAvailable
							: false;
				const authorized = automaticallyAllowed
					? true
					: await context.authorize?.({
							command: args.command,
							risk,
							reason: `${risk}-risk shell command under ${context.permissionMode} mode${sandboxAvailable ? "" : "; no supported OS sandbox"}`,
						});
				if (!authorized) throw new Error(`Shell command requires ${risk}-risk authorization.`);
				const before = await workspace.snapshot();
				const result = await runShell({
					command: args.command,
					cwd: workspace.root,
					timeoutSeconds: args.timeoutSeconds ?? 180,
					signal: context.signal,
					sandbox: sandboxAvailable,
					allowNetwork: Boolean(context.allowNetwork),
				});
				const changedPaths = await workspace.changesSince(before);
				const mutationEvidence = [];
				if (changedPaths.length > 0) {
					recordMutation(context.state, changedPaths, `shell changed ${changedPaths.length} workspace entries`);
					mutationEvidence.push(
						addEvidence(context.state, {
							kind: "file",
							source: "shell",
							subject: changedPaths.slice(0, 50).join(", ").slice(0, 1000),
							summary: `Shell changed ${changedPaths.length} workspace entries`,
							dependencyPaths: changedPaths,
						}),
					);
				}
				if (result.exitCode !== 0) {
					const failed = addEvidence(context.state, {
						kind: "command",
						source: "shell",
						subject: args.command.slice(0, 1000),
						summary: `Command failed with exit code ${result.exitCode}; sandboxed=${String(result.sandboxed)}`,
						exitCode: result.exitCode,
						outcome: "failed",
						globalScope: true,
					});
					return {
						text: `${result.output}\n[evidence:${failed.id}]`,
						isError: true,
						evidence: [...mutationEvidence, failed],
					};
				}
				const evidence = addEvidence(context.state, {
					kind: "command",
					source: "shell",
					subject: args.command.slice(0, 1000),
					summary: `Command completed with exit code ${result.exitCode}; sandboxed=${String(result.sandboxed)}`,
					exitCode: result.exitCode,
					outcome: "passed",
					globalScope: true,
				});
				const evidenceTags = [...mutationEvidence, evidence].map(item => `[evidence:${item.id}]`).join("\n");
				return success(`${result.output}\n${evidenceTags}`, [...mutationEvidence, evidence]);
			} catch (error) {
				return failure(error);
			}
		},
	};

	const verify: ExecutableTool = {
		definition: {
			name: "verify",
			description:
				"Run a trusted test/build or a command locked in the Goal Contract. Name the requirement IDs it verifies. Arbitrary successful shell commands cannot create completion evidence.",
			parameters: Type.Object({
				command: Type.String({ minLength: 1, maxLength: 20_000 }),
				requirementIds: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { minItems: 1, maxItems: 200 }),
				timeoutSeconds: Type.Optional(Type.Number({ minimum: 1, maximum: 3600 })),
			}),
		},
		async execute(call, context) {
			try {
				const args = validate(this.definition, call) as {
					command: string;
					requirementIds: string[];
					timeoutSeconds?: number;
				};
				const requirementIds = [...new Set(args.requirementIds)];
				const knownRequirements = new Set(context.state.requirements.map(item => item.id));
				const unknownRequirements = requirementIds.filter(id => !knownRequirements.has(id));
				if (unknownRequirements.length > 0) {
					throw new Error(`Verification names unknown requirement ids: ${unknownRequirements.join(", ")}.`);
				}
				const evidenceKind = verificationKindFor(context.state, args.command);
				if (!evidenceKind) {
					throw new Error(
						"Command is not a recognized test/build and was not locked with --verify-command. " +
							"Use a standard test/build command or declare the exact task-specific verifier when creating the run.",
					);
				}
				await assertVerificationCommandSafe(workspace.root, args.command);
				const risk = classifyShellRisk(args.command);
				const sandboxAvailable = shellSandboxAvailable();
				const automaticallyAllowed =
					context.permissionMode === "autonomous"
						? risk !== "high" && sandboxAvailable
						: context.permissionMode === "guarded"
							? risk === "low" && sandboxAvailable
							: false;
				const authorized = automaticallyAllowed
					? true
					: await context.authorize?.({
							command: args.command,
							risk,
							reason: `${risk}-risk verification under ${context.permissionMode} mode${sandboxAvailable ? "" : "; no supported OS sandbox"}`,
						});
				if (!authorized) throw new Error(`Verification command requires ${risk}-risk authorization.`);
				const before = await workspace.snapshot();
				const result = await runShell({
					command: args.command,
					cwd: workspace.root,
					timeoutSeconds: args.timeoutSeconds ?? 300,
					signal: context.signal,
					sandbox: sandboxAvailable,
					allowNetwork: Boolean(context.allowNetwork),
				});
				const changedPaths = await workspace.changesSince(before);
				const mutationEvidence = [];
				if (changedPaths.length > 0) {
					recordMutation(context.state, changedPaths, `verify changed ${changedPaths.length} workspace entries`);
					mutationEvidence.push(
						addEvidence(context.state, {
							kind: "file",
							source: "verify",
							subject: changedPaths.slice(0, 50).join(", ").slice(0, 1000),
							summary: `Verification changed ${changedPaths.length} workspace entries`,
							dependencyPaths: changedPaths,
						}),
					);
				}
				if (result.exitCode !== 0) {
					const failed = addEvidence(context.state, {
						kind: evidenceKind,
						source: "verify",
						subject: args.command.slice(0, 1000),
						summary: `Verification failed with exit code ${result.exitCode}; sandboxed=${String(result.sandboxed)}`,
						exitCode: result.exitCode,
						outcome: "failed",
						commandHash: verificationCommandHash(args.command),
						verifiesRequirementIds: requirementIds,
						globalScope: true,
					});
					return {
						text: `${result.output}\n[evidence:${failed.id}]`,
						isError: true,
						evidence: [...mutationEvidence, failed],
					};
				}
				const evidence = addEvidence(context.state, {
					kind: evidenceKind,
					source: "verify",
					subject: args.command.slice(0, 1000),
					summary: `Verification completed with exit code ${result.exitCode}; sandboxed=${String(result.sandboxed)}`,
					exitCode: result.exitCode,
					outcome: "passed",
					commandHash: verificationCommandHash(args.command),
					verifiesRequirementIds: requirementIds,
					globalScope: true,
				});
				const evidenceTags = [...mutationEvidence, evidence].map(item => `[evidence:${item.id}]`).join("\n");
				return success(`${result.output}\n${evidenceTags}`, [...mutationEvidence, evidence]);
			} catch (error) {
				return failure(error);
			}
		},
	};

	const reportState: ExecutableTool = {
		definition: {
			name: "report_state",
			description: "Submit a structured progress, completion, or blocker claim. Completion is decided by the harness, not this tool.",
			parameters: Type.Object({
				status: Type.Union([Type.Literal("continue"), Type.Literal("complete"), Type.Literal("blocked")]),
				summary: Type.String({ maxLength: 4_000 }),
				requirementIds: Type.Array(Type.String({ maxLength: 200 }), { maxItems: 200 }),
				evidenceIds: Type.Array(Type.String({ maxLength: 200 }), { maxItems: 500 }),
				nextFrontier: Type.String({ maxLength: 4_000 }),
				unknowns: Type.Array(Type.String({ maxLength: 2_000 }), { maxItems: 200 }),
				conflicts: Type.Array(Type.String({ maxLength: 2_000 }), { maxItems: 200 }),
				resolvedUnknowns: Type.Optional(Type.Array(Type.String({ maxLength: 2_000 }), { maxItems: 200 })),
				resolvedConflictIds: Type.Optional(Type.Array(Type.String({ maxLength: 200 }), { maxItems: 200 })),
				claims: Type.Optional(
					Type.Array(
						Type.Object({
							requirementId: Type.String({ maxLength: 200 }),
							statement: Type.String({ maxLength: 4_000 }),
							evidenceIds: Type.Array(Type.String({ maxLength: 200 }), { maxItems: 50 }),
							dependencyPaths: Type.Optional(Type.Array(Type.String({ maxLength: 1_000 }), { maxItems: 100 })),
							risk: Type.Optional(
								Type.Union([
									Type.Literal("low"),
									Type.Literal("medium"),
									Type.Literal("high"),
									Type.Literal("critical"),
								]),
							),
						}),
						{ maxItems: 200 },
					),
				),
				facts: Type.Optional(
					Type.Array(
						Type.Object({
							statement: Type.String({ maxLength: 2_000 }),
							evidenceIds: Type.Array(Type.String({ maxLength: 200 }), { maxItems: 20 }),
						}),
						{ maxItems: 100 },
					),
				),
			}),
		},
		async execute(call, context) {
			try {
				const args = validate(this.definition, call) as Record<string, unknown>;
				const claims: ClaimSubmission[] = Array.isArray(args.claims)
					? args.claims
						.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
						.map(item => ({
							requirementId: String(item.requirementId ?? ""),
							statement: String(item.statement ?? ""),
							evidenceIds: stringArray(item.evidenceIds),
							...(Array.isArray(item.dependencyPaths)
								? { dependencyPaths: stringArray(item.dependencyPaths) }
								: {}),
							...(typeof item.risk === "string" ? { risk: item.risk as ClaimRisk } : {}),
						}))
					: [];
				const facts: FactSubmission[] = Array.isArray(args.facts)
					? args.facts
						.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
						.map(item => ({
							statement: String(item.statement ?? ""),
							evidenceIds: stringArray(item.evidenceIds),
						}))
					: [];
				const report: StateReport = {
					status: args.status as StateReport["status"],
					summary: String(args.summary ?? ""),
					requirementIds: stringArray(args.requirementIds),
					evidenceIds: stringArray(args.evidenceIds),
					nextFrontier: String(args.nextFrontier ?? ""),
					unknowns: stringArray(args.unknowns),
					conflicts: stringArray(args.conflicts),
					resolvedUnknowns: stringArray(args.resolvedUnknowns),
					resolvedConflictIds: stringArray(args.resolvedConflictIds),
					...(claims.length > 0 ? { claims } : {}),
					...(facts.length > 0 ? { facts } : {}),
				};
				const currentEvidence = new Map(
					context.state.evidence
						.filter(item => evidenceIsCurrent(context.state, item))
						.map(item => [item.id, item]),
				);
				for (const fact of facts) {
					if (!fact.statement.trim()) throw new Error("A verified fact statement cannot be empty.");
					const unavailable = fact.evidenceIds.filter(id => !currentEvidence.has(id));
					if (unavailable.length > 0 || fact.evidenceIds.length === 0) {
						throw new Error("Verified facts must cite current host evidence.");
					}
				}
				if (report.status === "complete") {
					if (context.state.contract.requiresWorkspaceChange && context.state.mutationEpoch === 0) {
						throw new Error("This Goal Contract requires a workspace change before completion.");
					}
					if (
						context.state.contract.requiresWorkspaceChange &&
						context.state.baselineWorkspaceFingerprint &&
						context.state.workspaceFingerprint === context.state.baselineWorkspaceFingerprint
					) {
						throw new Error("The workspace matches its starting state; the required net change is absent.");
					}
					const knownRequirements = new Set(context.state.requirements.map(item => item.id));
					const unknownRequirements = report.requirementIds.filter(id => !knownRequirements.has(id));
					if (unknownRequirements.length > 0) {
						throw new Error(`Unknown completion requirement ids: ${unknownRequirements.join(", ")}.`);
					}
					const staleEvidence = report.evidenceIds.filter(id => !currentEvidence.has(id));
					if (staleEvidence.length > 0) {
						throw new Error(
							`Completion evidence is missing or stale: ${staleEvidence.join(", ")}. ` +
								`Use only evidence tags returned at the current workspace mutation epoch (${context.state.mutationEpoch}).`,
						);
					}
					if (report.evidenceIds.length === 0) {
						throw new Error("A completion claim must cite current host evidence.");
					}
					for (const claim of claims) {
						if (!knownRequirements.has(claim.requirementId)) {
							throw new Error(`Unknown claim requirement id: ${claim.requirementId}.`);
						}
						if (!claim.statement.trim()) throw new Error("A proof claim statement cannot be empty.");
						const unsubmitted = claim.evidenceIds.filter(id => !report.evidenceIds.includes(id));
						if (unsubmitted.length > 0) {
							throw new Error(`Claim evidence must also appear in top-level evidenceIds: ${unsubmitted.join(", ")}.`);
						}
					}
					for (const fact of facts) {
						const unsubmitted = fact.evidenceIds.filter(id => !report.evidenceIds.includes(id));
						if (unsubmitted.length > 0) {
							throw new Error("Completion facts must cite evidence included in top-level evidenceIds.");
						}
					}
					for (const requirementId of context.state.mutationEpoch > 0
						? context.state.requirements.filter(item => item.required).map(item => item.id)
						: []) {
						const verification = report.evidenceIds.some(id => {
							const item = currentEvidence.get(id);
							return Boolean(item && evidenceVerifiesRequirement(item, requirementId));
						});
						if (!verification) {
							throw new Error(`Completion requires trusted verification evidence for ${requirementId}.`);
						}
					}
				}
				return success("State report accepted for harness evaluation.", [], report);
			} catch (error) {
				return failure(error);
			}
		},
	};

	return [readFile, listFiles, search, writeFile, replaceInFile, shell, verify, reportState];
}

export function findTool(tools: readonly ExecutableTool[], call: ModelToolCall): ExecutableTool | undefined {
	return tools.find(tool => tool.definition.name === call.name);
}
