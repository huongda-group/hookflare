import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";
import * as schema from "./core/db/schema";
import { createDohResolver, type ResolveDns } from "./core/dns";
import type { AppEnv } from "./env";

export type DeliveryMessage = { deliveryId: string };
export type Db = DrizzleD1Database<typeof schema>;

/**
 * Everything a handler needs from the outside world. Handlers never touch
 * env.DB / env.QUEUE / global fetch, so tests can stub network, DNS, and time
 * (and M2 can wrap db/queue for fault injection).
 */
export type Deps = {
	db: Db;
	queue: Queue<DeliveryMessage>;
	/** Outbound calls to backends. */
	fetch: typeof fetch;
	resolveDns: ResolveDns;
	/** Epoch ms. */
	now: () => number;
	env: AppEnv;
};

export function createDeps(env: AppEnv): Deps {
	const globalFetch: typeof fetch = (input, init) => fetch(input, init);
	return {
		db: drizzle(env.DB, { schema }),
		queue: env.QUEUE as Queue<DeliveryMessage>,
		fetch: globalFetch,
		resolveDns: createDohResolver(globalFetch),
		now: () => Date.now(),
		env,
	};
}
