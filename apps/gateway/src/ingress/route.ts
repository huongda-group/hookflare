import { Hono } from "hono";
import type { AppBindings } from "../app";
import { insertEventWithDelivery, markQueued } from "../core/db/events";
import { loadSourceBundle, type SourceBundle } from "../core/db/sources";
import { isId, newId } from "../core/ids";
import { redactHeaders } from "../core/log";
import { getCachedSource, setCachedSource } from "../core/source-cache";
import { bodyCap, readCappedBody } from "./body";
import { extractEventId } from "./event-id";
import { authHeaderName, verifiers } from "./verify";

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Public ingress (spec §6). Must not import from admin/. */
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

		// 1. Source bundle (cached 30 s, including not-found).
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

		// 2. Rate limit per source.
		const { success } = await deps.env.INGRESS_LIMITER.limit({ key: sourceId });
		if (!success) {
			return reject(429, "rate_limited");
		}

		// 3. Raw body, capped.
		let body: Uint8Array<ArrayBuffer> | null;
		try {
			body = await readCappedBody(c.req.raw, bodyCap(source.maxBodyBytes));
		} catch (err) {
			// The client went away mid-upload: their fault, not ours.
			return reject(400, "invalid_request", "body_read_failed", {
				error: String(err),
			});
		}
		if (!body) {
			return reject(413, "payload_too_large", "too_large");
		}

		// 4. Verify against the raw bytes.
		const url = new URL(c.req.url);
		const verdict = await verifiers[source.authType].verify({
			headers: c.req.raw.headers,
			url,
			body,
			config: source.authConfig,
			secret,
		});
		if (!verdict.ok) {
			return reject(401, "unauthorized", "unauthorized", {
				verify_failure: verdict.reason,
			});
		}

		// 5–6. Parse only after verification; redact credentials before storage.
		const now = deps.now();
		const eventId = newId("evt", now);
		const deliveryId = newId("dlv", now);
		const authHeader = authHeaderName(source.authType, source.authConfig);
		const headers = redactHeaders(
			c.req.raw.headers,
			authHeader ? [authHeader] : [],
		);

		// 7. Store event + delivery atomically.
		try {
			await insertEventWithDelivery(deps, {
				event: {
					id: eventId,
					projectId: source.projectId,
					sourceId,
					providerEventId: extractEventId(
						source.eventIdFrom,
						source.eventIdSelector,
						c.req.raw.headers,
						body,
					),
					receivedAt: now,
					headersJson: headers,
					contentType: c.req.header("content-type") ?? null,
					sizeBytes: body.byteLength,
					payloadSha256: await sha256Hex(body),
					bodyInline: body,
				},
				delivery: {
					id: deliveryId,
					eventId,
					destinationId: source.destinationId,
					projectId: source.projectId,
					kind: "initial",
					status: "pending",
					attemptCount: 0,
					createdAt: now,
				},
			});
		} catch (err) {
			logger.error("ingress.store_failed", {
				source_id: sourceId,
				error: String(err),
			});
			return c.json({ error: "unavailable" }, 503);
		}

		// 8. Enqueue. On failure the delivery stays pending (the M2 reconciler picks it up).
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

		// 9. Best effort: the consumer also accepts pending deliveries.
		try {
			await markQueued(deps, deliveryId);
		} catch (err) {
			logger.warn("ingress.mark_queued_failed", {
				delivery_id: deliveryId,
				error: String(err),
			});
		}

		logger.info("ingress.accepted", {
			source_id: sourceId,
			event_id: eventId,
			delivery_id: deliveryId,
			size_bytes: body.byteLength,
		});
		return c.json({ event_id: eventId }, 202);
	});

	return routes;
}
