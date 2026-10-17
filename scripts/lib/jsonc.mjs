/**
 * Minimal JSONC parser for wrangler configs: strips `//` and `/* *\/` comments
 * outside strings, and trailing commas, then delegates to `JSON.parse`.
 * Single-pass scanner that tracks whether it is inside a string.
 */

/**
 * Strip comments and trailing commas from JSONC text.
 * @param {string} text
 * @returns {string}
 */
export function stripJsonc(text) {
	let out = "";
	let inString = false;
	let escaped = false;
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		if (inString) {
			out += ch;
			if (escaped) {
				escaped = false;
			} else if (ch === "\\") {
				escaped = true;
			} else if (ch === '"') {
				inString = false;
			}
			i++;
			continue;
		}
		if (ch === '"') {
			inString = true;
			out += ch;
			i++;
			continue;
		}
		if (ch === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") {
				i++;
			}
			continue;
		}
		if (ch === "/" && text[i + 1] === "*") {
			i += 2;
			while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
				i++;
			}
			i += 2;
			continue;
		}
		// A comma followed only by whitespace/comments then a bracket is
		// trailing. The lookahead skips comments too, so `, /* c */ }` counts.
		if (ch === ",") {
			let k = i + 1;
			for (;;) {
				while (k < text.length && /\s/.test(text[k])) {
					k++;
				}
				if (text[k] === "/" && text[k + 1] === "/") {
					k += 2;
					while (k < text.length && text[k] !== "\n") {
						k++;
					}
					continue;
				}
				if (text[k] === "/" && text[k + 1] === "*") {
					k += 2;
					while (k < text.length && !(text[k] === "*" && text[k + 1] === "/")) {
						k++;
					}
					k += 2;
					continue;
				}
				break;
			}
			if (text[k] === "}" || text[k] === "]") {
				i++;
				continue;
			}
		}
		out += ch;
		i++;
	}
	return out;
}

/**
 * Parse JSONC text into a value.
 * @param {string} text
 * @returns {unknown}
 */
export function parseJsonc(text) {
	return JSON.parse(stripJsonc(text));
}
