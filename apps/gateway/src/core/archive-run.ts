import type { ArchiveLastRun } from "@hookflare/shared";
import { eq } from "drizzle-orm";
import type { Deps } from "../deps";
import { settings } from "./db/schema";
import type { Logger } from "./log";
import { ARCHIVE_LAST_RUN_KEY, upsertSetting } from "./settings";

export const ARCHIVE_RUNNING = [
	"queued",
	"running",
	"waiting",
	"paused",
	"waitingForPause",
] as const;
export type ArchiveParams = { trigger: "cron" | "manual" };

/** A duplicate instance ID means today's run already started (M5-16). */
export async function startArchiveRun(
	deps: Deps,
	instanceId: string,
	trigger: ArchiveParams["trigger"],
	logger: Logger,
): Promise<"started" | "duplicate"> {
	try {
		await deps.archive.create({ id: instanceId, params: { trigger } });
	} catch (err) {
		if (/already.?exists|duplicate/i.test(String(err))) {
			logger.info("archive.already_started", { instance_id: instanceId });
			return "duplicate";
		}
		throw err;
	}
	await upsertSetting(
		deps.db,
		ARCHIVE_LAST_RUN_KEY,
		{ instance_id: instanceId, started_at: deps.now() },
		deps.now(),
	);
	logger.info("archive.started", { instance_id: instanceId, trigger });
	return "started";
}

/**
 * Unknown instances (expired from Workflows retention) count as not running.
 * Any other error counts as running: adopting a live instance's batches would
 * let two instances work on the same batch.
 */
export async function isArchiveRunning(
	deps: Deps,
	instanceId: string,
): Promise<boolean> {
	try {
		const { status } = await (await deps.archive.get(instanceId)).status();
		return (ARCHIVE_RUNNING as readonly string[]).includes(status);
	} catch (err) {
		return !/not.?found/i.test(String(err));
	}
}

export async function readLastRun(deps: Deps): Promise<ArchiveLastRun | null> {
	const row = await deps.db
		.select()
		.from(settings)
		.where(eq(settings.key, ARCHIVE_LAST_RUN_KEY))
		.get();
	if (!row) return null;
	const v = JSON.parse(row.valueJson) as {
		instance_id: string;
		started_at: number;
	};
	let status = "unknown";
	try {
		status = (await (await deps.archive.get(v.instance_id)).status()).status;
	} catch {
		// Instance expired from Workflows retention.
	}
	return { instance_id: v.instance_id, started_at: v.started_at, status };
}
