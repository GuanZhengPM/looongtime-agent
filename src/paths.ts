import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const HOME_DIRECTORY = ".looongtime";
const LEGACY_HOME_DIRECTORIES = [".longtime", ".continuum"];

/**
 * Resolve Looongtime's state root while preserving installs made under the
 * project's earlier names. Explicit Looongtime configuration wins, followed by
 * the legacy environment variables in reverse chronological order. Without any
 * of them, the most recent pre-existing legacy home remains readable until the
 * user chooses to migrate it.
 */
export function looongtimeHome(): string {
	const configured =
		process.env.LOOONGTIME_HOME ??
		process.env.LONGTIME_HOME ??
		process.env.CONTINUUM_HOME;
	if (configured) return path.resolve(configured);
	const current = path.join(os.homedir(), HOME_DIRECTORY);
	if (existsSync(current)) return current;
	for (const directory of LEGACY_HOME_DIRECTORIES) {
		const legacy = path.join(os.homedir(), directory);
		if (existsSync(legacy)) return legacy;
	}
	return current;
}

export function looongtimeModel(): string | undefined {
	return (
		process.env.LOOONGTIME_MODEL ??
		process.env.LONGTIME_MODEL ??
		process.env.CONTINUUM_MODEL
	);
}
