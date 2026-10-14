export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogEnv = {
	LOG_LEVEL?: string;
};

const LEVEL_ORDER: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

const DEFAULT_LEVEL: LogLevel = "info";
const MAX_DEPTH = 10;

const REDACTED = "[REDACTED]";

// Compared against keys lowercased with "-" and "_" stripped, so "api-key",
// "api_key", "apikey", and "x-api-key" all match; matched as substrings so
// "accessToken" and "client_secret" are also caught.
const SENSITIVE_TOKENS = [
	"authorization",
	"cookie",
	"setcookie",
	"secret",
	"token",
	"password",
	"signature",
	"apikey",
];

function normalizeKey(key: string): string {
	return key.toLowerCase().replace(/[-_]/g, "");
}

function isSensitiveKey(key: string, extra: Set<string>): boolean {
	const norm = normalizeKey(key);
	if (extra.has(key.toLowerCase()) || extra.has(norm)) {
		return true;
	}
	return SENSITIVE_TOKENS.some((t) => norm.includes(t));
}

function serializeError(err: Error): Record<string, unknown> {
	const out: Record<string, unknown> = {
		name: err.name,
		message: err.message,
	};
	if (err.stack !== undefined) {
		out.stack = err.stack;
	}
	return out;
}

/**
 * Recursive depth-limited redaction walk. Handles cycles and exotic types, but
 * throwing getters or toJSON() propagate; log() catches them.
 */
export function redactValue(
	value: unknown,
	extraNames: string[] = [],
	depth = 0,
	seen?: Set<object>,
): unknown {
	if (value === null || value === undefined) {
		return value;
	}
	const t = typeof value;
	if (t === "string" || t === "number" || t === "boolean") {
		return value;
	}
	if (t === "bigint") {
		return (value as bigint).toString();
	}
	if (t === "function" || t === "symbol") {
		return `[${t}]`;
	}
	if (depth > MAX_DEPTH) {
		return "[TRUNCATED]";
	}
	if (typeof value !== "object") {
		return value;
	}
	const obj = value as object;
	const seenSet = seen ?? new Set<object>();
	if (seenSet.has(obj)) {
		return "[CIRCULAR]";
	}
	seenSet.add(obj);
	try {
		if (obj instanceof Error) {
			return serializeError(obj);
		}
		if (obj instanceof Date) {
			return Number.isNaN(obj.getTime()) ? "Invalid Date" : obj.toISOString();
		}
		if (obj instanceof Headers) {
			const asRecord: Record<string, string> = {};
			obj.forEach((v, k) => {
				asRecord[k] = v;
			});
			return redactValue(asRecord, extraNames, depth, seenSet);
		}
		if (Array.isArray(obj)) {
			return (obj as unknown[]).map((item) =>
				redactValue(item, extraNames, depth + 1, seenSet),
			);
		}
		if (ArrayBuffer.isView(obj) || obj instanceof ArrayBuffer) {
			return "[BINARY]";
		}
		if (obj instanceof Map) {
			return redactValue(
				Object.fromEntries(
					Array.from(obj, ([k, v]) => [String(k), v] as const),
				),
				extraNames,
				depth,
				seenSet,
			);
		}
		if (obj instanceof Set) {
			return redactValue(Array.from(obj), extraNames, depth, seenSet);
		}
		if (obj instanceof URL) {
			return obj.toString();
		}
		const toJSON = (obj as { toJSON?: unknown }).toJSON;
		if (typeof toJSON === "function") {
			return redactValue(toJSON.call(obj), extraNames, depth + 1, seenSet);
		}
		const extra = new Set(extraNames.map((n) => n.toLowerCase()));
		const extraNorm = new Set(extraNames.map((n) => normalizeKey(n)));
		const out: Record<string, unknown> = {};
		for (const [key, val] of Object.entries(obj)) {
			if (isSensitiveKey(key, extra) || extraNorm.has(normalizeKey(key))) {
				out[key] = REDACTED;
			} else {
				out[key] = redactValue(val, extraNames, depth + 1, seenSet);
			}
		}
		return out;
	} finally {
		seenSet.delete(obj);
	}
}

/** Redact a headers collection to a plain lowercase-keyed record. */
export function redactHeaders(
	headers: Headers | Record<string, string | string[] | undefined>,
	extraNames: string[] = [],
): Record<string, string> {
	const entries: Array<[string, string]> = [];
	if (headers instanceof Headers) {
		headers.forEach((v, k) => {
			entries.push([k.toLowerCase(), v]);
		});
	} else {
		for (const [k, v] of Object.entries(headers)) {
			if (v === undefined) {
				continue;
			}
			entries.push([k.toLowerCase(), Array.isArray(v) ? v.join(", ") : v]);
		}
	}
	const extra = new Set(extraNames.map((n) => n.toLowerCase()));
	const extraNorm = new Set(extraNames.map((n) => normalizeKey(n)));
	const out: Record<string, string> = {};
	for (const [k, v] of entries) {
		out[k] =
			isSensitiveKey(k, extra) || extraNorm.has(normalizeKey(k)) ? REDACTED : v;
	}
	return out;
}

export function parseLogLevel(value: unknown): LogLevel {
	if (typeof value === "string") {
		const norm = value.toLowerCase();
		if (
			norm === "debug" ||
			norm === "info" ||
			norm === "warn" ||
			norm === "error"
		) {
			return norm;
		}
	}
	return DEFAULT_LEVEL;
}

export function shouldLog(level: LogLevel, env?: LogEnv): boolean {
	return LEVEL_ORDER[level] >= LEVEL_ORDER[parseLogLevel(env?.LOG_LEVEL)];
}

export type LogFields = Record<string, unknown>;

/**
 * Emit one JSON line: `{level, msg, request_id?, ...}`. Fields are redacted
 * and Errors serialized. Levels below LOG_LEVEL (default info) are dropped.
 */
export function log(
	level: LogLevel,
	msg: string,
	fields: LogFields = {},
	env?: LogEnv,
): void {
	if (!shouldLog(level, env)) {
		return;
	}
	let line: string;
	try {
		const redacted = redactValue(fields) as LogFields;
		// level and msg come last so fields can never override them.
		line = JSON.stringify({ ...redacted, level, msg });
	} catch (err) {
		// Logging must never throw (e.g. a getter that throws, a Proxy).
		line = JSON.stringify({
			level: "error",
			msg: "log_error",
			original_msg: msg,
			error: err instanceof Error ? err.name : "unknown",
		});
		console.error(line);
		return;
	}
	if (level === "error") {
		console.error(line);
	} else if (level === "warn") {
		console.warn(line);
	} else {
		console.log(line);
	}
}

export type Logger = Record<
	LogLevel,
	(msg: string, fields?: LogFields) => void
>;

/** Logger with env (and optional base fields like request_id) bound. */
export function createLogger(env?: LogEnv, baseFields: LogFields = {}): Logger {
	const withBase =
		(level: LogLevel) =>
		(msg: string, fields: LogFields = {}) => {
			log(level, msg, { ...baseFields, ...fields }, env);
		};
	return {
		debug: withBase("debug"),
		info: withBase("info"),
		warn: withBase("warn"),
		error: withBase("error"),
	};
}
