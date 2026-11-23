import { vi } from "vitest";
import type { DeliveryMessage } from "../../src/deps";

export function fakeMessage(body: unknown, attempts = 1) {
	return {
		id: crypto.randomUUID(),
		timestamp: new Date(),
		body,
		attempts,
		ack: vi.fn(),
		retry: vi.fn(),
	};
}

export function fakeBatch(
	queue: string,
	messages: ReturnType<typeof fakeMessage>[],
): MessageBatch<DeliveryMessage> {
	return {
		queue,
		messages,
		ackAll: vi.fn(),
		retryAll: vi.fn(),
	} as unknown as MessageBatch<DeliveryMessage>;
}
