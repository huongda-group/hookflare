import { drizzle } from "drizzle-orm/d1";
import { vi } from "vitest";
import * as schema from "../../src/core/db/schema";
import type { Db, DeliveryMessage, Deps } from "../../src/deps";
import { testEnv } from "./env";

export const PUBLIC_IP = "93.184.216.34";

export type RecordingQueue = Queue<DeliveryMessage> & {
	sent: DeliveryMessage[];
	/** delaySeconds of each send, parallel to `sent`. */
	delays: (number | undefined)[];
};

/** Stands in for env.QUEUE: a real send would run the consumer inside tests. */
export function recordingQueue(
	options: { fail?: boolean } = {},
): RecordingQueue {
	const sent: DeliveryMessage[] = [];
	const delays: (number | undefined)[] = [];
	const queue = {
		sent,
		delays,
		async send(body: DeliveryMessage, opts?: QueueSendOptions) {
			if (options.fail) {
				throw new Error("queue unavailable");
			}
			sent.push(body);
			delays.push(opts?.delaySeconds);
		},
		async sendBatch(messages: Iterable<MessageSendRequest<DeliveryMessage>>) {
			for (const m of messages) {
				await queue.send(m.body, { delaySeconds: m.delaySeconds });
			}
		},
	};
	return queue as unknown as RecordingQueue;
}

/** Records create() calls; get().status() reports `status` (default "complete"). */
export function fakeArchive(status = "complete") {
	const created: string[] = [];
	const archive = {
		created,
		async create(opts?: { id?: string }) {
			const id = opts?.id ?? crypto.randomUUID();
			if (created.includes(id))
				throw new Error(`instance.already_exists: ${id}`);
			created.push(id);
			return { id };
		},
		async get(id: string) {
			if (!created.includes(id) && status === "missing")
				throw new Error("instance.not_found");
			return { id, status: async () => ({ status }) };
		},
	};
	return archive as unknown as Workflow & { created: string[] };
}

export function testDeps(overrides: Partial<Deps> = {}): Deps {
	const env = overrides.env ?? testEnv();
	return {
		db: drizzle(env.DB, { schema }),
		queue: recordingQueue(),
		payloads: env.PAYLOADS,
		fetch: vi.fn(
			async () => new Response("ok", { status: 200 }),
		) as unknown as typeof fetch,
		resolveDns: vi.fn(async () => [PUBLIC_IP]),
		now: () => Date.now(),
		// Unlimited destinations never call it (M5-6); a test that sets limits injects fakeLimiter().
		limiter: () => {
			throw new Error("limiter not stubbed: use fakeLimiter()");
		},
		archive: fakeArchive(),
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
