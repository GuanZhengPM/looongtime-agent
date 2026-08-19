import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const LEGACY_HOME_DIRECTORY = ".continuum";
const HOME_DIRECTORY = ".longtime";

/**
 * Resolve Longtime's state root while preserving existing Continuum installs.
 * Explicit Longtime configuration wins, followed by the legacy environment
 * variable. Without either, a pre-existing legacy home remains readable until
 * the user chooses to migrate it.
 */
export function longtimeHome(): string {
	const configured = process.env.LONGTIME_HOME ?? process.env.CONTINUUM_HOME;
	if (configured) return path.resolve(configured);
	const current = path.join(os.homedir(), HOME_DIRECTORY);
	const legacy = path.join(os.homedir(), LEGACY_HOME_DIRECTORY);
	return existsSync(current) || !existsSync(legacy) ? current : legacy;
}

export function longtimeModel(): string | undefined {
	return process.env.LONGTIME_MODEL ?? process.env.CONTINUUM_MODEL;
}
