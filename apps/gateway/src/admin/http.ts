import { projectScopeQuery } from "@hookflare/shared";
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

export const MAX_ADMIN_BODY_BYTES = 65_536;

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

export async function readProjectResource<R extends { projectId: string }>(
	c: Context<AppBindings>,
	load: () => Promise<R | null | undefined>,
): Promise<Parsed<R>> {
	const q = readQuery(c, projectScopeQuery);
	if (!q.ok) return q;
	const row = await load();
	const scope = q.value.project_id;
	return row && (scope === undefined || scope === row.projectId)
		? { ok: true, value: row }
		: { ok: false, response: c.json({ error: "not_found" }, 404) };
}

export function checkCreateProject(c: Context<AppBindings>, projectId: string) {
	const q = readQuery(c, projectScopeQuery);
	if (!q.ok) return q.response;
	if (q.value.project_id !== undefined && q.value.project_id !== projectId)
		return invalid(c, [
			{
				path: "project_id",
				code: "custom",
				message: "Project must match the query scope",
			},
		]);
}

export function paginate<R extends { id: string }>(
	rows: R[],
	limit: number,
): { rows: R[]; nextCursor: string | null } {
	const page = rows.slice(0, limit);
	return {
		rows: page,
		nextCursor:
			rows.length > limit
				? (page.at(-1)?.id ?? /* istanbul ignore next */ null)
				: null,
	};
}

export function auditStmt(
	c: Context<AppBindings>,
	e: Omit<AuditEntry, "actor" | "at">,
) {
	const actor = c.var.actor;
	if (!actor) throw new Error("auditStmt called without an actor");
	return auditInsert(c.var.deps.db, {
		...e,
		actor: actor.username,
		at: c.var.deps.now(),
	});
}

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
