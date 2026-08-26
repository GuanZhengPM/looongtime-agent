import {
	Container,
	Editor,
	matchesKey,
	ProcessTerminal,
	SelectList,
	Spacer,
	Text,
	TuiMainScreen,
	type EditorTheme,
} from "@earendil-works/pi-tui";
import { parseModelSelection } from "../config";
import { runHarness, type HarnessObserver } from "../core/harness";
import { RunRepository } from "../core/repository";
import { createRunState } from "../core/state";
import type { ModelSelection, PermissionMode, RunEvent, RunState, SemanticAuditMode } from "../core/types";
import type { PiModelsPort } from "../providers/pi-models";
import { createTools } from "../tools/registry";
import { Workspace } from "../tools/workspace";

const ansi = {
	cyan: (text: string) => `\u001b[36m${text}\u001b[39m`,
	green: (text: string) => `\u001b[32m${text}\u001b[39m`,
	yellow: (text: string) => `\u001b[33m${text}\u001b[39m`,
	dim: (text: string) => `\u001b[2m${text}\u001b[22m`,
	bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
};
const MAX_VISIBLE_STREAM_CHARACTERS = 40_000;

function appendVisibleStream(current: string, delta: string): string {
	const combined = current + delta;
	if (combined.length <= MAX_VISIBLE_STREAM_CHARACTERS) return combined;
	return `${ansi.dim("… older streaming output omitted …")}\n${combined.slice(-MAX_VISIBLE_STREAM_CHARACTERS)}`;
}

const editorTheme: EditorTheme = {
	borderColor: ansi.cyan,
	selectList: {
		selectedPrefix: ansi.cyan,
		selectedText: ansi.bold,
		description: ansi.dim,
		scrollInfo: ansi.dim,
		noMatch: ansi.yellow,
	},
};

export interface InteractiveOptions {
	workspace: string;
	model?: ModelSelection;
	permissionMode: PermissionMode;
	semanticAuditMode: SemanticAuditMode;
	allowNetwork: boolean;
	modelPort: PiModelsPort;
}

function runStatus(event: RunEvent): string | undefined {
	if (event.type === "round_started") {
		return `round ${String(event.payload.round)} · ${String(event.payload.phase)} · ${String(event.payload.frontier).slice(0, 100)}`;
	}
	if (event.type === "tool_started") return `tool ${String(event.payload.tool)} ${String(event.payload.target ?? "")}`;
	if (event.type === "progress_measured") {
		const delta = event.payload.delta as { score?: number } | undefined;
		return `progress +${String(delta?.score ?? 0)} · stalled ${String(event.payload.stalledRounds)}`;
	}
	if (event.type === "audit_routed") return `audit ${String(event.payload.route)} · risk ${String(event.payload.riskScore)}`;
	if (event.type === "semantic_audit_started") return "semantic audit started";
	if (event.type === "semantic_audit_completed") return `semantic audit ${String(event.payload.verdict ?? event.payload.status)}`;
	if (event.type === "run_completed") return "verified completion";
	if (event.type === "run_blocked") return `blocked · ${String(event.payload.reason)}`;
	return undefined;
}

function summary(state: RunState): string {
	const verified = state.requirements.filter(item => item.status === "verified").length;
	const supported = state.proof.claims.filter(item => item.status === "supported").length;
	return `${state.status} · run ${state.id} · round ${state.round} · verified ${verified}/${state.requirements.length} · proof ${supported}/${state.proof.claims.length} · audit ${state.audit.route}/${state.semanticAuditMode} · tokens ${state.usage.inputTokens + state.usage.outputTokens}`;
}

export async function runInteractive(options: InteractiveOptions): Promise<void> {
	const terminal = new ProcessTerminal();
	const tui = new TuiMainScreen(terminal, true);
	const transcript = new Container();
	const header = new Text("", 0, 0);
	const status = new Text(ansi.dim("ready"), 0, 0);
	const editor = new Editor(tui, editorTheme, { paddingX: 0 });
	let selectedModel = options.model;
	let permissionMode = options.permissionMode;
	let semanticAuditMode = options.semanticAuditMode;
	let allowNetwork = options.allowNetwork;
	let allowHighRisk = false;
	let activeController: AbortController | undefined;
	let cancelAuthorization: (() => void) | undefined;
	let currentState: RunState | undefined;
	let busy = false;
	const finished = Promise.withResolvers<void>();

	const updateHeader = (): void => {
		header.setText(
			`${ansi.bold("Longtime")}  ${selectedModel ? `${selectedModel.provider}/${selectedModel.modelId}` : "no model"}  ${permissionMode}  audit:${semanticAuditMode}  network:${allowNetwork ? "on" : "off"}${allowHighRisk ? "  high-risk authorized" : ""}`,
		);
		tui.requestRender();
	};
	updateHeader();
	transcript.addChild(header);
	transcript.addChild(new Text(ansi.dim("/model provider/model · /resume id · /permission mode · /audit mode · /network on|off · /allow-risky on|off · /status · /exit")));
	transcript.addChild(new Spacer(1));
	tui.addChild(transcript);
	tui.addChild(status);
	tui.addChild(editor);
	tui.setFocus(editor);

	const stop = (): void => {
		activeController?.abort("interactive session closed");
		tui.stop();
		finished.resolve();
	};
	tui.addInputListener(data => {
		if (!matchesKey(data, "ctrl+c")) return undefined;
		if (busy) {
			cancelAuthorization?.();
			activeController?.abort("interrupted by user");
			status.setText(ansi.yellow("pausing current run…"));
			tui.requestRender();
		} else {
			stop();
		}
		return { consume: true };
	});

	const requestAuthorization = async (input: { command: string; reason: string }): Promise<boolean> => {
		if (allowHighRisk) return true;
		const result = Promise.withResolvers<boolean>();
		const dialog = new Container();
		dialog.addChild(new Text(ansi.yellow("High-risk authorization"), 1, 0));
		dialog.addChild(new Text(`${input.reason}\n${input.command.slice(0, 500)}`, 1, 1));
		const choices = new SelectList(
			[
				{ value: "deny", label: "Deny", description: "Keep the run inside current permissions" },
				{ value: "allow", label: "Authorize once", description: "Run once; the sandbox remains active when available" },
			],
			2,
			editorTheme.selectList,
		);
		dialog.addChild(choices);
		const overlay = tui.showOverlay(dialog, { width: "80%", maxHeight: 12, anchor: "center", margin: 2 });
		const finish = (allowed: boolean): void => {
			overlay.hide();
			cancelAuthorization = undefined;
			tui.setFocus(editor);
			result.resolve(allowed);
		};
		choices.onSelect = item => finish(item.value === "allow");
		choices.onCancel = () => finish(false);
		cancelAuthorization = () => finish(false);
		tui.setFocus(choices);
		tui.requestRender();
		return await result.promise;
	};

	const executeState = async (state: RunState, repository: RunRepository): Promise<void> => {
		if (busy) return;
		busy = true;
		editor.disableSubmit = true;
		activeController = new AbortController();
		currentState = state;
		const output = new Text("", 0, 0);
		transcript.addChild(new Text(`${ansi.cyan("goal")} ${state.contract.objective}`));
		transcript.addChild(output);
		let streamed = "";
		const observer: HarnessObserver = {
			onText(delta) {
				streamed = appendVisibleStream(streamed, delta);
				output.setText(streamed);
				tui.requestRender();
			},
			onEvent(event) {
				const message = runStatus(event);
				if (message) status.setText(ansi.dim(message));
				tui.requestRender();
			},
			authorize: requestAuthorization,
		};
		try {
			const final = await runHarness({
				state,
				repository,
				modelPort: options.modelPort,
				tools: await createTools(state.workspace),
				signal: activeController.signal,
				observer,
			});
			currentState = final;
			transcript.addChild(new Text(final.status === "completed" ? ansi.green(summary(final)) : ansi.yellow(summary(final))));
			status.setText(ansi.dim(final.recoveryGuidance ?? "ready"));
		} catch (error) {
			transcript.addChild(new Text(ansi.yellow(error instanceof Error ? error.message : String(error))));
			status.setText(ansi.dim("run paused; use /resume with its run id"));
		} finally {
			transcript.addChild(new Spacer(1));
			busy = false;
			editor.disableSubmit = false;
			activeController = undefined;
			editor.setText("");
			tui.setFocus(editor);
			tui.requestRender();
		}
	};

	const handleCommand = async (input: string): Promise<boolean> => {
		const [command, ...parts] = input.trim().split(/\s+/);
		if (command === "/exit") {
			stop();
			return true;
		}
		if (command === "/model") {
			if (!parts[0]) throw new Error("Usage: /model provider/model-id");
			selectedModel = parseModelSelection(parts[0], selectedModel?.reasoning ?? "high");
			updateHeader();
			return true;
		}
		if (command === "/permission") {
			const mode = parts[0];
			if (mode !== "autonomous" && mode !== "guarded" && mode !== "locked") {
				throw new Error("Usage: /permission autonomous|guarded|locked");
			}
			permissionMode = mode;
			updateHeader();
			return true;
		}
		if (command === "/audit") {
			const mode = parts[0];
			if (mode !== "off" && mode !== "shadow" && mode !== "gate") {
				throw new Error("Usage: /audit off|shadow|gate");
			}
			semanticAuditMode = mode;
			updateHeader();
			return true;
		}
		if (command === "/network") {
			if (parts[0] !== "on" && parts[0] !== "off") throw new Error("Usage: /network on|off");
			allowNetwork = parts[0] === "on";
			updateHeader();
			return true;
		}
		if (command === "/allow-risky") {
			if (parts[0] !== "on" && parts[0] !== "off") throw new Error("Usage: /allow-risky on|off");
			allowHighRisk = parts[0] === "on";
			updateHeader();
			return true;
		}
		if (command === "/status") {
			transcript.addChild(new Text(currentState ? summary(currentState) : "No run in this terminal session."));
			tui.requestRender();
			return true;
		}
		if (command === "/resume") {
			if (!parts[0]) throw new Error("Usage: /resume run-id");
			const repository = await RunRepository.find(parts[0]);
			const state = await repository.load();
			if (state.status === "completed") throw new Error("Completed runs cannot be resumed.");
			if (selectedModel) state.model = structuredClone(selectedModel);
			state.permissionMode = permissionMode;
			state.semanticAuditMode = semanticAuditMode;
			state.allowNetwork = allowNetwork;
			state.status = "running";
			state.progress.stalledRounds = 0;
			await repository.append(state, "run_resumed", { model: state.model, source: "interactive" });
			await repository.save(state);
			void executeState(state, repository);
			return true;
		}
		return false;
	};

	editor.onSubmit = input => {
		const text = input.trim();
		if (!text || busy) return;
		void (async () => {
			try {
				if (text.startsWith("/") && (await handleCommand(text))) {
					editor.setText("");
					return;
				}
				if (!selectedModel) throw new Error("Select a model first with /model provider/model-id.");
				const state = createRunState({
					objective: text,
					workspace: options.workspace,
					model: selectedModel,
					permissionMode,
					semanticAuditMode,
					allowNetwork,
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
					source: "interactive",
				});
				await repository.save(state);
				void executeState(state, repository);
			} catch (error) {
				status.setText(ansi.yellow(error instanceof Error ? error.message : String(error)));
				tui.requestRender();
			}
		})();
	};

	tui.start();
	await finished.promise;
	await terminal.drainInput();
}
