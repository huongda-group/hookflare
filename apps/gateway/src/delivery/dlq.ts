import { markDeadFromDlq } from "../core/db/deliveries";
import { createLogger } from "../core/log";
import type { DeliveryMessage, Deps } from "../deps";
import { deliveryIdOf } from "./consumer";

export const DLQ_QUEUE = "hookflare-deliveries-dlq";

/** Messages land here after 20 consecutive infra failures (spec M2-6). Alerts are M5. */
export async function handleDlqBatch(
	batch: MessageBatch<DeliveryMessage>,
	deps: Deps,
): Promise<void> {
	const logger = createLogger(deps.env, { queue: batch.queue });
	await Promise.all(
		batch.messages.map(async (msg) => {
			const deliveryId = deliveryIdOf(msg.body);
			if (deliveryId === null) {
				logger.error("delivery.malformed_message", { message_id: msg.id });
				msg.ack();
				return;
			}
			try {
				if (await markDeadFromDlq(deps, deliveryId)) {
					logger.warn("delivery.dead", {
						delivery_id: deliveryId,
						reason: "dlq",
					});
				} else {
					logger.info("delivery.dlq_skipped", { delivery_id: deliveryId });
				}
				msg.ack();
			} catch (err) {
				logger.error("delivery.dlq_failed", {
					delivery_id: deliveryId,
					error: String(err),
				});
				msg.retry();
			}
		}),
	);
}
