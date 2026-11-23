import { Hono } from "hono";
import type { AppBindings } from "../app";
import { readCappedBody } from "../core/body";
import {
	eventExists,
	findEventIdByProviderId,
	insertEventWithDelivery,
	markQueued,
} from "../core/db/events";
import { loadSourceBundle, type SourceBundle } from "../core/db/sources";
import { storableHeaders } from "../core/headers";
import { isId, newId } from "../core/ids";
import {
	deletePayload,
	INLINE_BODY_LIMIT,
	payloadKey,
	putPayload,
} from "../core/payloads";
import { getCachedSource, setCachedSource } from "../core/source-cache";
import { bodyCap } from "./body";
import { extractEventId } from "./event-id";
import { authHeaderName, verifiers } from "./verify";

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function ingressRoutes() {
	const routes = new Hono<AppBindings>();

	routes.post("/:sourceId", async (c) => {
		const { deps, logger } = c.var;
		const sourceId = c.req.param("sourceId");
		const reject = (
			status: 400 | 401 | 404 | 413 | 429,
			error: string,
			reason: string = error,
			extra: Record<string, unknown> = {},
		) => {
			logger.info("ingress.rejected", {
				source_id: sourceId,
				reason,
				...extra,
			});
			return c.json({ error }, status);
		};

		if (!isId(sourceId, "src")) {
			return reject(404, "not_found");
		}
		let bundle: SourceBundle | null | undefined = getCachedSource(
			sourceId,
			deps.now(),
		);
		if (bundle === undefined) {
			try {
				bundle = await loadSourceBundle(deps, sourceId);
			} catch (err) {
				logger.error("ingress.lookup_failed", {
					source_id: sourceId,
					error: String(err),
				});
				return c.json({ error: "unavailable" }, 503);
			}
			setCachedSource(sourceId, bundle, deps.now());
		}
		if (
			bundle?.source.status !== "active" ||
			bundle.projectStatus !== "active"
		) {
			return reject(404, "not_found");
		}
		const { source, secret } = bundle;

		let success: boolean;
		try {
			({ success } = await deps.env.INGRESS_LIMITER.limit({ key: sourceId }));
		} catch (err) {
			logger.error("ingress.limiter_failed", {
				source_id: sourceId,
				error: String(err),
			});
			return c.json({ error: "unavailable" }, 503);
		}
		if (!success) {
			return reject(429, "rate_limited");
		}

		let body: Uint8Array<ArrayBuffer> | null;
		try {
			body = await readCappedBody(c.req.raw, bodyCap(source.maxBodyBytes));
		} catch (err) {
			return reject(400, "invalid_request", "body_read_failed", {
				error: String(err),
			});
		}
		if (!body) {
			return reject(413, "payload_too_large", "too_large");
		}

		const url = new URL(c.req.url);
		const verify = (s: string | null) =>
			verifiers[source.authType].verify({
				headers: c.req.raw.headers,
				url,
				body,
				config: source.authConfig,
				secret: s,
			});
		let verdict = await verify(secret);
		const { previousSecret, previousSecretExpiresAt } = bundle;
		if (
			!verdict.ok &&
			previousSecret &&
			previousSecretExpiresAt !== null &&
			previousSecretExpiresAt > deps.now()
		) {
			const prev = await verify(previousSecret);
			if (prev.ok) {
				verdict = prev;
				logger.info("ingress.verified_with_prev_secret", {
					source_id: source.id,
				});
			}
		}
		if (!verdict.ok) {
			return reject(401, "unauthorized", "unauthorized", {
				verify_failure: verdict.reason,
			});
		}

		const providerEventId = extractEventId(
			source.eventIdFrom,
			source.eventIdSelector,
			c.req.raw.headers,
			body,
		);
		const findDuplicate = () =>
			providerEventId === null
				? Promise.resolve(null)
				: findEventIdByProviderId(deps.db, sourceId, providerEventId);
		const duplicate = (existing: string) => {
			logger.info("ingress.duplicate", {
				source_id: sourceId,
				event_id: existing,
			});
			return c.json({ duplicate: true, event_id: existing }, 200);
		};
		try {
			const existing = await findDuplicate();
			if (existing) return duplicate(existing);
		} catch (err) {
			logger.error("ingress.lookup_failed", {
				source_id: sourceId,
				error: String(err),
			});
			return c.json({ error: "unavailable" }, 503);
		}

		const now = deps.now();
		const eventId = newId("evt", now);
		const deliveryId = newId("dlv", now);
		const authHeader = authHeaderName(source.authType, source.authConfig);
		const headers = storableHeaders(c.req.raw.headers, authHeader);
		const contentType = c.req.header("content-type") ?? null;
		const payloadSha256 = await sha256Hex(body);

		const r2Key =
			body.byteLength > INLINE_BODY_LIMIT ? payloadKey(eventId, now) : null;
		if (r2Key) {
			try {
				await putPayload(deps, r2Key, body, {
					sha256: payloadSha256,
					contentType,
				});
			} catch (err) {
				logger.error("ingress.r2_put_failed", {
					source_id: sourceId,
					event_id: eventId,
					error: String(err),
				});
				return c.json({ error: "unavailable" }, 503);
			}
		}
		const dropPayload = async () => {
			if (!r2Key) return;
			try {
				await deletePayload(deps, r2Key);
			} catch (err) {
				logger.warn("ingress.r2_cleanup_failed", {
					event_id: eventId,
					error: String(err),
				});
			}
		};

		const paused = bundle.destinationStatus === "paused";
		try {
			await insertEventWithDelivery(deps, {
				event: {
					id: eventId,
					projectId: source.projectId,
					sourceId,
					providerEventId,
					receivedAt: now,
					headersJson: headers,
					contentType,
					sizeBytes: body.byteLength,
					payloadSha256,
					bodyInline: r2Key ? new Uint8Array() : body,
					r2Key,
				},
				delivery: {
					id: deliveryId,
					eventId,
					destinationId: source.destinationId,
					projectId: source.projectId,
					kind: "initial",
					status: paused ? "paused" : "pending",
					attemptCount: 0,
					createdAt: now,
				},
			});
		} catch (err) {
			try {
				if (!(await eventExists(deps.db, eventId))) await dropPayload();
			} catch {}
			try {
				const existing = await findDuplicate();
				if (existing) return duplicate(existing);
			} catch {}
			logger.error("ingress.store_failed", {
				source_id: sourceId,
				error: String(err),
			});
			return c.json({ error: "unavailable" }, 503);
		}

		const accepted = () => {
			logger.info("ingress.accepted", {
				source_id: sourceId,
				event_id: eventId,
				delivery_id: deliveryId,
				size_bytes: body.byteLength,
				paused,
			});
			return c.json({ event_id: eventId }, 202);
		};
		if (paused) return accepted();

		try {
			await deps.queue.send({ deliveryId });
		} catch (err) {
			logger.error("ingress.enqueue_failed", {
				source_id: sourceId,
				event_id: eventId,
				delivery_id: deliveryId,
				error: String(err),
			});
			return c.json({ error: "unavailable" }, 503);
		}

		try {
			await markQueued(deps, deliveryId);
		} catch (err) {
			logger.warn("ingress.mark_queued_failed", {
				delivery_id: deliveryId,
				error: String(err),
			});
		}

		return accepted();
	});

	return routes;
}
