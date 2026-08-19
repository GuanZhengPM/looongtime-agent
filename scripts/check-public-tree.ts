import * as fs from "node:fs/promises";
import * as path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const publicEntries = ["README.md", "package.json", "src", "test", "docs"];
const forbiddenFileNames = new Set([".env", "auth.json", "credentials.json"]);
const forbiddenSuffixes = [".har", ".jsonl", ".log", ".p12", ".pem", ".pfx", ".trace"];
const contentRules: Array<{ label: string; pattern: RegExp }> = [
	{ label: "macOS user-home absolute path", pattern: /\/Users\/[^/\s]+\//u },
	{ label: "Linux user-home absolute path", pattern: /\/home\/[^/\s]+\//u },
	{ label: "Windows user-home absolute path", pattern: /[A-Za-z]:\\Users\\[^\\\s]+\\/u },
	{ label: "macOS per-user temporary path", pattern: /\/private\/var\/folders\/[A-Za-z0-9_/.-]+/u },
	{ label: "local file URI", pattern: /file:\/\//u },
	{ label: "private key", pattern: /BEGIN (?:RSA |OPENSSH |EC |PGP )?PRIVATE KEY/u },
	{ label: "OpenAI-style secret", pattern: /sk-[A-Za-z0-9_-]{20,}/u },
	{ label: "GitHub token", pattern: /gh[pousr]_[A-Za-z0-9]{20,}/u },
	{ label: "JWT", pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/u },
];

async function filesUnder(entry: string): Promise<string[]> {
	const absolute = path.join(root, entry);
	let stat: import("node:fs").Stats;
	try {
		stat = await fs.stat(absolute);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	if (stat.isFile()) return [absolute];
	const files: string[] = [];
	for (const child of await fs.readdir(absolute, { withFileTypes: true })) {
		const relative = path.join(entry, child.name);
		if (child.isDirectory()) files.push(...(await filesUnder(relative)));
		else if (child.isFile()) files.push(path.join(root, relative));
	}
	return files;
}

const violations: string[] = [];
for (const entry of publicEntries) {
	for (const file of await filesUnder(entry)) {
		const relative = path.relative(root, file);
		const base = path.basename(file);
		if (forbiddenFileNames.has(base) || forbiddenSuffixes.some(suffix => base.endsWith(suffix))) {
			violations.push(`${relative}: local/private artifact filename`);
			continue;
		}
		const content = await Bun.file(file).text();
		for (const rule of contentRules) {
			if (rule.pattern.test(content)) violations.push(`${relative}: ${rule.label}`);
		}
	}
}

if (violations.length > 0) {
	process.stderr.write(`Public-tree check failed:\n${violations.map(item => `- ${item}`).join("\n")}\n`);
	process.exit(1);
}

process.stdout.write("Public-tree check passed.\n");
