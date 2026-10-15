import type { Context } from "hono";
import type { z } from "zod";
import type { AppBindings } from "../app";
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

/** Malformed JSON and schema failures are both 400 invalid_request. */
export async function readJson<S extends z.ZodType>(
	c: Context<AppBindings>,
	schema: S,
): Promise<Parsed<z.infer<S>>> {
	let raw: unknown;
	try {
		raw = JSON.parse(await c.req.text());
	} catch {
		return {
			ok: false,
			response: invalid(c, [
				{ path: "", code: "invalid_json", message: "Body is not valid JSON" },
			]),
		};
	}
	const result = schema.safeParse(raw);
	return result.success
		? { ok: true, value: result.data }
		: { ok: false, response: invalid(c, issuesOf(result.error)) };
}

export function readQuery<S extends z.ZodType>(
	c: Context<AppBindings>,
	schema: S,
): Parsed<z.infer<S>> {
	const result = schema.safeParse(c.req.query());
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

/** Interim audit until audit_logs lands in M3. diff must never contain secrets. */
export function audit(
	c: Context<AppBindings>,
	resource: string,
	action: "created" | "updated",
	resourceId: string,
	diff: Record<string, unknown>,
): void {
	c.var.logger.info(`admin.${resource}.${action}`, {
		actor_email: c.var.actor?.email,
		resource_id: resourceId,
		diff,
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
