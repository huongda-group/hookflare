import {
	createDestinationRequest,
	type Destination,
	listQuery,
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
	transitionDestination,
} from "../../core/db/destinations";
import { getProject } from "../../core/db/projects";
import { type DestinationRow, destinations } from "../../core/db/schema";
import { enqueueThenMark } from "../../core/enqueue";
import { newId } from "../../core/ids";
import { resolvePolicy } from "../../core/policy";
import type { AppEnv } from "../../env";
import {
	audit,
	auditUrl,
	guardUrl,
	paginate,
	readJson,
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

	routes.post("/", async (c) => {
		const body = await readJson(c, createDestinationRequest);
		if (!body.ok) return body.response;
		const { db, now, env } = c.var.deps;
		if (!(await getProject(db, body.value.project_id))) {
			return c.json({ error: "invalid_reference", field: "project_id" }, 422);
		}
		const unsafe = await guardUrl(c, body.value.url);
		if (unsafe) return unsafe;

		const ts = now();
		const id = newId("dst", ts);
		const signingSecret = generateSigningSecret();
		const row: DestinationRow = {
			id,
			projectId: body.value.project_id,
			name: body.value.name,
			url: body.value.url,
			status: "active",
			signingSecretEnc: await encryptSecret(env, signingSecret, aad(id)),
			signingSecretPrevEnc: null,
			signingSecretPrevExpiresAt: null,
			timeoutMs: body.value.timeout_ms ?? null,
			maxAttempts: body.value.max_attempts ?? null,
			backoffBaseS: body.value.backoff_base_s ?? null,
			backoffMaxS: body.value.backoff_max_s ?? null,
			createdAt: ts,
			updatedAt: ts,
		};
		const conflict = backoffConflict(c, row);
		if (conflict) return conflict;
		await db.insert(destinations).values(row);
		audit(c, "destination", "created", id, {
			...body.value,
			url: auditUrl(body.value.url),
		});
		return c.json(
			{ ...(await toDestination(env, row)), signing_secret: signingSecret },
			201,
		);
	});

	routes.get("/", async (c) => {
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

	routes.get("/:id", async (c) => {
		const row = await getDestination(c.var.deps.db, c.req.param("id"));
		return row
			? c.json(await toDestination(c.var.deps.env, row))
			: c.json({ error: "not_found" }, 404);
	});

	routes.patch("/:id", async (c) => {
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
		const v = body.value;
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
		const [row] = await db
			.update(destinations)
			.set({ ...set, updatedAt: now() })
			.where(eq(destinations.id, id))
			.returning();
		if (!row) return c.json({ error: "not_found" }, 404);
		audit(
			c,
			"destination",
			"updated",
			id,
			body.value.url === undefined
				? body.value
				: { ...body.value, url: auditUrl(body.value.url) },
		);
		return c.json(await toDestination(env, row));
	});

	routes.post("/:id/pause", async (c) => {
		const { db, now, env } = c.var.deps;
		const id = c.req.param("id");
		let row = await transitionDestination(db, id, "active", "paused", now());
		if (!row) {
			const s = await settled(c, id, "paused");
			if (s.response) return s.response;
			row = s.row;
		}
		audit(c, "destination", "paused", id, {});
		return c.json(await toDestination(env, row));
	});

	routes.post("/:id/resume", async (c) => {
		const deps = c.var.deps;
		const id = c.req.param("id");
		let row = await transitionDestination(
			deps.db,
			id,
			"paused",
			"active",
			deps.now(),
		);
		if (!row) {
			const s = await settled(c, id, "active");
			if (s.response) return s.response;
			row = s.row;
		}
		// The rest is picked up by reconcile rule (e); a failed send by rule (a).
		const moved = await releasePausedDeliveries(deps, id, RESUME_BATCH);
		await enqueueThenMark(deps, moved, (chunk) => markQueuedMany(deps, chunk));
		audit(c, "destination", "resumed", id, { resumed: moved.length });
		return c.json({
			destination: await toDestination(deps.env, row),
			resumed: moved.length,
		});
	});

	return routes;
}
