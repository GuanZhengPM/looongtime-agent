import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
	AuthOperationOptions,
	Credential,
	CredentialInfo,
	CredentialStore,
} from "@earendil-works/pi-ai";
import { looongtimeHome } from "../paths";

interface CredentialFile {
	version: 1;
	credentials: Record<string, Credential>;
}

const CORRUPT_LOCK_GRACE_MS = 5_000;

function credentialPath(): string {
	return path.join(looongtimeHome(), "credentials.json");
}

function credentialLockPath(): string {
	return `${credentialPath()}.lock`;
}

async function syncDirectory(directory: string): Promise<void> {
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(directory, "r");
		await handle.sync();
	} catch (error) {
		if (!new Set(["EINVAL", "ENOTSUP", "EPERM", "EISDIR"]).has((error as NodeJS.ErrnoException).code ?? "")) {
			throw error;
		}
	} finally {
		await handle?.close();
	}
}

function throwIfAborted(options?: AuthOperationOptions): void {
	if (options?.signal?.aborted) throw options.signal.reason ?? new Error("Credential operation aborted.");
}

function processIsAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export class FileCredentialStore implements CredentialStore {
	#chain: Promise<void> = Promise.resolve();

	async #withFileLock<T>(operation: () => Promise<T>, options?: AuthOperationOptions): Promise<T> {
		const target = credentialLockPath();
		await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
		const token = crypto.randomUUID();
		// OAuth refresh callbacks may legitimately involve a network round trip.
		// Wait up to 30 seconds rather than failing a second process after 5 seconds.
		for (let attempt = 0; attempt < 600; attempt += 1) {
			throwIfAborted(options);
			try {
				const handle = await fs.open(target, "wx", 0o600);
				try {
					await handle.writeFile(`${JSON.stringify({ token, pid: process.pid, at: Date.now() })}\n`, "utf8");
					await handle.sync();
					return await operation();
				} finally {
					await handle.close();
					try {
						const current = JSON.parse(await Bun.file(target).text()) as { token?: string };
						if (current.token === token) await fs.unlink(target);
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					}
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				try {
					const owner = JSON.parse(await Bun.file(target).text()) as { pid?: number };
					if (typeof owner.pid === "number" && !processIsAlive(owner.pid)) {
						await fs.unlink(target);
						continue;
					}
				} catch {
					try {
						if (Date.now() - (await fs.stat(target)).mtimeMs >= CORRUPT_LOCK_GRACE_MS) {
							await fs.unlink(target);
							continue;
						}
					} catch (statError) {
						if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
						throw statError;
					}
				}
				await new Promise<void>((resolve, reject) => {
					const signal = options?.signal;
					const timer = setTimeout(() => {
						signal?.removeEventListener("abort", onAbort);
						resolve();
					}, 50);
					const onAbort = (): void => {
						clearTimeout(timer);
						signal?.removeEventListener("abort", onAbort);
						reject(signal?.reason ?? new Error("Credential operation aborted."));
					};
					signal?.addEventListener("abort", onAbort, { once: true });
				});
			}
		}
		throw new Error("Timed out waiting for the credential store lock.");
	}

	async #load(): Promise<CredentialFile> {
		try {
			const parsed = (await Bun.file(credentialPath()).json()) as CredentialFile;
			if (parsed.version !== 1 || typeof parsed.credentials !== "object") {
				throw new Error("Unsupported Looongtime credential file.");
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
		const handle = await fs.open(temporary, "wx", 0o600);
		let renamed = false;
		try {
			try {
				await handle.writeFile(`${JSON.stringify(file, null, 2)}\n`, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			await fs.rename(temporary, target);
			renamed = true;
			await fs.chmod(target, 0o600);
			await syncDirectory(path.dirname(target));
		} finally {
			if (!renamed) await fs.unlink(temporary).catch(() => {});
		}
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
		const operation = this.#chain
			.catch(() => undefined)
			.then(async () => await this.#withFileLock(async () => {
				const file = await this.#load();
				const current = file.credentials[providerId];
				const replacement = await fn(structuredClone(current));
				if (replacement !== undefined) {
					file.credentials[providerId] = structuredClone(replacement);
					await this.#save(file);
				}
				return structuredClone(replacement ?? current);
			}, options));
		this.#chain = operation.then(() => undefined);
		return await operation;
	}

	async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		throwIfAborted(options);
		const next = this.#chain.catch(() => undefined).then(async () => await this.#withFileLock(async () => {
			const file = await this.#load();
			if (!(providerId in file.credentials)) return;
			delete file.credentials[providerId];
			await this.#save(file);
		}, options));
		this.#chain = next;
		await next;
	}
}
