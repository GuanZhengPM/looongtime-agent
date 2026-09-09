import * as readline from "node:readline/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AuthInteraction, AuthPrompt, AuthType } from "@earendil-works/pi-ai";
import type { PiModelsPort } from "./pi-models";
import { FileCredentialStore } from "./credential-store";

interface CodexAuthFile {
	tokens?: {
		access_token?: string;
		refresh_token?: string;
		account_id?: string;
	};
}

function jwtExpiresAt(token: string): number {
	try {
		const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as {
			exp?: number;
		};
		if (typeof payload.exp === "number" && Number.isFinite(payload.exp)) return payload.exp * 1_000;
	} catch {}
	throw new Error("Codex access token has no readable expiry; run 'codex login' again before importing.");
}

export async function importCodexCliAuth(): Promise<void> {
	const codexHome = path.resolve(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"));
	const source = path.join(codexHome, "auth.json");
	const parsed = (await Bun.file(source).json()) as CodexAuthFile;
	const access = parsed.tokens?.access_token;
	const refresh = parsed.tokens?.refresh_token;
	if (!access || !refresh) throw new Error(`No ChatGPT OAuth tokens were found in ${source}. Run 'codex login' first.`);
	await new FileCredentialStore().modify("openai-codex", async () => ({
		type: "oauth",
		access,
		refresh,
		expires: jwtExpiresAt(access),
		...(parsed.tokens?.account_id ? { accountId: parsed.tokens.account_id } : {}),
	}));
}

async function readLine(message: string): Promise<string> {
	const prompt = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
	try {
		return await prompt.question(`${message} `);
	} finally {
		prompt.close();
	}
}

async function readSecret(message: string, signal?: AbortSignal): Promise<string> {
	if (!process.stdin.isTTY || !process.stderr.isTTY) throw new Error("Secret prompts require an interactive terminal.");
	process.stderr.write(`${message} `);
	const result = Promise.withResolvers<string>();
	let value = "";
	const onAbort = (): void => result.reject(signal?.reason ?? new Error("Authentication cancelled."));
	const onData = (data: Buffer): void => {
		for (const byte of data) {
			if (byte === 3) {
				result.reject(new Error("Authentication cancelled."));
				return;
			}
			if (byte === 13 || byte === 10) {
				result.resolve(value);
				return;
			}
			if (byte === 127 || byte === 8) {
				if (value.length > 0) {
					value = value.slice(0, -1);
					process.stderr.write("\b \b");
				}
				continue;
			}
			if (byte >= 32 && byte <= 126) {
				value += String.fromCharCode(byte);
				process.stderr.write("*");
			}
		}
	};
	const wasRaw = process.stdin.isRaw;
	process.stdin.setRawMode(true);
	process.stdin.resume();
	process.stdin.on("data", onData);
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		return await result.promise;
	} finally {
		process.stdin.off("data", onData);
		signal?.removeEventListener("abort", onAbort);
		process.stdin.setRawMode(Boolean(wasRaw));
		process.stderr.write("\n");
	}
}

async function answerPrompt(prompt: AuthPrompt): Promise<string> {
	if (prompt.type === "secret") return await readSecret(prompt.message, prompt.signal);
	if (prompt.type === "select") {
		process.stderr.write(`${prompt.message}\n`);
		for (const [index, option] of prompt.options.entries()) {
			process.stderr.write(`  ${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}\n`);
		}
		const answer = await readLine("Select number:");
		if (!answer.trim()) return prompt.options[0]?.id ?? "";
		const index = Number(answer) - 1;
		const option = prompt.options[index];
		if (!option) throw new Error("Invalid selection.");
		return option.id;
	}
	return await readLine(`${prompt.message}${prompt.placeholder ? ` (${prompt.placeholder})` : ""}:`);
}

function interaction(): AuthInteraction {
	return {
		prompt: answerPrompt,
		notify(event) {
			if (event.type === "info") {
				process.stderr.write(`${event.message}\n`);
				for (const link of event.links ?? []) process.stderr.write(`${link.label ?? "Open"}: ${link.url}\n`);
			} else if (event.type === "auth_url") {
				process.stderr.write(`${event.instructions ?? "Open this URL"}: ${event.url}\n`);
			} else if (event.type === "device_code") {
				process.stderr.write(`Open ${event.verificationUri} and enter code ${event.userCode}\n`);
			} else {
				process.stderr.write(`${event.message}\n`);
			}
		},
	};
}

function parseAuthType(value: string | undefined): AuthType | undefined {
	if (value === undefined) return undefined;
	if (value === "api_key" || value === "oauth") return value;
	throw new Error("Auth type must be api_key or oauth.");
}

function formatAuthMethod(input: { name: string; interactive?: boolean; subscription?: boolean } | undefined): string {
	if (!input) return "-";
	const details = [input.interactive === false ? "env/ambient" : undefined, input.subscription ? "subscription" : undefined]
		.filter(Boolean)
		.join(", ");
	return details ? `${input.name} (${details})` : input.name;
}

async function selectAuthType(
	methods: ReturnType<PiModelsPort["authMethods"]>,
	rawType: string | undefined,
): Promise<AuthType> {
	const explicit = parseAuthType(rawType);
	if (explicit) return explicit;
	if (methods.oauth && !methods.apiKey) return "oauth";
	if (methods.apiKey && !methods.oauth) return "api_key";
	if (!methods.apiKey && !methods.oauth) throw new Error("This provider has no interactive login method.");
	if (!process.stdin.isTTY || !process.stderr.isTTY) {
		throw new Error("This provider supports both api_key and oauth; specify one explicitly.");
	}
	return (await answerPrompt({
		type: "select",
		message: "Choose an authentication method:",
		options: [
			{ id: "oauth", label: "OAuth", description: methods.oauth ?? "Provider OAuth" },
			{ id: "api_key", label: "API key", description: methods.apiKey ?? "Provider API key" },
		],
	})) as AuthType;
}

export async function runAuthCommand(port: PiModelsPort, args: string[]): Promise<void> {
	const [action, providerId, rawType] = args;
	if (action === "list") {
		if (providerId || rawType) throw new Error("Usage: looongtime auth list");
		process.stdout.write("PROVIDER\tMODELS\tAPI KEY\tOAUTH\n");
		for (const provider of port.listAuthProviders()) {
			process.stdout.write(
				`${provider.id}\t${provider.models}\t${formatAuthMethod(provider.apiKey)}\t${formatAuthMethod(provider.oauth)}\n`,
			);
		}
		return;
	}
	if (action === "import-codex") {
		if (providerId || rawType) throw new Error("Usage: looongtime auth import-codex");
		await importCodexCliAuth();
		process.stdout.write("Imported the current Codex CLI ChatGPT OAuth session for openai-codex.\n");
		return;
	}
	if (!action || !providerId) {
		throw new Error("Usage: looongtime auth list | looongtime auth <status|login|logout> <provider> [api_key|oauth]");
	}
	if (action === "status") {
		const status = await port.authStatus(providerId);
		process.stdout.write(
			`${JSON.stringify({ provider: providerId, configured: Boolean(status), verified: false, note: "Credential presence and refreshability only; the first model request verifies service acceptance.", type: status?.type, source: status?.source, methods: port.authMethods(providerId) }, null, 2)}\n`,
		);
		return;
	}
	if (action === "logout") {
		await port.logout(providerId);
		process.stdout.write(`Logged out ${providerId}.\n`);
		return;
	}
	if (action === "login") {
		const methods = port.authMethods(providerId);
		const type = await selectAuthType(methods, rawType);
		if (type === "oauth" && !methods.oauth) throw new Error(`Provider '${providerId}' does not offer OAuth login.`);
		if (type === "api_key" && !methods.apiKey) {
			throw new Error(`Provider '${providerId}' does not offer interactive API-key login; use its environment variables.`);
		}
		await port.login(providerId, type, interaction());
		process.stdout.write(`Authenticated ${providerId} with ${type}.\n`);
		return;
	}
	throw new Error(`Unknown auth action '${action}'.`);
}
