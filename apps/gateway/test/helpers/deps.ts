import { drizzle } from "drizzle-orm/d1";
import { vi } from "vitest";
import * as schema from "../../src/core/db/schema";
import type { Db, DeliveryMessage, Deps } from "../../src/deps";
import { testEnv } from "./env";

export const PUBLIC_IP = "93.184.216.34";

export type RecordingQueue = Queue<DeliveryMessage> & {
	sent: DeliveryMessage[];
};

/** Stands in for env.QUEUE: a real send would run the consumer inside tests. */
export function recordingQueue(
	options: { fail?: boolean } = {},
): RecordingQueue {
	const sent: DeliveryMessage[] = [];
	const queue = {
		sent,
		async send(body: DeliveryMessage) {
			if (options.fail) {
				throw new Error("queue unavailable");
			}
			sent.push(body);
		},
		async sendBatch(messages: Iterable<{ body: DeliveryMessage }>) {
			for (const m of messages) {
				await queue.send(m.body);
			}
		},
	};
	return queue as unknown as RecordingQueue;
}

export function testDeps(overrides: Partial<Deps> = {}): Deps {
	const env = overrides.env ?? testEnv();
	return {
		db: drizzle(env.DB, { schema }),
		queue: recordingQueue(),
		fetch: vi.fn(
			async () => new Response("ok", { status: 200 }),
		) as unknown as typeof fetch,
		resolveDns: vi.fn(async () => [PUBLIC_IP]),
		now: () => Date.now(),
		env,
		...overrides,
	};
}

/** A Db whose batch() rejects like an unavailable D1; everything else is real. */
export function withFailingBatch(db: Db): Db {
	return new Proxy(db, {
		get(target, prop, receiver) {
			if (prop === "batch") {
				return () => Promise.reject(new Error("D1_ERROR: simulated outage"));
			}
			return Reflect.get(target, prop, receiver);
		},
	});
}
