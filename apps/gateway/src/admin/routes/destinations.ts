import {
	createDestinationRequest,
	type Destination,
	type DestinationStats,
	listQuery,
	operateRequest,
	type Page,
	pageQuery,
	patchDestinationRequest,
	RANGE_HOURS,
	rotateDestinationSecretRequest,
	statsQuery,
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
import { destinationStats, statsWindow } from "../../core/db/stats";
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
import { can } from "../../core/rbac";
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
import { sha256Hex } from "../auth/secrets";
import { decodeCursor, encodeCursor } from "../cursor";
import {
	auditStmt,
	badCursor,
	checkCreateProject,
	guardUrl,
	paginate,
	readJson,
	readOptionalJson,
	readProjectResource,
	readQuery,
} from "../http";
import { successRate } from "./overview";

function generateSigningSecret(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return `whsec_${btoa(String.fromCharCode(...bytes))}`;
}

export function maskUrl(url: string): string {
	const u = new URL(url);
	return u.pathname !== "/" || u.search || u.hash ? `${u.origin}/…` : u.origin;
}

function canWriteConfig(c: Context<AppBindings>): boolean {
	const role = c.var.actor?.role ?? /* istanbul ignore next */ "viewer";
	return can(role, "config.write");
}

export async function toDestination(
	env: AppEnv,
	row: DestinationRow,
	now: number = Date.now(),
	showUrl = false,
): Promise<Destination> {
	const live =
		row.signingSecretPrevEnc &&
		row.signingSecretPrevExpiresAt !== null &&
		row.signingSecretPrevExpiresAt > now;
	return {
		id: row.id,
		project_id: row.projectId,
		name: row.name,
		url: showUrl ? row.url : maskUrl(row.url),
		status: row.status,
		timeout_ms: row.timeoutMs,
		max_attempts: row.maxAttempts,
		backoff_base_s: row.backoffBaseS,
		backoff_max_s: row.backoffMaxS,
		max_in_flight: row.maxInFlight,
		rate_limit_per_s: row.rateLimitPerS,
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
		const mismatch = checkCreateProject(c, fields.project_id);
		if (mismatch) return mismatch;
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
			maxInFlight: fields.max_in_flight ?? null,
			rateLimitPerS: fields.rate_limit_per_s ?? null,
			consecutiveFailures: 0,
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
			{
				...(await toDestination(env, row, ts, canWriteConfig(c))),
				signing_secret: signingSecret,
			},
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
		const data = await Promise.all(
			rows.map((r) => toDestination(env, r, ts, canWriteConfig(c))),
		);
		return c.json({
			data,
			next_cursor: nextCursor,
		} satisfies Page<Destination>);
	});

	routes.get("/stats", requirePermission("events.read"), async (c) => {
		const q = readQuery(c, statsQuery);
		if (!q.ok) return q.response;
		const { db, now } = c.var.deps;
		const rows = await destinationStats(db, {
			...statsWindow(now(), RANGE_HOURS[q.value.range]),
			projectId: q.value.project_id,
		});
		return c.json({
			data: rows.map(
				(r): DestinationStats => ({
					destination_id: r.destinationId,
					delivered: r.delivered,
					failed: r.failed,
					success_rate: successRate(r.delivered, r.failed),
					last_delivery_at: r.lastDeliveryAt,
					last_http_status: r.lastHttpStatus,
					last_error: r.lastError,
				}),
			),
		});
	});

	routes.get("/:id", requirePermission("events.read"), async (c) => {
		const found = await readProjectResource(c, () =>
			getDestination(c.var.deps.db, c.req.param("id")),
		);
		return found.ok
			? c.json(
					await toDestination(
						c.var.deps.env,
						found.value,
						c.var.deps.now(),
						canWriteConfig(c),
					),
				)
			: found.response;
	});

	routes.patch("/:id", requirePermission("config.write"), async (c) => {
		const body = await readJson(c, patchDestinationRequest);
		if (!body.ok) return body.response;
		const { db, now, env } = c.var.deps;
		const id = c.req.param("id");
		const found = await readProjectResource(c, () => getDestination(db, id));
		if (!found.ok) return found.response;
		const existing = found.value;
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
			...(v.max_in_flight !== undefined
				? { maxInFlight: v.max_in_flight }
				: {}),
			...(v.rate_limit_per_s !== undefined
				? { rateLimitPerS: v.rate_limit_per_s }
				: {}),
			...((v.url !== undefined && v.url !== existing.url) ||
			(v.status === "active" && existing.status !== "active")
				? { consecutiveFailures: 0 }
				: {}),
		};
		const touchesBackoff =
			v.backoff_base_s !== undefined || v.backoff_max_s !== undefined;
		const conflict = touchesBackoff
			? backoffConflict(
					c,
					{ ...existing, ...set },
					await loadRetryDefaults(c.var.deps),
				)
			: null;
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
		return c.json(await toDestination(env, row, ts, canWriteConfig(c)));
	});

	routes.post(
		"/:id/rotate-secret",
		requirePermission("config.write"),
		async (c) => {
			const body = await readOptionalJson(c, rotateDestinationSecretRequest);
			if (!body.ok) return body.response;
			const { db, now, env } = c.var.deps;
			const id = c.req.param("id");
			const found = await readProjectResource(c, () => getDestination(db, id));
			if (!found.ok) return found.response;
			const existing = found.value;
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
					actor: c.var.actor?.username ?? /* istanbul ignore next */ "",
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
				...(await toDestination(env, row, ts, canWriteConfig(c))),
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
			const found = await readProjectResource(c, () => getDestination(db, id));
			if (!found.ok) return found.response;
			const existing = found.value;
			if (existing.status === "active") {
				const ts = now();
				const [[row]] = await db.batch([
					transitionDestinationStmt(db, id, "active", "paused", ts),
					auditInsertIfChanged(db, {
						actor: c.var.actor?.username ?? /* istanbul ignore next */ "",
						at: ts,
						action: "destination.paused",
						resourceType: "destination",
						resourceId: id,
						reason: body.value.reason,
					}),
				]);
				if (row)
					return c.json(await toDestination(env, row, ts, canWriteConfig(c)));
			}
			const s = await settled(c, id, "paused");
			if (s.response) return s.response;
			return c.json(await toDestination(env, s.row, now(), canWriteConfig(c)));
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
			const found = await readProjectResource(c, () =>
				getDestination(deps.db, id),
			);
			if (!found.ok) return found.response;
			const existing = found.value;
			let row: DestinationRow | undefined;
			if (existing.status === "paused") {
				const ts = deps.now();
				const [[transitioned]] = await deps.db.batch([
					deps.db
						.update(destinations)
						.set({ status: "active", consecutiveFailures: 0, updatedAt: ts })
						.where(
							and(eq(destinations.id, id), eq(destinations.status, "paused")),
						)
						.returning(),
					auditInsertIfChanged(deps.db, {
						actor: c.var.actor?.username ?? /* istanbul ignore next */ "",
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
			const moved = await releasePausedDeliveries(deps, id, RESUME_BATCH);
			await enqueueThenMark(deps, moved, (chunk) =>
				markQueuedMany(deps, chunk),
			);
			return c.json({
				destination: await toDestination(
					deps.env,
					row,
					deps.now(),
					canWriteConfig(c),
				),
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
			if (body.value.payload !== undefined && !canWriteConfig(c)) {
				return c.json({ error: "forbidden", required: "config.write" }, 403);
			}
			const deps = c.var.deps;
			const id = c.req.param("id");
			const found = await readProjectResource(c, () =>
				getDestination(deps.db, id),
			);
			if (!found.ok) return found.response;
			const destination = found.value;
			if (destination.status === "disabled") {
				return c.json({ error: "destination_disabled" }, 409);
			}
			let defaults: Policy;
			try {
				defaults = await loadRetryDefaults(deps);
			} catch (err) {
				c.var.logger.warn("admin.settings_unavailable", { error: err });
				return c.json({ error: "unavailable" }, 503);
			}
			const startedAt = deps.now();
			const testId = newId("tst", startedAt);
			const payloadText = JSON.stringify(
				body.value.payload ?? {
					type: "hookflare.test",
					destination_id: id,
					timestamp: startedAt,
				},
			);
			const payload = new Uint8Array(new TextEncoder().encode(payloadText));

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
				const timeoutMs = resolvePolicy(destination, defaults).timeoutMs;
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
				const headers = buildOutboundHeaders({
					storedHeaders: {},
					contentType: "application/json",
					deliveryId: testId,
					timestampSec,
					signature,
				});
				headers.set("x-hookflare-test", "1");
				const sent = await sendSigned(deps, {
					url: destination.url,
					headers,
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
				actor: c.var.actor?.username ?? /* istanbul ignore next */ "",
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
						payload_sha256: await sha256Hex(payloadText),
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
		const found = await readProjectResource(c, () => getDestination(db, id));
		if (!found.ok) return found.response;
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
