import { decryptSecret } from "../core/crypto";
import {
	claimDelivery,
	type DeliveryContext,
	finishWithoutAttempt,
	loadDeliveryContext,
	recordAttempt,
} from "../core/db/deliveries";
import { DnsError } from "../core/dns";
import { createLogger, type Logger } from "../core/log";
import { checkUrl } from "../core/ssrf";
import type { DeliveryMessage, Deps } from "../deps";
import { classifyError, classifyResponse, type Outcome } from "./classify";
import { buildOutboundHeaders, signWebhook } from "./sign";

export const DEFAULT_TIMEOUT_MS = 10_000;
export const SNIPPET_BYTES = 2048;

/** At most `maxBytes` of the body as lossy UTF-8; stream errors keep what was read. */
export async function readSnippet(
	response: Response,
	maxBytes = SNIPPET_BYTES,
): Promise<string | null> {
	if (!response.body) {
		return null;
	}
	const reader = response.body.getReader();
	const buf = new Uint8Array(maxBytes);
	let len = 0;
	try {
		while (len < maxBytes) {
			const { done, value } = await reader.read();
			if (done) break;
			const take = Math.min(value.byteLength, maxBytes - len);
			buf.set(value.subarray(0, take), len);
			len += take;
		}
	} catch {
		// Keep the partial snippet; the HTTP status already decided the outcome.
	} finally {
		reader.cancel().catch(() => {});
	}
	return len === 0 ? null : new TextDecoder().decode(buf.subarray(0, len));
}

async function send(
	deps: Deps,
	ctx: DeliveryContext,
): Promise<{ outcome: Outcome; snippet: string | null }> {
	const { delivery, event, destination } = ctx;
	const timeoutMs = destination.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	try {
		const secret = await decryptSecret(
			deps.env,
			destination.signingSecretEnc,
			`destinations.signing_secret_enc:${destination.id}`,
		);
		const body = new Uint8Array(
			event.bodyInline ?? new Uint8Array(),
		) as Uint8Array<ArrayBuffer>;
		const timestampSec = Math.floor(deps.now() / 1000);
		const signature = await signWebhook({
			id: delivery.id,
			timestampSec,
			body,
			secret,
		});
		const response = await deps.fetch(destination.url, {
			method: "POST",
			headers: buildOutboundHeaders({
				storedHeaders: event.headersJson,
				contentType: event.contentType,
				deliveryId: delivery.id,
				eventId: event.id,
				timestampSec,
				signature,
			}),
			body,
			redirect: "manual",
			signal: AbortSignal.timeout(timeoutMs),
		});
		return {
			outcome: classifyResponse(response.status),
			snippet: await readSnippet(response),
		};
	} catch (err) {
		return { outcome: classifyError(err, timeoutMs), snippet: null };
	}
}

export async function processDelivery(
	deps: Deps,
	deliveryId: string,
	logger: Logger,
): Promise<"ack" | "retry"> {
	let ctx: DeliveryContext | null;
	try {
		ctx = await loadDeliveryContext(deps, deliveryId);
	} catch (err) {
		logger.error("delivery.load_failed", {
			delivery_id: deliveryId,
			error: String(err),
		});
		return "retry";
	}
	if (!ctx) {
		logger.warn("delivery.not_found", { delivery_id: deliveryId });
		return "ack";
	}
	if (ctx.delivery.status !== "pending" && ctx.delivery.status !== "queued") {
		logger.info("delivery.skipped", {
			delivery_id: deliveryId,
			status: ctx.delivery.status,
		});
		return "ack";
	}

	const finish = async (lastError: string) => {
		await finishWithoutAttempt(deps, deliveryId, lastError);
		logger.warn("delivery.failed_without_attempt", {
			delivery_id: deliveryId,
			reason: lastError,
		});
		return "ack" as const;
	};

	try {
		if (ctx.destination.status === "disabled") {
			return await finish("destination_disabled");
		}
		try {
			const check = await checkUrl(ctx.destination.url, deps);
			if (!check.ok) {
				return await finish(`ssrf_blocked: ${check.reason}`);
			}
		} catch (err) {
			if (err instanceof DnsError) {
				return await finish("dns_error");
			}
			throw err;
		}
		if (!(await claimDelivery(deps, deliveryId))) {
			logger.info("delivery.skipped", {
				delivery_id: deliveryId,
				status: "claimed_elsewhere",
			});
			return "ack";
		}
	} catch (err) {
		logger.error("delivery.update_failed", {
			delivery_id: deliveryId,
			error: String(err),
		});
		return "retry";
	}

	const startedAt = deps.now();
	const { outcome, snippet } = await send(deps, ctx);
	const durationMs = Math.max(0, deps.now() - startedAt);
	try {
		await recordAttempt(deps, ctx, { startedAt, durationMs, outcome, snippet });
	} catch (err) {
		logger.error("delivery.record_failed", {
			delivery_id: deliveryId,
			error: String(err),
		});
		return "retry";
	}
	logger.info("delivery.attempted", {
		delivery_id: deliveryId,
		status: outcome.status,
		http_status: outcome.httpStatus,
		error_kind: outcome.errorKind,
		duration_ms: durationMs,
	});
	return "ack";
}

export async function handleDeliveryBatch(
	batch: MessageBatch<DeliveryMessage>,
	deps: Deps,
): Promise<void> {
	const logger = createLogger(deps.env, { queue: batch.queue });
	await Promise.all(
		batch.messages.map(async (msg) => {
			const result = await processDelivery(deps, msg.body.deliveryId, logger);
			if (result === "ack") msg.ack();
			else msg.retry();
		}),
	);
}
