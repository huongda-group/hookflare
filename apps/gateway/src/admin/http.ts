import type { Context } from "hono";
import type { z } from "zod";
import type { AppBindings } from "../app";
import { type AuditEntry, auditInsert } from "../core/audit";
import { readCappedBody } from "../core/body";
import { DnsError } from "../core/dns";
import { checkUrl } from "../core/ssrf";

export type Parsed<T> =
	| { ok: true; value: T }
	| { ok: false; response: Response };

function invalid(c: Context<AppBindings>, issues: unknown[]): Response {
	return c.json({ error: "invalid_request", issues }, 400);
}

function issuesOf(error: z.ZodError) {
	return error.issues.map((i) => ({
		path: i.path.join("."),
		code: i.code,
		message: i.message,
	}));
}

export function badCursor(c: Context<AppBindings>): Response {
	return invalid(c, [
		{ path: "cursor", code: "invalid_cursor", message: "Cursor is not valid" },
	]);
}

/** Admin payloads are small config objects; anything bigger is a mistake. */
export const MAX_ADMIN_BODY_BYTES = 65_536;

/** Malformed JSON and schema failures are both 400 invalid_request. */
export async function readJson<S extends z.ZodType>(
	c: Context<AppBindings>,
	schema: S,
	opts: { emptyAsObject?: boolean } = {},
): Promise<Parsed<z.infer<S>>> {
	const tooLarge = () => ({
		ok: false as const,
		response: c.json({ error: "payload_too_large" }, 413),
	});
	const bytes = await readCappedBody(c.req.raw, MAX_ADMIN_BODY_BYTES);
	if (!bytes) {
		return tooLarge();
	}
	let raw: unknown;
	if (bytes.byteLength === 0 && opts.emptyAsObject) {
		raw = {};
	} else {
		try {
			raw = JSON.parse(new TextDecoder().decode(bytes));
		} catch {
			return {
				ok: false,
				response: invalid(c, [
					{ path: "", code: "invalid_json", message: "Body is not valid JSON" },
				]),
			};
		}
	}
	const result = schema.safeParse(raw);
	return result.success
		? { ok: true, value: result.data }
		: { ok: false, response: invalid(c, issuesOf(result.error)) };
}

/** For endpoints whose whole body is optional (e.g. `{reason?}`). */
export function readOptionalJson<S extends z.ZodType>(
	c: Context<AppBindings>,
	schema: S,
) {
	return readJson(c, schema, { emptyAsObject: true });
}

export function readQuery<S extends z.ZodType>(
	c: Context<AppBindings>,
	schema: S,
	arrays: string[] = [],
): Parsed<z.infer<S>> {
	/** Keys in `arrays` may repeat (`?status=a&status=b`) and are passed as string[]. */
	const raw: Record<string, unknown> = { ...c.req.query() };
	for (const key of arrays) {
		const values = c.req.queries(key);
		if (values) raw[key] = values;
	}
	const result = schema.safeParse(raw);
	return result.success
		? { ok: true, value: result.data }
		: { ok: false, response: invalid(c, issuesOf(result.error)) };
}

/** rows holds up to limit + 1 entries (see list* helpers). */
export function paginate<R extends { id: string }>(
	rows: R[],
	limit: number,
): { rows: R[]; nextCursor: string | null } {
	const page = rows.slice(0, limit);
	return {
		rows: page,
		nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
	};
}

/** Destination URLs may carry credentials in the path or query, so audit diffs keep only the origin. */
export function auditUrl(url: string): string {
	return new URL(url).origin;
}

/** Unexecuted audit insert for the request's actor; batch it with the mutation (M3-7). */
export function auditStmt(
	c: Context<AppBindings>,
	e: Omit<AuditEntry, "actor" | "at">,
) {
	const actor = c.var.actor;
	if (!actor) throw new Error("auditStmt called without an actor");
	return auditInsert(c.var.deps.db, {
		...e,
		actor: actor.email,
		at: c.var.deps.now(),
	});
}

/** SSRF check on save (§8). Returns an error response, or null when the url is allowed. */
export async function guardUrl(
	c: Context<AppBindings>,
	url: string,
): Promise<Response | null> {
	try {
		const result = await checkUrl(url, c.var.deps);
		return result.ok
			? null
			: c.json({ error: "unsafe_url", reason: result.reason }, 422);
	} catch (err) {
		if (err instanceof DnsError) {
			c.var.logger.warn("admin.dns_failed", { error: err });
			return c.json({ error: "unavailable" }, 503);
		}
		throw err;
	}
}
