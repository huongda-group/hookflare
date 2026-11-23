import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";
import type { ArchiveParams } from "./core/archive-run";
import type { BackupParams } from "./core/backup-run";
import * as schema from "./core/db/schema";
import { createDohResolver, type ResolveDns } from "./core/dns";
import type { LimiterStub } from "./delivery/limiter";
import type { AppEnv } from "./env";

export type DeliveryMessage = { deliveryId: string };
export type Db = DrizzleD1Database<typeof schema>;

export type Deps = {
	db: Db;
	queue: Queue<DeliveryMessage>;
	payloads: R2Bucket;
	fetch: typeof fetch;
	resolveDns: ResolveDns;
	now: () => number;
	limiter: (destinationId: string) => LimiterStub;
	archive: Workflow<ArchiveParams>;
	backups: R2Bucket;
	backup: Workflow<BackupParams>;
	env: AppEnv;
};

export function createDeps(env: AppEnv): Deps {
	const globalFetch: typeof fetch = (input, init) => fetch(input, init);
	return {
		db: drizzle(env.DB, { schema }),
		queue: env.QUEUE as Queue<DeliveryMessage>,
		payloads: env.PAYLOADS,
		fetch: globalFetch,
		resolveDns: createDohResolver(globalFetch),
		now: () => Date.now(),
		limiter: (destinationId) =>
			env.LIMITER.get(
				env.LIMITER.idFromName(destinationId),
			) as unknown as LimiterStub,
		archive: env.ARCHIVE as Workflow<ArchiveParams>,
		backups: env.BACKUPS,
		backup: env.BACKUP as Workflow<BackupParams>,
		env,
	};
}
