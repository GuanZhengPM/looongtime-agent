import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
	AuthOperationOptions,
	Credential,
	CredentialInfo,
	CredentialStore,
} from "@earendil-works/pi-ai";
import { longtimeHome } from "../paths";

interface CredentialFile {
	version: 1;
	credentials: Record<string, Credential>;
}

function credentialPath(): string {
	return path.join(longtimeHome(), "credentials.json");
}

function throwIfAborted(options?: AuthOperationOptions): void {
	if (options?.signal?.aborted) throw options.signal.reason ?? new Error("Credential operation aborted.");
}

export class FileCredentialStore implements CredentialStore {
	#chains = new Map<string, Promise<void>>();

	async #load(): Promise<CredentialFile> {
		try {
			const parsed = (await Bun.file(credentialPath()).json()) as CredentialFile;
			if (parsed.version !== 1 || typeof parsed.credentials !== "object") {
				throw new Error("Unsupported Longtime credential file.");
			}
			return parsed;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, credentials: {} };
			throw error;
		}
	}

	async #save(file: CredentialFile): Promise<void> {
		const target = credentialPath();
		await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
		const temporary = `${target}.${crypto.randomUUID()}.tmp`;
		await Bun.write(temporary, `${JSON.stringify(file, null, 2)}\n`);
		await fs.chmod(temporary, 0o600);
		await fs.rename(temporary, target);
	}

	async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		throwIfAborted(options);
		return structuredClone((await this.#load()).credentials[providerId]);
	}

	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		throwIfAborted(options);
		const file = await this.#load();
		return Object.entries(file.credentials)
			.map(([providerId, credential]) => ({ providerId, type: credential.type }))
			.sort((left, right) => left.providerId.localeCompare(right.providerId));
	}

	async modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		throwIfAborted(options);
		const previous = this.#chains.get(providerId) ?? Promise.resolve();
		const result = Promise.withResolvers<Credential | undefined>();
		const next = previous
			.catch(() => undefined)
			.then(async () => {
				throwIfAborted(options);
				const file = await this.#load();
				const current = file.credentials[providerId];
				const replacement = await fn(structuredClone(current));
				if (replacement !== undefined) {
					file.credentials[providerId] = structuredClone(replacement);
					await this.#save(file);
				}
				result.resolve(structuredClone(replacement ?? current));
			})
			.catch(error => result.reject(error));
		this.#chains.set(providerId, next.then(() => undefined));
		return await result.promise;
	}

	async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		throwIfAborted(options);
		const previous = this.#chains.get(providerId) ?? Promise.resolve();
		const next = previous.catch(() => undefined).then(async () => {
			const file = await this.#load();
			if (!(providerId in file.credentials)) return;
			delete file.credentials[providerId];
			await this.#save(file);
		});
		this.#chains.set(providerId, next);
		await next;
	}
}
