import {
	acquireLease,
	type DeliveryContext,
	finishWithoutAttempt,
	holdDelivery,
	isClaimable,
	loadDeliveryContext,
	recordLeasedAttempt,
} from "../core/db/deliveries";
import { DnsError } from "../core/dns";
import { createLogger, type Logger } from "../core/log";
import { readSnippet, SNIPPET_BYTES, sendSigned } from "../core/outbound";
import { loadPayload } from "../core/payloads";
import { resolvePolicy } from "../core/policy";
import { destinationSigningSecrets } from "../core/secrets";
import { buildOutboundHeaders, signWebhookAll } from "../core/sign";
import { checkUrl } from "../core/ssrf";
import type { DeliveryMessage, Deps } from "../deps";
import { infraDelaySeconds } from "./backoff";
import { classifyAttempt, type SendResult } from "./classify";

export { readSnippet, SNIPPET_BYTES };
/** The lease outlives the request timeout by this much (spec §7 step 7). */
export const LEASE_GRACE_MS = 30_000;

export type Disposition =
	| { action: "ack" }
	| { action: "retry"; delaySeconds: number };
const ACK: Disposition = { action: "ack" };

type SignedRequest = {
	body: Uint8Array<ArrayBuffer>;
	timestampSec: number;
	signature: string;
};

async function sign(
	deps: Deps,
	ctx: DeliveryContext,
	body: Uint8Array<ArrayBuffer>,
): Promise<SignedRequest> {
	const secrets = await destinationSigningSecrets(
		deps.env,
		ctx.destination,
		deps.now(),
	);
	const timestampSec = Math.floor(deps.now() / 1000);
	const signature = await signWebhookAll({
		id: ctx.delivery.id,
		timestampSec,
		body,
		secrets,
	});
	return { body, timestampSec, signature };
}

async function send(
	deps: Deps,
	ctx: DeliveryContext,
	{ body, timestampSec, signature }: SignedRequest,
	timeoutMs: number,
): Promise<{ result: SendResult; snippet: string | null }> {
	const { delivery, event, destination } = ctx;
	const { result, snippet } = await sendSigned(deps, {
		url: destination.url,
		headers: buildOutboundHeaders({
			storedHeaders: event.headersJson,
			contentType: event.contentType,
			deliveryId: delivery.id,
			eventId: event.id,
			timestampSec,
			signature,
		}),
		body,
		timeoutMs,
	});
	return { result, snippet };
}

/** Spec §7 steps 1–10. Infra errors never count as attempts (msg.retry instead). */
export async function processDelivery(
	deps: Deps,
	deliveryId: string,
	logger: Logger,
	msgAttempts = 1,
): Promise<Disposition> {
	const infra = (stage: string, err: unknown): Disposition => {
		const delaySeconds = infraDelaySeconds(msgAttempts);
		logger.error("delivery.infra_retry", {
			delivery_id: deliveryId,
			stage,
			msg_attempts: msgAttempts,
			delay_s: delaySeconds,
			error: String(err),
		});
		return { action: "retry", delaySeconds };
	};

	// 1–2. Load; skip anything another worker owns or already finished.
	let ctx: DeliveryContext | null;
	try {
		ctx = await loadDeliveryContext(deps, deliveryId);
	} catch (err) {
		return infra("load", err);
	}
	if (!ctx) {
		logger.warn("delivery.not_found", { delivery_id: deliveryId });
		return ACK;
	}
	if (!isClaimable(ctx.delivery, deps.now())) {
		logger.info("delivery.skipped", {
			delivery_id: deliveryId,
			status: ctx.delivery.status,
		});
		return ACK;
	}
	// A duplicate message must not cut the backoff short; the due one still arrives
	// (it is sent after next_attempt_at is recorded), and the reconciler resends it if
	// lost. Ack instead of re-delaying: native retries would carry it to the DLQ.
	const { nextAttemptAt } = ctx.delivery;
	if (
		ctx.delivery.status === "retrying" &&
		nextAttemptAt !== null &&
		nextAttemptAt > deps.now()
	) {
		logger.info("delivery.not_due", {
			delivery_id: deliveryId,
			delay_s: Math.ceil((nextAttemptAt - deps.now()) / 1000),
		});
		return ACK;
	}
	const policy = resolvePolicy(ctx.destination);
	const finish = async (lastError: string) => {
		await finishWithoutAttempt(deps, deliveryId, lastError);
		logger.warn("delivery.failed_without_attempt", {
			delivery_id: deliveryId,
			reason: lastError,
		});
		return ACK;
	};

	// 3–6. Checks before the lease (spec M2-2): none of them counts as an attempt.
	let request: SignedRequest;
	try {
		if (ctx.destination.status === "paused") {
			await holdDelivery(deps, deliveryId);
			logger.info("delivery.held", { delivery_id: deliveryId });
			return ACK;
		}
		if (ctx.destination.status === "disabled") {
			return await finish("destination_disabled");
		}
		let body: Uint8Array<ArrayBuffer> | null;
		try {
			body = await loadPayload(deps, ctx.event);
		} catch (err) {
			return infra("r2", err);
		}
		if (!body) {
			return await finish("payload_missing");
		}
		try {
			const check = await checkUrl(ctx.destination.url, deps);
			if (!check.ok) {
				return await finish(`ssrf_blocked: ${check.reason}`);
			}
		} catch (err) {
			return infra(err instanceof DnsError ? "dns" : "ssrf", err);
		}
		try {
			request = await sign(deps, ctx, body);
		} catch (err) {
			logger.error("delivery.sign_failed", {
				delivery_id: deliveryId,
				error: String(err),
			});
			return await finish("signing_failed");
		}
	} catch (err) {
		return infra("d1", err);
	}

	// 7. Lease.
	const leaseUntil = deps.now() + policy.timeoutMs + LEASE_GRACE_MS;
	let attemptCount: number | null;
	try {
		attemptCount = await acquireLease(deps, deliveryId, leaseUntil);
	} catch (err) {
		return infra("lease", err);
	}
	if (attemptCount === null) {
		logger.info("delivery.skipped", {
			delivery_id: deliveryId,
			status: "claimed_elsewhere",
		});
		return ACK;
	}

	// 8. Send.
	const attemptNo = attemptCount + 1;
	const startedAt = deps.now();
	const { result, snippet } = await send(deps, ctx, request, policy.timeoutMs);
	const durationMs = Math.max(0, deps.now() - startedAt);
	const outcome = classifyAttempt(result, {
		attemptNo,
		policy,
		now: deps.now(),
		random: Math.random,
	});

	// 9. Record, fenced by the lease.
	let recorded: boolean;
	try {
		recorded = await recordLeasedAttempt(deps, deliveryId, {
			attemptNo,
			startedAt,
			durationMs,
			outcome,
			snippet,
			leaseUntil,
		});
	} catch (err) {
		return infra("record", err);
	}
	if (!recorded) {
		logger.warn("delivery.lease_lost", {
			delivery_id: deliveryId,
			attempt_no: attemptNo,
		});
		return ACK;
	}
	logger.info("delivery.attempted", {
		delivery_id: deliveryId,
		attempt_no: attemptNo,
		status: outcome.status,
		http_status: outcome.httpStatus,
		error_kind: outcome.errorKind,
		duration_ms: durationMs,
	});
	if (outcome.status === "dead") {
		logger.warn("delivery.dead", {
			delivery_id: deliveryId,
			reason: "budget",
			attempt_no: attemptNo,
		});
	}
	if (outcome.status !== "retrying") {
		return ACK;
	}

	// 10. Reschedule as a new message (spec M2-1).
	const { delaySeconds } = outcome;
	try {
		await deps.queue.send({ deliveryId }, { delaySeconds });
		logger.info("delivery.retry_scheduled", {
			delivery_id: deliveryId,
			attempt_no: attemptNo,
			delay_s: delaySeconds,
		});
		return ACK;
	} catch (err) {
		logger.error("delivery.reschedule_failed", {
			delivery_id: deliveryId,
			error: String(err),
		});
		return { action: "retry", delaySeconds };
	}
}

export function deliveryIdOf(body: unknown): string | null {
	const id = (body as Partial<DeliveryMessage> | null)?.deliveryId;
	return typeof id === "string" ? id : null;
}

export async function handleDeliveryBatch(
	batch: MessageBatch<DeliveryMessage>,
	deps: Deps,
): Promise<void> {
	const logger = createLogger(deps.env, { queue: batch.queue });
	await Promise.all(
		batch.messages.map(async (msg) => {
			const deliveryId = deliveryIdOf(msg.body);
			if (deliveryId === null) {
				// Retrying cannot fix a bad payload; drop it instead of burning retries.
				logger.error("delivery.malformed_message", { message_id: msg.id });
				msg.ack();
				return;
			}
			let d: Disposition;
			try {
				d = await processDelivery(deps, deliveryId, logger, msg.attempts);
			} catch (err) {
				// A bug in one message must not retry the rest of the batch.
				const delaySeconds = infraDelaySeconds(msg.attempts);
				logger.error("delivery.infra_retry", {
					delivery_id: deliveryId,
					stage: "unexpected",
					msg_attempts: msg.attempts,
					delay_s: delaySeconds,
					error: String(err),
				});
				d = { action: "retry", delaySeconds };
			}
			if (d.action === "ack") msg.ack();
			else msg.retry({ delaySeconds: d.delaySeconds });
		}),
	);
}
