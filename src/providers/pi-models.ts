import {
	type Api,
	type AuthCheck,
	type AuthInteraction,
	type AuthType,
	type Context,
	type Model,
	type Models,
	type TSchema,
	type Tool,
	type ToolCall,
	cleanupSessionResources,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type {
	ModelDescriptor,
	ModelPort,
	ModelRoundRequest,
	ModelRoundResult,
	ModelToolCall,
} from "../core/model-port";
import { emptyUsage } from "../core/types";
import { FileCredentialStore } from "./credential-store";

function completionTokens(usage: ReturnType<typeof emptyUsage>): number {
	// maxOutputTokens is a completion budget for this round, not a total-request
	// budget. Counting the (often cached) input here can terminate a tool loop
	// immediately after its first large-context response, before the model has a
	// chance to consume the tool results or submit report_state.
	return usage.outputTokens;
}

function toolCallArguments(call: ToolCall): Record<string, unknown> {
	return call.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments)
		? call.arguments
		: {};
}

function boundedToolResult(text: string, limit = 24_000): string {
	if (text.length <= limit) return text;
	const evidenceTags = [...text.matchAll(/\[(?:audit-)?evidence:[^\]]+\]/g)].map(match => match[0]);
	const half = Math.floor((limit - 200) / 2);
	return `${text.slice(0, half)}\n... ${text.length - half * 2} tool-result characters omitted from model context ...\n${text.slice(-half)}\n${[...new Set(evidenceTags)].join("\n")}`;
}

function resolveModel(models: Models, provider: string, modelId: string): Model<Api> {
	const model = models.getModel(provider, modelId);
	if (!model) throw new Error(`Unknown model '${provider}/${modelId}'. Use 'looongtime models ${provider}' to inspect models.`);
	return model;
}

export class PiModelsPort implements ModelPort {
	readonly #models: Models;

	constructor(models?: Models) {
		this.#models = models ?? builtinModels({ credentials: new FileCredentialStore() });
	}

	list(provider?: string): ModelDescriptor[] {
		return this.#models.getModels(provider).map(model => ({
			provider: model.provider,
			id: model.id,
			name: model.name,
			api: model.api,
			contextWindow: model.contextWindow,
			maxOutputTokens: model.maxTokens,
			reasoning: model.reasoning,
		}));
	}

	async assertAvailable(selection: ModelRoundRequest["model"], signal?: AbortSignal): Promise<void> {
		const model = resolveModel(this.#models, selection.provider, selection.modelId);
		const auth = await this.#models.getAuth(model, signal ? { signal } : undefined);
		if (!auth) {
			throw new Error(
				`Provider '${selection.provider}' is not authenticated. Configure its documented environment variable or credential source.`,
			);
		}
	}

	authMethods(providerId: string): { apiKey?: string; oauth?: string } {
		const provider = this.#models.getProvider(providerId);
		if (!provider) throw new Error(`Unknown provider '${providerId}'.`);
		return {
			...(provider.auth.apiKey?.login ? { apiKey: provider.auth.apiKey.name } : {}),
			...(provider.auth.oauth ? { oauth: provider.auth.oauth.loginLabel ?? provider.auth.oauth.name } : {}),
		};
	}

	listAuthProviders(): Array<{
		id: string;
		name: string;
		models: number;
		apiKey?: { name: string; interactive: boolean };
		oauth?: { name: string; subscription: boolean };
	}> {
		return this.#models
			.getProviders()
			.map(provider => ({
				id: provider.id,
				name: provider.name,
				models: provider.getModels().length,
				...(provider.auth.apiKey
					? {
							apiKey: {
								name: provider.auth.apiKey.name,
								interactive: Boolean(provider.auth.apiKey.login),
							},
						}
					: {}),
				...(provider.auth.oauth
					? {
							oauth: {
								name: provider.auth.oauth.loginLabel ?? provider.auth.oauth.name,
								subscription: Boolean(provider.auth.oauth.isSubscription),
							},
						}
					: {}),
			}))
			.sort((left, right) => left.id.localeCompare(right.id));
	}

	async authStatus(providerId: string): Promise<AuthCheck | undefined> {
		if (!this.#models.getProvider(providerId)) throw new Error(`Unknown provider '${providerId}'.`);
		return await this.#models.checkAuth(providerId);
	}

	async login(providerId: string, type: AuthType, interaction: AuthInteraction): Promise<void> {
		await this.#models.login(providerId, type, interaction);
	}

	async logout(providerId: string): Promise<void> {
		await this.#models.logout(providerId);
	}

	closeSession(sessionId: string): void {
		cleanupSessionResources(sessionId);
	}

	async runRound(request: ModelRoundRequest): Promise<ModelRoundResult> {
		const model = resolveModel(this.#models, request.model.provider, request.model.modelId);
		const tools: Tool[] = request.tools.map(tool => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters as TSchema,
		}));
		const context: Context = {
			systemPrompt: request.systemPrompt,
			messages: [{ role: "user", content: request.userPrompt, timestamp: Date.now() }],
			tools,
		};
		const usage = emptyUsage();
		let output = "";
		let reportReminderSent = false;
		for (let turn = 1; turn <= request.maxTurns; turn += 1) {
			const remaining = request.maxOutputTokens - completionTokens(usage);
			if (remaining <= 0) return { output, usage, turns: turn - 1 };
			const reportTool = tools.find(tool => tool.name === "report_state");
			if (turn === request.maxTurns && reportTool) {
				// Reserve the last model turn for a durable handoff. Without this, a
				// productive agent that keeps issuing tools through maxTurns exits with
				// no report, so the next round loses its frontier and repeats discovery.
				context.tools = [reportTool];
				reportReminderSent = true;
				context.messages.push({
					role: "user",
					content:
						"Final handoff turn: call report_state exactly once now. No other tools are available. Preserve completed evidence, open work, and the next concrete frontier; do not continue implementation in this turn.",
					timestamp: Date.now(),
				});
			}
			const stream = this.#models.streamSimple(model, context, {
				reasoning: request.model.reasoning,
				maxTokens: Math.max(1, Math.min(model.maxTokens, remaining)),
				cacheRetention: "long",
				...(request.sessionId ? { sessionId: request.sessionId } : {}),
				signal: request.signal,
			});
			for await (const event of stream) {
				if (event.type === "text_delta") request.onText?.(event.delta);
			}
			const message = await stream.result();
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				throw new Error(message.errorMessage ?? `Model stopped with ${message.stopReason}.`);
			}
			context.messages.push(message);
			const turnUsage = {
				...emptyUsage(),
				inputTokens: message.usage.input,
				outputTokens: message.usage.output,
				cacheReadTokens: message.usage.cacheRead,
				cacheWriteTokens: message.usage.cacheWrite,
				reasoningTokens: message.usage.reasoning ?? 0,
				costUsd: message.usage.cost.total,
			};
			usage.inputTokens += turnUsage.inputTokens;
			usage.outputTokens += turnUsage.outputTokens;
			usage.cacheReadTokens += turnUsage.cacheReadTokens;
			usage.cacheWriteTokens += turnUsage.cacheWriteTokens;
			usage.reasoningTokens += turnUsage.reasoningTokens;
			usage.costUsd += turnUsage.costUsd;
			await request.onUsage?.(turnUsage);
			output = message.content
				.filter(block => block.type === "text")
				.map(block => block.text)
				.join("\n")
				.trim();
			const calls = message.content.filter((block): block is ToolCall => block.type === "toolCall");
			if (calls.length === 0) {
				if (!reportReminderSent && turn < request.maxTurns && request.tools.some(tool => tool.name === "report_state")) {
					reportReminderSent = true;
					context.messages.push({
						role: "user",
						content:
							"Submit exactly one report_state tool call now. Preserve the evidence IDs and next frontier from the work you just completed; do not repeat the work.",
						timestamp: Date.now(),
					});
					continue;
				}
				return { output, usage, turns: turn };
			}
			for (const call of calls) {
				const neutralCall: ModelToolCall = {
					id: call.id,
					name: call.name,
					arguments: toolCallArguments(call),
				};
				await request.onToolCall?.(neutralCall);
				const result = await request.executeTool(neutralCall);
				context.messages.push({
					role: "toolResult",
					toolCallId: call.id,
					toolName: call.name,
					content: [{ type: "text", text: boundedToolResult(result.text) }],
					isError: result.isError,
					timestamp: Date.now(),
				});
				if (result.stop) return { output, usage, turns: turn };
				if (result.report) return { output, report: result.report, usage, turns: turn };
			}
		}
		return { output, usage, turns: request.maxTurns };
	}
}
