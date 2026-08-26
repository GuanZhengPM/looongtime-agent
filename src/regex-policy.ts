interface RegexGroup {
	hasInnerQuantifier: boolean;
	hasAlternation: boolean;
}

/**
 * Reject common exponential-backtracking structures before giving a
 * model-supplied pattern to JavaScript's backtracking RegExp engine. This is a
 * deliberately conservative guardrail, not a complete regex parser.
 */
export function compileSearchRegex(pattern: string, flags = ""): RegExp {
	if (!pattern) throw new Error("Search pattern cannot be empty.");
	if (pattern.length > 2_000) throw new Error("Search pattern exceeds 2,000 characters.");
	const groups: RegexGroup[] = [];
	let characterClass = false;
	let escaped = false;
	let lastClosedGroup: RegexGroup | undefined;
	for (let index = 0; index < pattern.length; index += 1) {
		const character = pattern[index]!;
		if (escaped) {
			if (!characterClass && /[1-9]/.test(character)) {
				throw new Error("Search patterns cannot use backreferences.");
			}
			escaped = false;
			lastClosedGroup = undefined;
			continue;
		}
		if (character === "\\") {
			escaped = true;
			continue;
		}
		if (characterClass) {
			if (character === "]") characterClass = false;
			continue;
		}
		if (character === "[") {
			characterClass = true;
			lastClosedGroup = undefined;
			continue;
		}
		if (character === "(" && pattern[index + 1] === "?") {
			const extension = pattern[index + 2];
			if (extension !== ":") throw new Error("Search patterns cannot use lookaround or named groups.");
			groups.push({ hasInnerQuantifier: false, hasAlternation: false });
			lastClosedGroup = undefined;
			index += 2;
			continue;
		}
		if (character === "(") {
			groups.push({ hasInnerQuantifier: false, hasAlternation: false });
			lastClosedGroup = undefined;
			continue;
		}
		if (character === "|") {
			const current = groups.at(-1);
			if (current) current.hasAlternation = true;
			lastClosedGroup = undefined;
			continue;
		}
		if (character === ")") {
			const closed = groups.pop();
			if (!closed) throw new Error("Search pattern contains an unmatched closing group.");
			if (closed.hasInnerQuantifier) {
				const parent = groups.at(-1);
				if (parent) parent.hasInnerQuantifier = true;
			}
			lastClosedGroup = closed;
			continue;
		}
		const isQuantifier = character === "*" || character === "+" || character === "?" ||
			(character === "{" && /^\{\d+(?:,\d*)?\}/.test(pattern.slice(index)));
		if (isQuantifier) {
			if (lastClosedGroup?.hasInnerQuantifier || lastClosedGroup?.hasAlternation) {
				throw new Error("Search pattern contains a repeated group with nested or ambiguous quantifiers.");
			}
			for (const group of groups) group.hasInnerQuantifier = true;
			lastClosedGroup = undefined;
			continue;
		}
		lastClosedGroup = undefined;
	}
	if (escaped || characterClass || groups.length > 0) {
		// Let callers receive one stable validation error instead of provider- or
		// engine-specific RegExp syntax messages.
		throw new Error("Search pattern contains an unterminated escape, class, or group.");
	}
	return new RegExp(pattern, flags);
}
