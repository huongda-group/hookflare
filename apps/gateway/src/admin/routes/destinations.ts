import {
	createDestinationRequest,
	type Destination,
	listQuery,
	type Page,
	patchDestinationRequest,
} from "@hookflare/shared";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AppBindings } from "../../app";
import {
	decryptSecret,
	encryptSecret,
	secretFingerprint,
} from "../../core/crypto";
import { getDestination, listDestinations } from "../../core/db/destinations";
import { getProject } from "../../core/db/projects";
import { type DestinationRow, destinations } from "../../core/db/schema";
import { newId } from "../../core/ids";
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
		signing_secret_fingerprint: await secretFingerprint(
			await decryptSecret(env, row.signingSecretEnc, aad(row.id)),
		),
		created_at: row.createdAt,
		updated_at: row.updatedAt,
	};
}

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
			timeoutMs: body.value.timeout_ms ?? null,
			maxAttempts: null,
			backoffBaseS: null,
			backoffMaxS: null,
			createdAt: ts,
			updatedAt: ts,
		};
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
		if (!(await getDestination(db, id)))
			return c.json({ error: "not_found" }, 404);
		if (body.value.url !== undefined) {
			const unsafe = await guardUrl(c, body.value.url);
			if (unsafe) return unsafe;
		}
		const { timeout_ms, ...rest } = body.value;
		const [row] = await db
			.update(destinations)
			.set({
				...rest,
				...(timeout_ms !== undefined ? { timeoutMs: timeout_ms } : {}),
				updatedAt: now(),
			})
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

	return routes;
}
