import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { EvidenceKind } from "../core/types";
import type { ShellRisk } from "./types";
import { longtimeHome } from "../paths";

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
	// Shell syntax that can hide a second command or write without going through
	// the snapshot-checked file tools. This is intentionally conservative: an
	// authorization prompt is cheaper than recovering an overwritten worktree.
	/`|\$\(|[<>]\(|>(?!&[012](?:\s|$))/,
	/(?:^|[\s;&|])tee\b/i,
	// Explicit workspace destruction, overwrite, permission changes, or
	// in-place editing. Plain `rm file` is just as irreversible for an untracked
	// file as `rm -rf`, so flags are deliberately not required here.
	/\b(?:rm|rmdir|unlink|shred|truncate)\b/i,
	/\b(?:mv|cp|patch)\b/i,
	/\b(?:chmod|chown|chgrp|setfacl)\b/i,
	/\bfind\b[^\n]*(?:-delete\b|-exec(?:dir)?\b)/i,
	/\bsed\b[^\n]*(?:\s-[A-Za-z]*i[A-Za-z]*\b|\s--in-place\b)/i,
	/\bperl\b[^\n]*\s-[A-Za-z]*i[A-Za-z]*\b/i,
	/\b(?:prettier\b[^\n]*--write\b|eslint\b[^\n]*--fix\b|gofmt\b[^\n]*-w\b)/i,
	/\b(?:tar\b[^\n]*\s-[A-Za-z]*x[A-Za-z]*|unzip\b)/i,
	/\b(?:sudo|su)\b/i,
	// Git commands that publish, rewrite history, discard changes, apply a
	// patch, move worktrees, or change remote configuration.
	/\bgit\s+(?:-[^\s]+\s+)*(?:push|commit|checkout|switch|restore|reset|clean|merge|rebase|cherry-pick|revert|apply|am)\b/i,
	/\bgit\s+(?:-[^\s]+\s+)*stash\s+(?:apply|pop|drop|clear|branch)\b/i,
	/\bgit\s+(?:-[^\s]+\s+)*(?:branch|tag)\b[^\n]*(?:-[dD]\b|--delete\b)/i,
	/\bgit\s+(?:-[^\s]+\s+)*worktree\s+(?:remove|move|prune)\b/i,
	/\bgit\s+(?:-[^\s]+\s+)*remote\s+(?:add|remove|rename|set-url)\b/i,
	/\bgit\s+(?:-[^\s]+\s+)*config\b/i,
	// Dependency installation can change lockfiles and execute lifecycle code.
	/\b(?:npm|pnpm|yarn|bun)\s+(?:install|add|remove|uninstall|update|upgrade|link|unlink|publish|exec|x)\b/i,
	/\b(?:npx|pnpx|bunx|uvx)\b/i,
	/\b(?:pip3?|uv)\s+(?:install|uninstall|sync)\b/i,
	/\b(?:cargo|go)\s+install\b/i,
	/\b(?:docker|podman|kubectl|terraform)\b/i,
	/\bcurl\b[^\n]*(?:-X|--request)\s*(?:POST|PUT|PATCH|DELETE)\b/i,
	/\b(?:dd|mkfs|shutdown|reboot)\b/i,
	/\b(?:curl|wget|nc|ncat|netcat|ssh|scp|sftp|rsync)\b/i,
	/\b(?:gh|aws|gcloud|az|helm|pulumi|vercel|netlify|flyctl|heroku|stripe|psql|mysql|mongosh|redis-cli)\b/i,
	/\b(?:bash|sh|zsh|fish|cmd|powershell|pwsh)\b[^\n]*(?:\s-c\b|\s-command\b)/i,
	/\b(?:python3?|node|ruby|perl|php|deno|bun)\b[^\n]*(?:\s-c\b|\s-e\b|\s-eval\b)/i,
	// Obvious host-boundary reads. The local sandbox masks common credential
	// stores, but classification must still request authority when a command
	// names a home path, parent traversal, or sensitive store explicitly.
	/(?:^|[\s"'=])(?:~(?:\/|$)|\.\.(?:\/|\\)|\$HOME\b|\$\{HOME\}|\/(?:Users|home|root|etc|private|Volumes)(?:\/|\b))/i,
	/(?:^|[\/\\])\.(?:ssh|aws|gnupg|codex|claude|longtime|continuum)(?:[\/\\]|\b)/i,
	/(?:^|[\/\\])\.(?:npmrc|netrc)(?:\b|$)|\/etc\/(?:shadow|sudoers)\b/i,
];
const LOW_RISK_COMMANDS = [
	/^\s*git\s+(?:status|diff|log|show|grep|rev-parse|ls-files|ls-tree|describe)\b/i,
	/^\s*(?:pwd|ls|find|rg|grep|sed|head|tail|wc|cat|file|stat|du|tree|sort|uniq|cut|tr|basename|dirname|realpath|which)\b/i,
	/^\s*(?:echo|printf)\b/i,
	/^\s*(?:bun|npm|pnpm|yarn)\s+(?:test|run\s+(?:test|check|lint|typecheck|build))\b/i,
	/^\s*(?:cargo\s+(?:test|check|clippy|build)|go\s+test|pytest|python\s+-m\s+pytest)\b/i,
	/^\s*(?:tsc\s+--noEmit|ruff\s+check|biome\s+check|mypy\b|prettier\b[^\n]*--check\b|eslint\b(?![^\n]*--fix\b)|go\s+vet\b|cargo\s+fmt\b[^\n]*--check\b)/i,
	/^\s*(?:make|gmake)\b[^\n]*(?:\s|^)(?:test|check|lint|typecheck|build)(?:\s|$)/i,
];
const MEDIUM_RISK_COMMANDS = [
	/^\s*(?:mkdir|touch)\b/i,
	/^\s*git\s+(?:add|init)\b/i,
];

function within(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function hashText(text: string): string {
	return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

export function fingerprintSnapshot(snapshot: ReadonlyMap<string, string>): string {
	const manifest = [...snapshot.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([file, descriptor]) => `${file}\u0000${descriptor}`)
		.join("\n");
	return hashText(manifest);
}

export function classifyShellRisk(command: string): ShellRisk {
	if (!command.trim()) return "high";
	// Only a conjunction of independently classified commands inherits their
	// maximum risk. Other shell control operators can mask failure, detach work,
	// or create data flows that static token matching cannot reason about.
	if (/\|\||[;\n]|(?<!\|)\|(?!\|)|(?<!&)&(?!&)/.test(command)) return "high";
	const conjunctions = command.split(/\s*&&\s*/);
	if (conjunctions.length > 1) {
		const risks = conjunctions.map(classifyShellRisk);
		if (risks.includes("high")) return "high";
		if (risks.includes("medium")) return "medium";
		return "low";
	}
	if (HIGH_RISK_COMMANDS.some(pattern => pattern.test(command))) return "high";
	if (LOW_RISK_COMMANDS.some(pattern => pattern.test(command))) return "low";
	if (MEDIUM_RISK_COMMANDS.some(pattern => pattern.test(command))) return "medium";
	// Unknown executables and non-standard scripts are code execution, not a
	// routine inspection. Requiring authority prevents a benign-looking prefix
	// or project-controlled wrapper from bypassing the policy.
	return "high";
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
		const relative = path.relative(this.root, lexical);
		let current = this.root;
		for (const segment of relative.split(path.sep).filter(Boolean)) {
			current = path.join(current, segment);
			try {
				const stat = await fs.lstat(current);
				if (stat.isSymbolicLink()) {
					throw new Error(`Writable path contains a symbolic link: ${input}`);
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
				throw error;
			}
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

	async fingerprint(): Promise<string> {
		const git = Bun.which("git");
		if (git) {
			try {
				await fs.access(path.join(this.root, ".git"));
				const run = (args: string[]): ReturnType<typeof Bun.spawnSync> => Bun.spawnSync([git, ...args], {
					cwd: this.root,
					stdout: "pipe",
					stderr: "ignore",
				});
				const head = run(["rev-parse", "HEAD"]);
				const index = run(["write-tree"]);
				const status = run(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
				const changed = run(["ls-files", "-m", "-o", "--exclude-standard", "-z"]);
				if ([head, index, status, changed].every(item => item.exitCode === 0)) {
					const hasher = new Bun.CryptoHasher("sha256");
					hasher.update(head.stdout ?? Buffer.alloc(0));
					hasher.update(index.stdout ?? Buffer.alloc(0));
					hasher.update(status.stdout ?? Buffer.alloc(0));
					for (const relative of (changed.stdout ?? Buffer.alloc(0)).toString().split("\0").filter(Boolean).sort()) {
						const file = path.join(this.root, relative);
						try {
							hasher.update(relative);
							const stat = await fs.lstat(file);
							if (stat.isSymbolicLink()) {
								hasher.update(`symlink:${await fs.readlink(file)}`);
							} else if (stat.isFile()) {
								const reader = Bun.file(file).stream().getReader();
								while (true) {
									const { done, value } = await reader.read();
									if (done) break;
									hasher.update(value);
								}
							} else {
								hasher.update(`other:${stat.mode}:${stat.size}`);
							}
						} catch (error) {
							if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
						}
					}
					return hasher.digest("hex");
				}
			} catch {}
		}
		const snapshot = await this.snapshot();
		const hasher = new Bun.CryptoHasher("sha256");
		for (const [relative, descriptor] of [...snapshot.entries()].sort(([left], [right]) => left.localeCompare(right))) {
			hasher.update(relative);
			hasher.update("\0");
			if (!descriptor.startsWith("file:")) {
				hasher.update(descriptor);
				continue;
			}
			try {
				const reader = Bun.file(path.join(this.root, relative)).stream().getReader();
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					hasher.update(value);
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				hasher.update("missing-during-fingerprint");
			}
		}
		return hasher.digest("hex");
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

async function sandboxedInvocation(command: string, cwd: string, allowNetwork: boolean): Promise<ShellInvocation> {
	const base = shellCommandInvocation(command);
	if (inheritedSandboxActive()) {
		return { argv: base, sandboxed: true };
	}
	if (process.platform === "darwin" && Bun.which("sandbox-exec")) {
		const home = os.homedir();
		const temporary = await fs.realpath(os.tmpdir());
		const sensitiveDirectories = [
			...new Set([
				path.join(home, ".ssh"),
				path.join(home, ".aws"),
				path.join(home, ".gnupg"),
				path.join(home, ".config", "gcloud"),
				path.join(home, ".codex"),
				path.join(home, ".claude"),
				path.join(home, ".longtime"),
				path.join(home, ".continuum"),
				longtimeHome(),
			]),
		];
		const sensitiveFiles = [path.join(home, ".npmrc"), path.join(home, ".netrc")];
		const profile = [
			"(version 1)",
			"(allow default)",
			"(deny file-write*)",
			...(!allowNetwork ? ["(deny network*)"] : []),
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
		for (const candidate of new Set([
			path.join(home, ".ssh"),
			path.join(home, ".aws"),
			path.join(home, ".gnupg"),
			path.join(home, ".config", "gcloud"),
			path.join(home, ".codex"),
			path.join(home, ".claude"),
			path.join(home, ".longtime"),
			path.join(home, ".continuum"),
			longtimeHome(),
		])) {
			try {
				if ((await fs.lstat(candidate)).isDirectory()) masks.push("--tmpfs", candidate);
			} catch {}
		}
		const fileMasks: string[] = [];
		for (const candidate of [path.join(home, ".npmrc"), path.join(home, ".netrc")]) {
			try {
				if ((await fs.lstat(candidate)).isFile()) fileMasks.push("--ro-bind", "/dev/null", candidate);
			} catch {}
		}
		return {
			argv: [
				"bwrap",
				"--die-with-parent",
				...(!allowNetwork ? ["--unshare-net"] : []),
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
				...fileMasks,
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
	allowNetwork?: boolean;
}): Promise<{ output: string; exitCode: number; sandboxed: boolean }> {
	const timeout = AbortSignal.timeout(Math.round(options.timeoutSeconds * 1000));
	const signal = AbortSignal.any([options.signal, timeout]);
	const invocation = options.sandbox
		? await sandboxedInvocation(options.command, options.cwd, options.allowNetwork ?? false)
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
