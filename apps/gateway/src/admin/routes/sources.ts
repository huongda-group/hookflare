import {
	authConfigSchemaFor,
	createSourceRequest,
	eventIdConfigError,
	listQuery,
	type Page,
	patchSourceRequest,
	type Source,
} from "@hookflare/shared";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import type { AppBindings } from "../../app";
import {
	bytesToB64url,
	decryptSecret,
	encryptSecret,
	secretFingerprint,
} from "../../core/crypto";
import { getDestination } from "../../core/db/destinations";
import { getProject } from "../../core/db/projects";
import { type SourceRow, sources } from "../../core/db/schema";
import { getSource, listSources } from "../../core/db/sources";
import { newId } from "../../core/ids";
import { audit, paginate, readJson, readQuery } from "../http";

const aad = (id: string) => `sources.secret_enc:${id}`;

async function toSource(
	c: Context<AppBindings>,
	row: SourceRow,
): Promise<Source> {
	const env = c.var.deps.env;
	return {
		id: row.id,
		project_id: row.projectId,
		destination_id: row.destinationId,
		name: row.name,
		status: row.status,
		auth_type: row.authType,
		auth_config: row.authConfig as Source["auth_config"],
		secret_fingerprint: row.secretEnc
			? await secretFingerprint(
					await decryptSecret(env, row.secretEnc, aad(row.id)),
				)
			: null,
		event_id_from: row.eventIdFrom,
		event_id_selector: row.eventIdSelector,
		max_body_bytes: row.maxBodyBytes,
		ingress_url: `${ingressOrigin(c)}/in/${row.id}`,
		created_at: row.createdAt,
		updated_at: row.updatedAt,
	};
}

function ingressOrigin(c: Context<AppBindings>): string {
	const base = c.var.deps.env.PUBLIC_BASE_URL;
	return base ? base.replace(/\/+$/, "") : new URL(c.req.url).origin;
}

function invalidReference(c: Context<AppBindings>, field: string) {
	return c.json({ error: "invalid_reference", field }, 422);
}

function invalidField(c: Context<AppBindings>, path: string, message: string) {
	return c.json(
		{ error: "invalid_request", issues: [{ path, code: "custom", message }] },
		400,
	);
}

export function sourceRoutes() {
	const routes = new Hono<AppBindings>();

	routes.post("/", async (c) => {
		const body = await readJson(c, createSourceRequest);
		if (!body.ok) return body.response;
		const req = body.value;
		const { db, now, env } = c.var.deps;
		if (!(await getProject(db, req.project_id)))
			return invalidReference(c, "project_id");
		const destination = await getDestination(db, req.destination_id);
		if (!destination || destination.projectId !== req.project_id)
			return invalidReference(c, "destination_id");

		const ts = now();
		const id = newId("src", ts);
		const supplied = req.auth_type === "none" ? undefined : req.secret;
		const generated =
			req.auth_type !== "none" && supplied === undefined
				? bytesToB64url(crypto.getRandomValues(new Uint8Array(32)))
				: undefined;
		const secret = supplied ?? generated;
		const row: SourceRow = {
			id,
			projectId: req.project_id,
			destinationId: req.destination_id,
			name: req.name,
			status: "active",
			authType: req.auth_type,
			authConfig: req.auth_config,
			secretEnc:
				secret === undefined ? null : await encryptSecret(env, secret, aad(id)),
			secretPrevEnc: null,
			secretPrevExpiresAt: null,
			eventIdFrom: req.event_id_from,
			eventIdSelector:
				req.event_id_from === "none" ? null : (req.event_id_selector ?? null),
			maxBodyBytes: req.max_body_bytes ?? null,
			createdAt: ts,
			updatedAt: ts,
		};
		await db.insert(sources).values(row);
		const { secret: _secret, ...diff } = req as typeof req & {
			secret?: string;
		};
		audit(c, "source", "created", id, diff);
		const dto = await toSource(c, row);
		return c.json(generated ? { ...dto, secret: generated } : dto, 201);
	});

	routes.get("/", async (c) => {
		const q = readQuery(c, listQuery);
		if (!q.ok) return q.response;
		const { rows, nextCursor } = paginate(
			await listSources(c.var.deps.db, {
				limit: q.value.limit,
				cursor: q.value.cursor,
				projectId: q.value.project_id,
			}),
			q.value.limit,
		);
		const data = await Promise.all(rows.map((r) => toSource(c, r)));
		return c.json({ data, next_cursor: nextCursor } satisfies Page<Source>);
	});

	routes.get("/:id", async (c) => {
		const row = await getSource(c.var.deps.db, c.req.param("id"));
		return row
			? c.json(await toSource(c, row))
			: c.json({ error: "not_found" }, 404);
	});

	routes.patch("/:id", async (c) => {
		const body = await readJson(c, patchSourceRequest);
		if (!body.ok) return body.response;
		const patch = body.value;
		const { db, now } = c.var.deps;
		const existing = await getSource(db, c.req.param("id"));
		if (!existing) return c.json({ error: "not_found" }, 404);

		const set: Partial<SourceRow> = { updatedAt: now() };
		if (patch.name !== undefined) set.name = patch.name;
		if (patch.status !== undefined) set.status = patch.status;
		if (patch.max_body_bytes !== undefined)
			set.maxBodyBytes = patch.max_body_bytes;

		if (patch.auth_config !== undefined) {
			const parsed = authConfigSchemaFor(existing.authType).safeParse(
				patch.auth_config,
			);
			if (!parsed.success)
				return invalidField(
					c,
					"auth_config",
					`does not match auth_type ${existing.authType}`,
				);
			set.authConfig = parsed.data as Record<string, unknown>;
		}

		if (patch.destination_id !== undefined) {
			const destination = await getDestination(db, patch.destination_id);
			if (!destination || destination.projectId !== existing.projectId)
				return invalidReference(c, "destination_id");
			set.destinationId = patch.destination_id;
		}

		if (
			patch.event_id_from !== undefined ||
			patch.event_id_selector !== undefined
		) {
			const from = patch.event_id_from ?? existing.eventIdFrom;
			const selector =
				from === "none"
					? null
					: patch.event_id_selector !== undefined
						? patch.event_id_selector
						: existing.eventIdSelector;
			const error = eventIdConfigError(from, selector);
			if (error) return invalidField(c, "event_id_selector", error);
			set.eventIdFrom = from;
			set.eventIdSelector = selector;
		}

		const [row] = await db
			.update(sources)
			.set(set)
			.where(eq(sources.id, existing.id))
			.returning();
		if (!row) return c.json({ error: "not_found" }, 404);
		audit(c, "source", "updated", row.id, patch);
		return c.json(await toSource(c, row));
	});

	return routes;
}
