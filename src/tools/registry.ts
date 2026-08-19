import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Type, validateToolCall, type Tool, type ToolCall } from "@earendil-works/pi-ai";
import type { ModelToolCall } from "../core/model-port";
import { addEvidence, upsertArtifact } from "../core/state";
import { evidenceIsCurrent, recordMutation } from "../core/proof";
import type { ClaimRisk, ClaimSubmission, StateReport } from "../core/types";
import type { ExecutableTool, ToolExecutionContext, ToolOutcome } from "./types";
import {
	classifyShellRisk,
	hashText,
	runShell,
	shellEvidenceKind,
	shellSandboxAvailable,
	Workspace,
} from "./workspace";

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
				path: Type.String(),
				offset: Type.Optional(Type.Number({ minimum: 1 })),
				limit: Type.Optional(Type.Number({ minimum: 1, maximum: 2000 })),
			}),
		},
		async execute(call, context) {
			try {
				const args = validate(this.definition, call) as { path: string; offset?: number; limit?: number };
				const file = await workspace.resolveExisting(args.path);
				const text = await Bun.file(file).text();
				const lines = text.split("\n");
				const offset = Math.floor(args.offset ?? 1);
				const limit = Math.floor(args.limit ?? 300);
				const body = lines
					.slice(offset - 1, offset - 1 + limit)
					.map((line, index) => `${offset + index}:${line}`)
					.join("\n");
				const evidence = addEvidence(context.state, {
					kind: "observation",
					source: "read_file",
					subject: workspace.relative(file),
					summary: `Read lines ${offset}-${Math.min(lines.length, offset + limit - 1)} of ${workspace.relative(file)}`,
					contentHash: hashText(text),
					dependencyPaths: [workspace.relative(file)],
				});
				return success(`${body}\n[hash:${evidence.contentHash}]\n[evidence:${evidence.id}]`, [evidence]);
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
				pattern: Type.Optional(Type.String()),
				limit: Type.Optional(Type.Number({ minimum: 1, maximum: 5000 })),
			}),
		},
		async execute(call, context) {
			try {
				const args = validate(this.definition, call) as { pattern?: string; limit?: number };
				const files: string[] = [];
				for await (const file of new Bun.Glob(args.pattern ?? "**/*").scan({
					cwd: workspace.root,
					dot: true,
					onlyFiles: true,
				})) {
					if (
						file.startsWith(".git/") ||
						file.startsWith("node_modules/") ||
						file.startsWith(".longtime/") ||
						file.startsWith(".continuum/")
					)
						continue;
					files.push(file);
					if (files.length >= (args.limit ?? 500)) break;
				}
				files.sort();
				const evidence = addEvidence(context.state, {
					kind: "observation",
					source: "list_files",
					subject: args.pattern ?? "**/*",
					summary: `Listed ${files.length} workspace files`,
					globalScope: true,
				});
				return success(`${files.join("\n") || "No files."}\n[evidence:${evidence.id}]`, [evidence]);
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
				pattern: Type.String(),
				files: Type.Optional(Type.String()),
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
				const expression = new RegExp(args.pattern, args.caseSensitive === false ? "i" : "");
				const matches: string[] = [];
				for await (const file of new Bun.Glob(args.files ?? "**/*").scan({
					cwd: workspace.root,
					dot: true,
					onlyFiles: true,
				})) {
					if (
						file.startsWith(".git/") ||
						file.startsWith("node_modules/") ||
						file.startsWith(".longtime/") ||
						file.startsWith(".continuum/")
					)
						continue;
					let text: string;
					try {
						text = await Bun.file(path.join(workspace.root, file)).text();
					} catch {
						continue;
					}
					for (const [index, line] of text.split("\n").entries()) {
						if (!expression.test(line)) continue;
						matches.push(`${file}:${index + 1}:${line.slice(0, 2000)}`);
						if (matches.length >= (args.limit ?? 300)) break;
					}
					if (matches.length >= (args.limit ?? 300)) break;
				}
				const evidence = addEvidence(context.state, {
					kind: "observation",
					source: "search",
					subject: args.pattern,
					summary: `Found ${matches.length} matching lines`,
					globalScope: true,
				});
				return success(`${matches.join("\n") || "No matches."}\n[evidence:${evidence.id}]`, [evidence]);
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
				path: Type.String(),
				content: Type.String(),
				expectedHash: Type.Optional(Type.String()),
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
				try {
					const current = await Bun.file(file).text();
					if (!args.expectedHash) throw new Error("Replacing a file requires expectedHash from a previous read.");
					if (hashText(current) !== args.expectedHash) throw new Error("File changed since it was read; re-read before writing.");
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
				const relative = workspace.relative(file);
				await fs.mkdir(path.dirname(file), { recursive: true });
				await Bun.write(file, args.content);
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
				path: Type.String(),
				expectedHash: Type.String(),
				oldText: Type.String({ minLength: 1 }),
				newText: Type.String(),
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
				await Bun.write(file, next);
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
				command: Type.String(),
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
					sandbox: risk !== "high",
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
				if (result.exitCode !== 0) return { text: result.output, isError: true, evidence: mutationEvidence };
				const evidence = addEvidence(context.state, {
					kind: shellEvidenceKind(args.command),
					source: "shell",
					subject: args.command.slice(0, 1000),
					summary: `Command completed with exit code ${result.exitCode}; sandboxed=${String(result.sandboxed)}`,
					exitCode: result.exitCode,
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
				"Run a meaningful final validation command against the current workspace. A successful exit creates current test evidence for completion; do not use this for implementation or trivial commands. Set timeoutSeconds explicitly for validation that can take longer than the 300-second default.",
			parameters: Type.Object({
				command: Type.String(),
				timeoutSeconds: Type.Optional(Type.Number({ minimum: 1, maximum: 3600 })),
			}),
		},
		async execute(call, context) {
			try {
				const args = validate(this.definition, call) as { command: string; timeoutSeconds?: number };
				if (/^\s*(?:true|:|echo(?:\s+.*)?|printf(?:\s+.*)?)\s*$/s.test(args.command)) {
					throw new Error("Verification command is trivial and cannot produce completion evidence.");
				}
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
					sandbox: risk !== "high",
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
				if (result.exitCode !== 0) return { text: result.output, isError: true, evidence: mutationEvidence };
				const evidence = addEvidence(context.state, {
					kind: "test",
					source: "verify",
					subject: args.command.slice(0, 1000),
					summary: `Verification completed with exit code ${result.exitCode}; sandboxed=${String(result.sandboxed)}`,
					exitCode: result.exitCode,
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
				summary: Type.String(),
				requirementIds: Type.Array(Type.String()),
				evidenceIds: Type.Array(Type.String()),
				nextFrontier: Type.String(),
				unknowns: Type.Array(Type.String()),
				conflicts: Type.Array(Type.String()),
				resolvedUnknowns: Type.Optional(Type.Array(Type.String())),
				resolvedConflictIds: Type.Optional(Type.Array(Type.String())),
				claims: Type.Optional(
					Type.Array(
						Type.Object({
							requirementId: Type.String(),
							statement: Type.String(),
							evidenceIds: Type.Array(Type.String()),
							dependencyPaths: Type.Optional(Type.Array(Type.String())),
							risk: Type.Optional(
								Type.Union([
									Type.Literal("low"),
									Type.Literal("medium"),
									Type.Literal("high"),
									Type.Literal("critical"),
								]),
							),
						}),
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
				};
				if (report.status === "complete") {
					const knownRequirements = new Set(context.state.requirements.map(item => item.id));
					const unknownRequirements = report.requirementIds.filter(id => !knownRequirements.has(id));
					if (unknownRequirements.length > 0) {
						throw new Error(`Unknown completion requirement ids: ${unknownRequirements.join(", ")}.`);
					}
					const currentEvidence = new Map(
						context.state.evidence
							.filter(item => evidenceIsCurrent(context.state, item))
							.map(item => [item.id, item]),
					);
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
					const hasVerification = report.evidenceIds.some(id => {
						const kind = currentEvidence.get(id)?.kind;
						return kind === "test" || kind === "build";
					});
					if (context.state.mutationEpoch > 0 && !hasVerification) {
						throw new Error("A completion claim after workspace changes must cite a current test or build evidence tag.");
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
