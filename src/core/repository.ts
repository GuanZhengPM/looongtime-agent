import * as fs from "node:fs/promises";
import * as path from "node:path";
import { looongtimeHome } from "../paths";
import type { RunEvent, RunState } from "./types";
import { compactRunState, normalizeRunState } from "./state";

const LEASE_HEARTBEAT_MS = 15_000;
const LEASE_INITIALIZATION_GRACE_MS = 30_000;

interface LeaseRecord {
	token: string;
	pid: number;
	acquiredAt: number;
	heartbeatAt: number;
}

function assertSafeRunId(runId: string): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(runId) || runId === "." || runId === "..") {
		throw new Error("Run id must be a safe single path segment.");
	}
}

export interface RunLease {
	release(): Promise<void>;
}

function workspaceKey(workspace: string): string {
	return new Bun.CryptoHasher("sha256").update(path.resolve(workspace)).digest("hex").slice(0, 16);
}

async function atomicWriteJson(file: string, value: unknown): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	const temporary = `${file}.${crypto.randomUUID()}.tmp`;
	const handle = await fs.open(temporary, "wx", 0o600);
	let renamed = false;
	try {
		try {
			await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await fs.rename(temporary, file);
		renamed = true;
		await fs.chmod(file, 0o600);
		await syncDirectory(path.dirname(file));
	} finally {
		if (!renamed) await fs.unlink(temporary).catch(() => {});
	}
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

export class RunRepository {
	readonly runDirectory: string;
	readonly statePath: string;
	readonly stateBackupPath: string;
	readonly eventsPath: string;
	readonly leasePath: string;

	constructor(workspace: string, runId: string) {
		assertSafeRunId(runId);
		this.runDirectory = path.join(looongtimeHome(), "runs", workspaceKey(workspace), runId);
		this.statePath = path.join(this.runDirectory, "state.json");
		this.stateBackupPath = path.join(this.runDirectory, "state.prev.json");
		this.eventsPath = path.join(this.runDirectory, "events.jsonl");
		this.leasePath = path.join(this.runDirectory, "run.lock");
	}

	async save(state: RunState): Promise<void> {
		compactRunState(state);
		state.updatedAt = Date.now();
		try {
			const current = (await Bun.file(this.statePath).json()) as { version?: unknown };
			if (current.version === 1) {
				await fs.copyFile(this.statePath, this.stateBackupPath);
				await fs.chmod(this.stateBackupPath, 0o600);
				await syncDirectory(this.runDirectory);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
		}
		await atomicWriteJson(this.statePath, state);
	}

	async load(): Promise<RunState> {
		let parsed: RunState;
		try {
			parsed = (await Bun.file(this.statePath).json()) as RunState;
		} catch (primaryError) {
			try {
				parsed = (await Bun.file(this.stateBackupPath).json()) as RunState;
			} catch {
				throw new Error("The current run snapshot is unreadable and no valid previous snapshot is available.", {
					cause: primaryError,
				});
			}
		}
		if (parsed.version !== 1) throw new Error(`Unsupported run state version: ${String(parsed.version)}`);
		parsed.eventSequence = Math.max(parsed.eventSequence, await this.#lastEventSequence());
		return normalizeRunState(parsed);
	}

	async #lastEventSequence(): Promise<number> {
		let handle: fs.FileHandle;
		try {
			handle = await fs.open(this.eventsPath, "r+");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
			throw error;
		}
		try {
			const stat = await handle.stat();
			const length = Math.min(stat.size, 128 * 1_024);
			if (length === 0) return 0;
			let buffer = Buffer.alloc(length);
			const start = stat.size - length;
			await handle.read(buffer, 0, length, start);
			if (buffer.at(-1) !== 0x0a) {
				const lastNewline = buffer.lastIndexOf(0x0a);
				if (lastNewline < 0 && start > 0) {
					throw new Error("Truncated event tail exceeds the reconciliation window.");
				}
				const validLength = lastNewline + 1;
				await handle.truncate(start + validLength);
				await handle.sync();
				buffer = buffer.subarray(0, validLength);
			}
			let text = buffer.toString("utf8");
			if (length < stat.size) text = text.slice(text.indexOf("\n") + 1);
			const lines = text.split("\n");
			for (let index = lines.length - 1; index >= 0; index -= 1) {
				const line = lines[index];
				if (!line) continue;
					try {
						return (JSON.parse(line) as RunEvent).sequence;
					} catch (error) {
						throw new Error(`Corrupt event log near byte ${stat.size - length}.`, { cause: error });
				}
			}
			return 0;
		} finally {
			await handle.close();
		}
	}

	async acquireLease(): Promise<RunLease> {
		await fs.mkdir(this.runDirectory, { recursive: true });
		for (let attempt = 0; attempt < 650; attempt += 1) {
			try {
				const handle = await fs.open(this.leasePath, "wx+", 0o600);
				const token = crypto.randomUUID();
				const acquiredAt = Date.now();
				let released = false;
				let pending = Promise.resolve();
				const writeHeartbeat = async (): Promise<void> => {
					const record: LeaseRecord = { token, pid: process.pid, acquiredAt, heartbeatAt: Date.now() };
					await handle.truncate(0);
					await handle.write(`${JSON.stringify(record)}\n`, 0, "utf8");
					await handle.sync();
				};
				await writeHeartbeat();
				const timer = setInterval(() => {
					pending = pending.then(async () => {
						if (!released) await writeHeartbeat();
					}).catch(() => {});
				}, LEASE_HEARTBEAT_MS);
				timer.unref();
				return {
					release: async () => {
						if (released) return;
						released = true;
						clearInterval(timer);
						await pending;
						await handle.close();
						try {
							const current = JSON.parse(await Bun.file(this.leasePath).text()) as LeaseRecord;
							if (current.token === token) await fs.unlink(this.leasePath);
						} catch (error) {
							if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
						}
					},
				};
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				let owner: LeaseRecord | undefined;
				try {
					owner = JSON.parse(await Bun.file(this.leasePath).text()) as LeaseRecord;
				} catch {}
				if (owner) {
					if (processIsAlive(owner.pid)) throw new Error(`Run is already active in process ${owner.pid}.`);
					await fs.unlink(this.leasePath).catch(unlinkError => {
						if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
					});
					continue;
				}
				let ageMs = 0;
				try {
					ageMs = Date.now() - (await fs.stat(this.leasePath)).mtimeMs;
				} catch (statError) {
					if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
					throw statError;
				}
				if (ageMs >= LEASE_INITIALIZATION_GRACE_MS) {
					await fs.unlink(this.leasePath).catch(unlinkError => {
						if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
					});
					continue;
				}
				await new Promise(resolve => setTimeout(resolve, 50));
			}
		}
		throw new Error("Unable to acquire the run lease.");
	}

	async append(state: RunState, type: RunEvent["type"], payload: Record<string, unknown>): Promise<RunEvent> {
		const sequence = state.eventSequence + 1;
		const event: RunEvent = {
			id: crypto.randomUUID(),
			runId: state.id,
			sequence,
			at: Date.now(),
			type,
			payload,
		};
		await fs.mkdir(this.runDirectory, { recursive: true, mode: 0o700 });
		const handle = await fs.open(this.eventsPath, "a", 0o600);
		try {
			await handle.chmod(0o600);
			await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		state.eventSequence = sequence;
		return event;
	}

	async readEvents(): Promise<RunEvent[]> {
		let text: string;
		try {
			text = await Bun.file(this.eventsPath).text();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const lines = text.split("\n");
		const lastContentIndex = lines.length - (text.endsWith("\n") ? 2 : 1);
		const events: RunEvent[] = [];
		for (const [index, line] of lines.entries()) {
			if (!line) continue;
			try {
				events.push(JSON.parse(line) as RunEvent);
			} catch (error) {
				if (index === lastContentIndex && !text.endsWith("\n")) break;
				throw new Error(`Corrupt event log at line ${index + 1}.`, { cause: error });
			}
		}
		return events;
	}

	static async find(runId: string): Promise<RunRepository> {
		assertSafeRunId(runId);
		const root = path.join(looongtimeHome(), "runs");
		try {
			await fs.access(root);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Run '${runId}' was not found.`);
			throw error;
		}
		const snapshotMatches = [
			...new Bun.Glob(`*/${runId}/state.json`).scanSync({ cwd: root, absolute: true }),
			...new Bun.Glob(`*/${runId}/state.prev.json`).scanSync({ cwd: root, absolute: true }),
		];
		const runDirectories = [...new Set(snapshotMatches.map(file => path.dirname(file)))];
		if (runDirectories.length === 0) throw new Error(`Run '${runId}' was not found.`);
		if (runDirectories.length > 1) throw new Error(`Run id '${runId}' is ambiguous.`);
		const runDirectory = runDirectories[0] as string;
		let state: RunState;
		try {
			state = (await Bun.file(path.join(runDirectory, "state.json")).json()) as RunState;
		} catch (primaryError) {
			try {
				state = (await Bun.file(path.join(runDirectory, "state.prev.json")).json()) as RunState;
			} catch {
				throw new Error(`Run '${runId}' has no readable state snapshot.`, { cause: primaryError });
			}
		}
		if (state.id !== runId) throw new Error(`Run snapshot id '${state.id}' does not match '${runId}'.`);
		return new RunRepository(state.workspace, state.id);
	}
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
