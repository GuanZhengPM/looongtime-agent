import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { EvidenceKind } from "../core/types";
import type { ShellRisk } from "./types";

const MAX_OUTPUT_CHARACTERS = 60_000;
const SNAPSHOT_EXCLUDED_DIRECTORIES = new Set([
	".cache",
	".longtime",
	".continuum",
	".git",
	".gocache",
	".gomodcache",
	".mypy_cache",
	".pytest_cache",
	".ruff_cache",
	"node_modules",
]);
const SNAPSHOT_EXCLUDED_FILE_SUFFIXES = [".gcda", ".gcno", ".o", ".obj", ".pyc"];
const HIGH_RISK_COMMANDS = [
	/\b(?:sudo|su)\b/i,
	/\brm\s+(?:-[^\s]*[rf][^\s]*\s+)+/i,
	/\bgit\s+(?:push|reset\s+--hard|clean\s+-[^\s]*f)/i,
	/\b(?:npm|pnpm|yarn|bun)\s+publish\b/i,
	/\b(?:docker|podman)\s+push\b/i,
	/\bkubectl\s+(?:apply|delete|replace|patch|create)\b/i,
	/\bterraform\s+(?:apply|destroy)\b/i,
	/\bcurl\b[^\n]*(?:-X|--request)\s*(?:POST|PUT|PATCH|DELETE)\b/i,
	/\b(?:dd|mkfs|shutdown|reboot)\b/i,
	/\bchmod\s+(?:-[^\s]+\s+)?777\b/i,
];
const LOW_RISK_COMMANDS = [
	/^\s*(?:git\s+(?:status|diff|log|show)|pwd|ls|find|rg|grep|sed|head|tail|wc|cat)\b/i,
	/\b(?:test|check|lint|typecheck|build)\b/i,
	/^\s*(?:bun|npm|pnpm|yarn)\s+(?:test|run\s+(?:test|check|lint|typecheck|build))\b/i,
	/^\s*(?:cargo\s+(?:test|check|clippy|build)|go\s+test|pytest|python\s+-m\s+pytest)\b/i,
];

function within(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function hashText(text: string): string {
	return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

export function classifyShellRisk(command: string): ShellRisk {
	if (HIGH_RISK_COMMANDS.some(pattern => pattern.test(command))) return "high";
	if (LOW_RISK_COMMANDS.some(pattern => pattern.test(command))) return "low";
	return "medium";
}

export function shellEvidenceKind(command: string): EvidenceKind {
	const segments = command.split(/&&|\|\||[;\n]/);
	const executesTests = segments.some(segment => {
		if (/\bgo\s+test\b/i.test(segment)) return !/(?:^|\s)-list(?:=|\s|$)/i.test(segment);
		if (/\bcargo\s+test\b/i.test(segment)) return !/(?:^|\s)--no-run(?:\s|$)/i.test(segment);
		if (/\bpytest\b|\bpython3?\s+-m\s+pytest\b/i.test(segment)) {
			return !/(?:^|\s)--collect-only(?:\s|$)/i.test(segment);
		}
		return /\b(?:bun|npm|pnpm|yarn)\s+(?:test|run\s+test)\b/i.test(segment);
	});
	if (executesTests) return "test";
	if (
		/\bgo\s+(?:build|vet)\b|\bcargo\s+(?:build|check|clippy)\b|\b(?:bun|npm|pnpm|yarn)\s+run\s+(?:build|check|lint|typecheck)\b|\b(?:make|gmake)(?:\s|$)|\bcmake\s+--build\b|\btsc\b/i.test(
			command,
		)
	)
		return "build";
	return "command";
}

export function shellSandboxAvailable(): boolean {
	return (
		inheritedSandboxActive() ||
		(process.platform === "darwin" && Boolean(Bun.which("sandbox-exec"))) ||
		(process.platform === "linux" && Boolean(Bun.which("bwrap")))
	);
}

function inheritedSandboxActive(): boolean {
	return (
		Boolean(process.env.CODEX_SANDBOX) ||
		process.env.LONGTIME_INHERITED_SANDBOX === "1" ||
		process.env.CONTINUUM_INHERITED_SANDBOX === "1"
	);
}

export class Workspace {
	readonly root: string;

	private constructor(root: string) {
		this.root = root;
	}

	static async open(root: string): Promise<Workspace> {
		return new Workspace(await fs.realpath(path.resolve(root)));
	}

	async resolveExisting(input: string): Promise<string> {
		const lexical = path.resolve(this.root, input);
		if (!within(this.root, lexical)) throw new Error(`Path is outside the workspace: ${input}`);
		const canonical = await fs.realpath(lexical);
		if (!within(this.root, canonical)) throw new Error(`Path resolves outside the workspace: ${input}`);
		return canonical;
	}

	async resolveWritable(input: string): Promise<string> {
		const lexical = path.resolve(this.root, input);
		if (!within(this.root, lexical)) throw new Error(`Path is outside the workspace: ${input}`);
		let ancestor = path.dirname(lexical);
		while (true) {
			try {
				const canonical = await fs.realpath(ancestor);
				if (!within(this.root, canonical)) throw new Error(`Parent resolves outside the workspace: ${input}`);
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				const parent = path.dirname(ancestor);
				if (parent === ancestor) throw error;
				ancestor = parent;
			}
		}
		try {
			const existing = await fs.realpath(lexical);
			if (!within(this.root, existing)) throw new Error(`Path resolves outside the workspace: ${input}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		return lexical;
	}

	relative(absolute: string): string {
		return path.relative(this.root, absolute) || ".";
	}

	async snapshot(): Promise<Map<string, string>> {
		const snapshot = new Map<string, string>();
		const visit = async (directory: string): Promise<void> => {
			let entries: import("node:fs").Dirent[];
			try {
				entries = await fs.readdir(directory, { withFileTypes: true });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
				throw error;
			}
			entries.sort((left, right) => left.name.localeCompare(right.name));
				for (const entry of entries) {
					if (entry.isDirectory() && SNAPSHOT_EXCLUDED_DIRECTORIES.has(entry.name)) continue;
					if (!entry.isDirectory() && SNAPSHOT_EXCLUDED_FILE_SUFFIXES.some(suffix => entry.name.endsWith(suffix))) {
						continue;
					}
				const absolute = path.join(directory, entry.name);
				const relative = this.relative(absolute);
				try {
					if (entry.isDirectory()) {
						snapshot.set(`${relative}${path.sep}`, "directory");
						await visit(absolute);
					} else if (entry.isSymbolicLink()) {
						snapshot.set(relative, `symlink:${await fs.readlink(absolute)}`);
					} else {
						const stat = await fs.stat(absolute, { bigint: true });
						snapshot.set(relative, `file:${stat.size}:${stat.mtimeNs}`);
					}
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
			}
		};
		await visit(this.root);
		return snapshot;
	}

	async changesSince(before: ReadonlyMap<string, string>): Promise<string[]> {
		const after = await this.snapshot();
		const paths = new Set([...before.keys(), ...after.keys()]);
		return [...paths].filter(item => before.get(item) !== after.get(item)).sort();
	}
}

function bounded(text: string): string {
	if (text.length <= MAX_OUTPUT_CHARACTERS) return text;
	const half = Math.floor(MAX_OUTPUT_CHARACTERS / 2);
	return `${text.slice(0, half)}\n… ${text.length - MAX_OUTPUT_CHARACTERS} characters omitted …\n${text.slice(-half)}`;
}

class BoundedStreamCapture {
	#content = "";
	#prefix = "";
	#suffix = "";
	#totalCharacters = 0;
	#truncated = false;

	append(text: string): void {
		if (!text) return;
		this.#totalCharacters += text.length;
		const half = Math.floor(MAX_OUTPUT_CHARACTERS / 2);
		if (!this.#truncated) {
			const combined = this.#content + text;
			if (combined.length <= MAX_OUTPUT_CHARACTERS) {
				this.#content = combined;
				return;
			}
			this.#truncated = true;
			this.#prefix = combined.slice(0, half);
			this.#suffix = combined.slice(-half);
			this.#content = "";
			return;
		}
		this.#suffix = (this.#suffix + text).slice(-half);
	}

	text(): string {
		if (!this.#truncated) return this.#content;
		return `${this.#prefix}\n… ${this.#totalCharacters - MAX_OUTPUT_CHARACTERS} characters omitted while streaming …\n${this.#suffix}`;
	}
}

async function captureStream(stream: ReadableStream<Uint8Array>): Promise<string> {
	const capture = new BoundedStreamCapture();
	const decoder = new TextDecoder();
	const reader = stream.getReader();
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		capture.append(decoder.decode(value, { stream: true }));
	}
	capture.append(decoder.decode());
	return capture.text();
}

async function linuxDescendants(pid: number): Promise<number[]> {
	const descendants: number[] = [];
	const visit = async (parent: number): Promise<void> => {
		let text = "";
		try {
			text = await Bun.file(`/proc/${parent}/task/${parent}/children`).text();
		} catch {
			return;
		}
		for (const token of text.trim().split(/\s+/)) {
			if (!token) continue;
			const child = Number(token);
			if (!Number.isSafeInteger(child) || child <= 0) continue;
			await visit(child);
			descendants.push(child);
		}
	};
	await visit(pid);
	return descendants;
}

async function posixDescendants(pid: number): Promise<number[]> {
	if (process.platform === "linux") return await linuxDescendants(pid);
	const result = Bun.spawnSync(["/bin/ps", "-axo", "pid=,ppid="]);
	if (result.exitCode !== 0) return [];
	const children = new Map<number, number[]>();
	for (const line of result.stdout.toString().split("\n")) {
		const [rawPid, rawParent] = line.trim().split(/\s+/);
		const child = Number(rawPid);
		const parent = Number(rawParent);
		if (!Number.isSafeInteger(child) || !Number.isSafeInteger(parent)) continue;
		children.set(parent, [...(children.get(parent) ?? []), child]);
	}
	const descendants: number[] = [];
	const visit = (parent: number): void => {
		for (const child of children.get(parent) ?? []) {
			visit(child);
			descendants.push(child);
		}
	};
	visit(pid);
	return descendants;
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(pid, signal);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

async function terminateProcessTree(pid: number): Promise<void> {
	if (process.platform === "win32") {
		signalProcess(pid, "SIGTERM");
		return;
	}
	const descendants = await posixDescendants(pid);
	for (const descendant of descendants) signalProcess(descendant, "SIGTERM");
	signalProcess(pid, "SIGTERM");
	await new Promise(resolve => setTimeout(resolve, 500));
	for (const target of [...descendants, pid]) {
		try {
			process.kill(target, 0);
			signalProcess(target, "SIGKILL");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	}
}

function shellEnvironment(toolCacheRoot: string): Record<string, string> {
	const allowed = new Set([
		"BUN_INSTALL",
		"CI",
		"COLORTERM",
		"CODEX_SANDBOX",
		"CODEX_SANDBOX_NETWORK_DISABLED",
		"LONGTIME_INHERITED_SANDBOX",
		"CONTINUUM_INHERITED_SANDBOX",
		"FORCE_COLOR",
		"HOME",
		"LANG",
		"LANGUAGE",
		"LC_ALL",
		"LOGNAME",
		"NO_COLOR",
		"PATH",
		"SHELL",
		"TERM",
		"TMPDIR",
		"USER",
	]);
	return {
		...Object.fromEntries(
		Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && allowed.has(entry[0])),
		),
		// Sandboxed build tools cannot write to the user's global cache directories.
		// Keep their disposable caches in the already-writable system temp root so
		// dependency downloads neither fail nor masquerade as source mutations.
		GOCACHE: path.join(toolCacheRoot, "go-build"),
		GOMODCACHE: path.join(toolCacheRoot, "go-mod"),
		XDG_CACHE_HOME: path.join(toolCacheRoot, "xdg"),
		npm_config_cache: path.join(toolCacheRoot, "npm"),
		PIP_CACHE_DIR: path.join(toolCacheRoot, "pip"),
		UV_CACHE_DIR: path.join(toolCacheRoot, "uv"),
		BUN_INSTALL_CACHE_DIR: path.join(toolCacheRoot, "bun"),
	};
}

interface ShellInvocation {
	argv: string[];
	sandboxed: boolean;
}

export function shellCommandInvocation(
	command: string,
	platform: NodeJS.Platform = process.platform,
	which: (name: string) => string | null = Bun.which,
): string[] {
	if (platform === "win32") return ["powershell.exe", "-NoProfile", "-Command", command];
	if (platform === "darwin") return ["/bin/zsh", "-lc", command];
	return [which("bash") ?? "/bin/sh", "-lc", command];
}

async function sandboxedInvocation(command: string, cwd: string): Promise<ShellInvocation> {
	const base = shellCommandInvocation(command);
	if (inheritedSandboxActive()) {
		return { argv: base, sandboxed: true };
	}
	if (process.platform === "darwin" && Bun.which("sandbox-exec")) {
		const home = os.homedir();
		const temporary = await fs.realpath(os.tmpdir());
		const sensitiveDirectories = [
			path.join(home, ".ssh"),
			path.join(home, ".aws"),
			path.join(home, ".gnupg"),
			path.join(home, ".config", "gcloud"),
			path.join(home, ".codex"),
			path.join(home, ".claude"),
		];
		const sensitiveFiles = [path.join(home, ".npmrc"), path.join(home, ".netrc")];
		const profile = [
			"(version 1)",
			"(allow default)",
			"(deny file-write*)",
			`(allow file-write* (subpath ${JSON.stringify(cwd)}) (subpath ${JSON.stringify(temporary)}) (literal \"/dev/null\"))`,
			...sensitiveDirectories.map(item => `(deny file-read* (subpath ${JSON.stringify(item)}))`),
			...sensitiveFiles.map(item => `(deny file-read* (literal ${JSON.stringify(item)}))`),
		].join("\n");
		return { argv: ["/usr/bin/sandbox-exec", "-p", profile, ...base], sandboxed: true };
	}
	if (process.platform === "linux" && Bun.which("bwrap")) {
		const home = os.homedir();
		const temporary = await fs.realpath(os.tmpdir());
		const masks: string[] = [];
		for (const candidate of [
			path.join(home, ".ssh"),
			path.join(home, ".aws"),
			path.join(home, ".gnupg"),
			path.join(home, ".config", "gcloud"),
			path.join(home, ".codex"),
			path.join(home, ".claude"),
		]) {
			try {
				if ((await fs.lstat(candidate)).isDirectory()) masks.push("--tmpfs", candidate);
			} catch {}
		}
		return {
			argv: [
				"bwrap",
				"--die-with-parent",
				"--ro-bind",
				"/",
				"/",
				"--bind",
				cwd,
				cwd,
				"--bind",
				temporary,
				temporary,
				"--dev-bind",
				"/dev",
				"/dev",
				"--proc",
				"/proc",
				...masks,
				"--chdir",
				cwd,
				...base,
			],
			sandboxed: true,
		};
	}
	return { argv: base, sandboxed: false };
}

export async function runShell(options: {
	command: string;
	cwd: string;
	timeoutSeconds: number;
	signal: AbortSignal;
	sandbox: boolean;
}): Promise<{ output: string; exitCode: number; sandboxed: boolean }> {
	const timeout = AbortSignal.timeout(Math.round(options.timeoutSeconds * 1000));
	const signal = AbortSignal.any([options.signal, timeout]);
	const invocation = options.sandbox
		? await sandboxedInvocation(options.command, options.cwd)
		: { argv: shellCommandInvocation(options.command), sandboxed: inheritedSandboxActive() };
	const toolCacheRoot = path.join(os.tmpdir(), "longtime-tool-cache", hashText(options.cwd).slice(0, 16));
	await fs.mkdir(toolCacheRoot, { recursive: true });
	const child = Bun.spawn(invocation.argv, {
		cwd: options.cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: shellEnvironment(toolCacheRoot),
	});
	let termination: Promise<void> | undefined;
	const onAbort = (): void => {
		termination ??= terminateProcessTree(child.pid);
	};
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			captureStream(child.stdout),
			captureStream(child.stderr),
			child.exited,
		]);
		return {
			output: bounded(`${stdout}${stdout && stderr ? "\n" : ""}${stderr}\nExit code: ${exitCode}`),
			exitCode,
			sandboxed: invocation.sandboxed,
		};
	} finally {
		if (termination) await termination;
		signal.removeEventListener("abort", onAbort);
	}
}
