import {
	createDestinationRequest,
	type Destination,
	listQuery,
	operateRequest,
	type Page,
	pageQuery,
	patchDestinationRequest,
	rotateDestinationSecretRequest,
	type TestDelivery,
	testDeliveryRequest,
} from "@hookflare/shared";
import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import type { AppBindings } from "../../app";
import { auditInsertIfChanged } from "../../core/audit";
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
import {
	type DestinationRow,
	destinations,
	type TestDeliveryRow,
	type TestErrorKind,
	testDeliveries,
} from "../../core/db/schema";
import {
	listTestDeliveries,
	toTestDelivery,
} from "../../core/db/test-deliveries";
import { DnsError } from "../../core/dns";
import { enqueueThenMark } from "../../core/enqueue";
import { newId } from "../../core/ids";
import { failureOf, sendSigned } from "../../core/outbound";
import {
	type Policy,
	type PolicyFields,
	resolvePolicy,
} from "../../core/policy";
import {
	aad,
	clearExpiredPrev,
	destinationSigningSecrets,
	rotationColumns,
} from "../../core/secrets";
import { loadRetryDefaults } from "../../core/settings";
import { buildOutboundHeaders, signWebhookAll } from "../../core/sign";
import { checkUrl } from "../../core/ssrf";
import type { AppEnv } from "../../env";
import { requirePermission } from "../auth/permission";
import { decodeCursor, encodeCursor } from "../cursor";
import {
	auditStmt,
	badCursor,
	guardUrl,
	paginate,
	readJson,
	readOptionalJson,
	readQuery,
} from "../http";

/** Standard Webhooks secret: whsec_ + base64(32 random bytes). */
function generateSigningSecret(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return `whsec_${btoa(String.fromCharCode(...bytes))}`;
}

export async function toDestination(
	env: AppEnv,
	row: DestinationRow,
	now: number = Date.now(),
): Promise<Destination> {
	const live =
		row.signingSecretPrevEnc &&
		row.signingSecretPrevExpiresAt !== null &&
		row.signingSecretPrevExpiresAt > now;
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
			await decryptSecret(env, row.signingSecretEnc, aad.destination(row.id)),
		),
		previous_secret_fingerprint: live
			? await secretFingerprint(
					await decryptSecret(
						env,
						row.signingSecretPrevEnc as string,
						aad.destinationPrev(row.id),
					),
				)
			: null,
		previous_secret_expires_at: live ? row.signingSecretPrevExpiresAt : null,
		created_at: row.createdAt,
		updated_at: row.updatedAt,
	};
}

/** backoff_max_s must not be below backoff_base_s once defaults apply (spec §8.4). */
function backoffConflict(
	c: Context<AppBindings>,
	row: PolicyFields,
	defaults: Policy,
): Response | null {
	const base = row.backoffBaseS ?? defaults.backoffBaseS;
	const max = row.backoffMaxS ?? defaults.backoffMaxS;
	return max < base
		? c.json(
				{
					error: "invalid_request",
					issues: [
						{
							path: "backoff_max_s",
							code: "too_small",
							message: `backoff_max_s must be >= backoff_base_s (${base})`,
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
			signingSecretEnc: await encryptSecret(
				env,
				signingSecret,
				aad.destination(id),
			),
			signingSecretPrevEnc: null,
			signingSecretPrevExpiresAt: null,
			timeoutMs: fields.timeout_ms ?? null,
			maxAttempts: fields.max_attempts ?? null,
			backoffBaseS: fields.backoff_base_s ?? null,
			backoffMaxS: fields.backoff_max_s ?? null,
			createdAt: ts,
			updatedAt: ts,
		};
		const conflict = backoffConflict(
			c,
			row,
			await loadRetryDefaults(c.var.deps),
		);
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
			{ ...(await toDestination(env, row, ts)), signing_secret: signingSecret },
			201,
		);
	});

	routes.get("/", requirePermission("events.read"), async (c) => {
		const q = readQuery(c, listQuery);
		if (!q.ok) return q.response;
		const { db, env, now } = c.var.deps;
		const { rows, nextCursor } = paginate(
			await listDestinations(db, {
				limit: q.value.limit,
				cursor: q.value.cursor,
				projectId: q.value.project_id,
			}),
			q.value.limit,
		);
		const ts = now();
		const data = await Promise.all(rows.map((r) => toDestination(env, r, ts)));
		return c.json({
			data,
			next_cursor: nextCursor,
		} satisfies Page<Destination>);
	});

	routes.get("/:id", requirePermission("events.read"), async (c) => {
		const row = await getDestination(c.var.deps.db, c.req.param("id"));
		return row
			? c.json(await toDestination(c.var.deps.env, row, c.var.deps.now()))
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
		const conflict = backoffConflict(
			c,
			{ ...existing, ...set },
			await loadRetryDefaults(c.var.deps),
		);
		if (conflict) return conflict;
		const ts = now();
		const prev = clearExpiredPrev(
			destinations.signingSecretPrevEnc,
			destinations.signingSecretPrevExpiresAt,
			ts,
		);
		const [[row]] = await db.batch([
			db
				.update(destinations)
				.set({
					...set,
					signingSecretPrevEnc: prev.enc,
					signingSecretPrevExpiresAt: prev.expiresAt,
					updatedAt: ts,
				})
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
		return c.json(await toDestination(env, row, ts));
	});

	routes.post(
		"/:id/rotate-secret",
		requirePermission("config.write"),
		async (c) => {
			const body = await readOptionalJson(c, rotateDestinationSecretRequest);
			if (!body.ok) return body.response;
			const { db, now, env } = c.var.deps;
			const id = c.req.param("id");
			const existing = await getDestination(db, id);
			if (!existing) return c.json({ error: "not_found" }, 404);
			const ts = now();
			const secret = generateSigningSecret();
			const cols = await rotationColumns({
				env,
				currentEnc: existing.signingSecretEnc,
				currentAad: aad.destination(id),
				prevAad: aad.destinationPrev(id),
				newSecret: secret,
				newAad: aad.destination(id),
				graceHours: body.value.grace_hours,
				now: ts,
			});
			const fingerprint = await secretFingerprint(secret);
			// Fenced on the ciphertext we read: a concurrent rotation makes this a no-op.
			const [[row]] = await db.batch([
				db
					.update(destinations)
					.set({
						signingSecretEnc: cols.enc,
						signingSecretPrevEnc: cols.prevEnc,
						signingSecretPrevExpiresAt: cols.prevExpiresAt,
						updatedAt: ts,
					})
					.where(
						and(
							eq(destinations.id, id),
							eq(destinations.signingSecretEnc, existing.signingSecretEnc),
						),
					)
					.returning(),
				auditInsertIfChanged(db, {
					actor: c.var.actor?.email ?? "",
					at: ts,
					action: "destination.secret_rotated",
					resourceType: "destination",
					resourceId: id,
					reason: body.value.reason,
					diff: {
						grace_hours: body.value.grace_hours,
						prev_expires_at: cols.prevExpiresAt,
						new_fingerprint: fingerprint,
					},
				}),
			]);
			if (!row) return c.json({ error: "conflict" }, 409);
			return c.json({
				...(await toDestination(env, row, ts)),
				signing_secret: secret,
			});
		},
	);

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
				const ts = now();
				const [[row]] = await db.batch([
					transitionDestinationStmt(db, id, "active", "paused", ts),
					auditInsertIfChanged(db, {
						actor: c.var.actor?.email ?? "",
						at: ts,
						action: "destination.paused",
						resourceType: "destination",
						resourceId: id,
						reason: body.value.reason,
					}),
				]);
				if (row) return c.json(await toDestination(env, row, ts));
			}
			const s = await settled(c, id, "paused");
			if (s.response) return s.response;
			return c.json(await toDestination(env, s.row, now()));
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
				const ts = deps.now();
				const [[transitioned]] = await deps.db.batch([
					transitionDestinationStmt(deps.db, id, "paused", "active", ts),
					auditInsertIfChanged(deps.db, {
						actor: c.var.actor?.email ?? "",
						at: ts,
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
				destination: await toDestination(deps.env, row, deps.now()),
				resumed: moved.length,
			});
		},
	);

	routes.post(
		"/:id/test",
		requirePermission("destinations.operate"),
		async (c) => {
			const body = await readOptionalJson(c, testDeliveryRequest);
			if (!body.ok) return body.response;
			const deps = c.var.deps;
			const id = c.req.param("id");
			const destination = await getDestination(deps.db, id);
			if (!destination) return c.json({ error: "not_found" }, 404);
			if (destination.status === "disabled") {
				return c.json({ error: "destination_disabled" }, 409);
			}
			const startedAt = deps.now();
			const testId = newId("tst", startedAt);
			const payload = new Uint8Array(
				new TextEncoder().encode(
					JSON.stringify(
						body.value.payload ?? {
							type: "hookflare.test",
							destination_id: id,
							timestamp: startedAt,
						},
					),
				),
			);

			let outcome: {
				durationMs: number;
				httpStatus: number | null;
				errorKind: TestErrorKind | null;
				errorMessage: string | null;
				snippet: string | null;
			};
			let ssrf: Awaited<ReturnType<typeof checkUrl>>;
			try {
				ssrf = await checkUrl(destination.url, deps);
			} catch (err) {
				if (err instanceof DnsError) {
					c.var.logger.warn("admin.dns_failed", { error: err });
					return c.json({ error: "unavailable" }, 503);
				}
				throw err;
			}
			if (!ssrf.ok) {
				outcome = {
					durationMs: 0,
					httpStatus: null,
					errorKind: "ssrf_blocked",
					errorMessage: ssrf.reason,
					snippet: null,
				};
			} else {
				const timeoutMs = resolvePolicy(
					destination,
					await loadRetryDefaults(deps),
				).timeoutMs;
				const timestampSec = Math.floor(startedAt / 1000);
				const secrets = await destinationSigningSecrets(
					deps.env,
					destination,
					startedAt,
				);
				const signature = await signWebhookAll({
					id: testId,
					timestampSec,
					body: payload,
					secrets,
				});
				const sent = await sendSigned(deps, {
					url: destination.url,
					headers: buildOutboundHeaders({
						storedHeaders: {},
						contentType: "application/json",
						deliveryId: testId,
						timestampSec,
						signature,
					}),
					body: payload,
					timeoutMs,
				});
				const failure = failureOf(sent.result, timeoutMs);
				outcome = {
					durationMs: sent.durationMs,
					httpStatus:
						sent.result.kind === "response" ? sent.result.status : null,
					errorKind: failure?.errorKind ?? null,
					errorMessage: failure?.message ?? null,
					snippet: sent.snippet,
				};
			}

			const row: TestDeliveryRow = {
				id: testId,
				destinationId: id,
				projectId: destination.projectId,
				actorEmail: c.var.actor?.email ?? "",
				startedAt,
				durationMs: outcome.durationMs,
				httpStatus: outcome.httpStatus,
				errorKind: outcome.errorKind,
				errorMessage: outcome.errorMessage,
				responseSnippet: outcome.snippet,
			};
			await deps.db.batch([
				deps.db.insert(testDeliveries).values(row),
				auditStmt(c, {
					action: "destination.tested",
					resourceType: "destination",
					resourceId: id,
					reason: body.value.reason,
					diff: {
						test_delivery_id: testId,
						http_status: outcome.httpStatus,
						error_kind: outcome.errorKind,
					},
				}),
			]);
			const dto = toTestDelivery(row);
			return c.json({
				id: dto.id,
				http_status: dto.http_status,
				duration_ms: dto.duration_ms,
				error_kind: dto.error_kind,
				error_message: dto.error_message,
				response_snippet: dto.response_snippet,
			});
		},
	);

	routes.get("/:id/tests", requirePermission("events.read"), async (c) => {
		const q = readQuery(c, pageQuery);
		if (!q.ok) return q.response;
		const after = decodeCursor(q.value.cursor);
		if (after === "invalid") return badCursor(c);
		const { db } = c.var.deps;
		const id = c.req.param("id");
		if (!(await getDestination(db, id)))
			return c.json({ error: "not_found" }, 404);
		const rows = await listTestDeliveries(db, id, {
			after: after ?? undefined,
			limit: q.value.limit,
		});
		const page = rows.slice(0, q.value.limit);
		const last = page.at(-1);
		return c.json({
			data: page.map(toTestDelivery),
			next_cursor:
				rows.length > q.value.limit && last
					? encodeCursor(last.startedAt, last.id)
					: null,
		} satisfies Page<TestDelivery>);
	});

	return routes;
}
