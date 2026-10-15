import {
	createDestinationRequest,
	type Destination,
	listQuery,
	operateRequest,
	type Page,
	patchDestinationRequest,
} from "@hookflare/shared";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import type { AppBindings } from "../../app";
import {
	decryptSecret,
	encryptSecret,
	secretFingerprint,
} from "../../core/crypto";
import {
	markQueuedMany,
	releasePausedDeliveries,
} from "../../core/db/deliveries";
import {
	getDestination,
	listDestinations,
	transitionDestinationStmt,
} from "../../core/db/destinations";
import { getProject } from "../../core/db/projects";
import { type DestinationRow, destinations } from "../../core/db/schema";
import { enqueueThenMark } from "../../core/enqueue";
import { newId } from "../../core/ids";
import { resolvePolicy } from "../../core/policy";
import type { AppEnv } from "../../env";
import { requirePermission } from "../auth/permission";
import {
	auditStmt,
	guardUrl,
	paginate,
	readJson,
	readOptionalJson,
	readQuery,
} from "../http";

const aad = (id: string) => `destinations.signing_secret_enc:${id}`;

/** Standard Webhooks secret: whsec_ + base64(32 random bytes). */
function generateSigningSecret(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return `whsec_${btoa(String.fromCharCode(...bytes))}`;
}

export async function toDestination(
	env: AppEnv,
	row: DestinationRow,
): Promise<Destination> {
	return {
		id: row.id,
		project_id: row.projectId,
		name: row.name,
		url: row.url,
		status: row.status,
		timeout_ms: row.timeoutMs,
		max_attempts: row.maxAttempts,
		backoff_base_s: row.backoffBaseS,
		backoff_max_s: row.backoffMaxS,
		signing_secret_fingerprint: await secretFingerprint(
			await decryptSecret(env, row.signingSecretEnc, aad(row.id)),
		),
		previous_secret_fingerprint: null,
		previous_secret_expires_at: null,
		created_at: row.createdAt,
		updated_at: row.updatedAt,
	};
}

/** backoff_max_s must not be below backoff_base_s once defaults apply (spec §8.4). */
function backoffConflict(
	c: Context<AppBindings>,
	row: Pick<
		DestinationRow,
		"timeoutMs" | "maxAttempts" | "backoffBaseS" | "backoffMaxS"
	>,
): Response | null {
	const policy = resolvePolicy(row);
	return policy.backoffMaxS < policy.backoffBaseS
		? c.json(
				{
					error: "invalid_request",
					issues: [
						{
							path: "backoff_max_s",
							code: "too_small",
							message: `backoff_max_s must be >= backoff_base_s (${policy.backoffBaseS})`,
						},
					],
				},
				400,
			)
		: null;
}

/** Re-reads after a lost conditional update: the row may be missing or disabled. */
async function settled(
	c: Context<AppBindings>,
	id: string,
	want: DestinationRow["status"],
) {
	const row = await getDestination(c.var.deps.db, id);
	if (!row) return { response: c.json({ error: "not_found" }, 404) };
	if (row.status === "disabled") {
		return {
			response: c.json(
				{ error: "conflict", reason: "destination_disabled" },
				409,
			),
		};
	}
	return row.status === want
		? { row }
		: { response: c.json({ error: "conflict" }, 409) };
}

export const RESUME_BATCH = 100;

export function destinationRoutes() {
	const routes = new Hono<AppBindings>();

	routes.post("/", requirePermission("config.write"), async (c) => {
		const body = await readJson(c, createDestinationRequest);
		if (!body.ok) return body.response;
		const { reason, ...fields } = body.value;
		const { db, now, env } = c.var.deps;
		if (!(await getProject(db, fields.project_id))) {
			return c.json({ error: "invalid_reference", field: "project_id" }, 422);
		}
		const unsafe = await guardUrl(c, fields.url);
		if (unsafe) return unsafe;

		const ts = now();
		const id = newId("dst", ts);
		const signingSecret = generateSigningSecret();
		const row: DestinationRow = {
			id,
			projectId: fields.project_id,
			name: fields.name,
			url: fields.url,
			status: "active",
			signingSecretEnc: await encryptSecret(env, signingSecret, aad(id)),
			signingSecretPrevEnc: null,
			signingSecretPrevExpiresAt: null,
			timeoutMs: fields.timeout_ms ?? null,
			maxAttempts: fields.max_attempts ?? null,
			backoffBaseS: fields.backoff_base_s ?? null,
			backoffMaxS: fields.backoff_max_s ?? null,
			createdAt: ts,
			updatedAt: ts,
		};
		const conflict = backoffConflict(c, row);
		if (conflict) return conflict;
		await db.batch([
			db.insert(destinations).values(row),
			auditStmt(c, {
				action: "destination.created",
				resourceType: "destination",
				resourceId: id,
				diff: fields,
				reason,
			}),
		]);
		return c.json(
			{ ...(await toDestination(env, row)), signing_secret: signingSecret },
			201,
		);
	});

	routes.get("/", requirePermission("events.read"), async (c) => {
		const q = readQuery(c, listQuery);
		if (!q.ok) return q.response;
		const { db, env } = c.var.deps;
		const { rows, nextCursor } = paginate(
			await listDestinations(db, {
				limit: q.value.limit,
				cursor: q.value.cursor,
				projectId: q.value.project_id,
			}),
			q.value.limit,
		);
		const data = await Promise.all(rows.map((r) => toDestination(env, r)));
		return c.json({
			data,
			next_cursor: nextCursor,
		} satisfies Page<Destination>);
	});

	routes.get("/:id", requirePermission("events.read"), async (c) => {
		const row = await getDestination(c.var.deps.db, c.req.param("id"));
		return row
			? c.json(await toDestination(c.var.deps.env, row))
			: c.json({ error: "not_found" }, 404);
	});

	routes.patch("/:id", requirePermission("config.write"), async (c) => {
		const body = await readJson(c, patchDestinationRequest);
		if (!body.ok) return body.response;
		const { db, now, env } = c.var.deps;
		const id = c.req.param("id");
		const existing = await getDestination(db, id);
		if (!existing) return c.json({ error: "not_found" }, 404);
		if (body.value.url !== undefined) {
			const unsafe = await guardUrl(c, body.value.url);
			if (unsafe) return unsafe;
		}
		const { reason, ...v } = body.value;
		const set: Partial<DestinationRow> = {
			...(v.name !== undefined ? { name: v.name } : {}),
			...(v.url !== undefined ? { url: v.url } : {}),
			...(v.status !== undefined ? { status: v.status } : {}),
			...(v.timeout_ms !== undefined ? { timeoutMs: v.timeout_ms } : {}),
			...(v.max_attempts !== undefined ? { maxAttempts: v.max_attempts } : {}),
			...(v.backoff_base_s !== undefined
				? { backoffBaseS: v.backoff_base_s }
				: {}),
			...(v.backoff_max_s !== undefined
				? { backoffMaxS: v.backoff_max_s }
				: {}),
		};
		const conflict = backoffConflict(c, { ...existing, ...set });
		if (conflict) return conflict;
		const [[row]] = await db.batch([
			db
				.update(destinations)
				.set({ ...set, updatedAt: now() })
				.where(eq(destinations.id, id))
				.returning(),
			auditStmt(c, {
				action: "destination.updated",
				resourceType: "destination",
				resourceId: id,
				diff: v,
				reason,
			}),
		]);
		return c.json(await toDestination(env, row));
	});

	routes.post(
		"/:id/pause",
		requirePermission("destinations.operate"),
		async (c) => {
			const body = await readOptionalJson(c, operateRequest);
			if (!body.ok) return body.response;
			const { db, now, env } = c.var.deps;
			const id = c.req.param("id");
			const existing = await getDestination(db, id);
			if (!existing) return c.json({ error: "not_found" }, 404);
			// Only an actual transition is audited; a repeat Pause is a no-op.
			if (existing.status === "active") {
				const [[row]] = await db.batch([
					transitionDestinationStmt(db, id, "active", "paused", now()),
					auditStmt(c, {
						action: "destination.paused",
						resourceType: "destination",
						resourceId: id,
						reason: body.value.reason,
					}),
				]);
				if (row) return c.json(await toDestination(env, row));
			}
			const s = await settled(c, id, "paused");
			if (s.response) return s.response;
			return c.json(await toDestination(env, s.row));
		},
	);

	routes.post(
		"/:id/resume",
		requirePermission("destinations.operate"),
		async (c) => {
			const body = await readOptionalJson(c, operateRequest);
			if (!body.ok) return body.response;
			const deps = c.var.deps;
			const id = c.req.param("id");
			const existing = await getDestination(deps.db, id);
			if (!existing) return c.json({ error: "not_found" }, 404);
			// Only an actual transition is audited; a repeat Resume is a no-op.
			let row: DestinationRow | undefined;
			if (existing.status === "paused") {
				const [[transitioned]] = await deps.db.batch([
					transitionDestinationStmt(
						deps.db,
						id,
						"paused",
						"active",
						deps.now(),
					),
					auditStmt(c, {
						action: "destination.resumed",
						resourceType: "destination",
						resourceId: id,
						reason: body.value.reason,
					}),
				]);
				row = transitioned ?? undefined;
			}
			if (!row) {
				const s = await settled(c, id, "active");
				if (s.response) return s.response;
				row = s.row;
			}
			// The rest is picked up by reconcile rule (e); a failed send by rule (a).
			const moved = await releasePausedDeliveries(deps, id, RESUME_BATCH);
			await enqueueThenMark(deps, moved, (chunk) =>
				markQueuedMany(deps, chunk),
			);
			return c.json({
				destination: await toDestination(deps.env, row),
				resumed: moved.length,
			});
		},
	);

	return routes;
}
