import * as path from "node:path";

/**
 * Bun.Glob accepts absolute patterns and `../`, so `cwd` alone is not a
 * filesystem boundary. Reject ambiguous glob roots before scanning and still
 * canonicalize every returned file at the call site.
 */
export function validateRelativeGlob(pattern: string): string {
	if (!pattern.trim()) throw new Error("Workspace glob cannot be empty.");
	if (pattern.includes("\0")) throw new Error("Workspace glob contains a NUL byte.");
	if (path.posix.isAbsolute(pattern) || path.win32.isAbsolute(pattern) || pattern.startsWith("~")) {
		throw new Error("Workspace glob must be relative.");
	}
	// Reject any occurrence, rather than only a literal path segment, because
	// brace/extglob syntax can turn a less obvious occurrence into `../`.
	if (pattern.includes("..")) throw new Error("Workspace glob cannot traverse a parent directory.");
	return pattern;
}
