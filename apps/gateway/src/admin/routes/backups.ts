import { Hono } from "hono";
import type { AppBindings } from "../../app";
import { eq } from "drizzle-orm";
import {
	isBackupRunning,
	newBackupRow,
	readBackupSummary,
	startBackupRun,
} from "../../core/backup-run";
import { backups } from "../../core/db/schema";
import { newId } from "../../core/ids";
import { requirePermission } from "../auth/permission";
import { auditStmt } from "../http";

export function backupRoutes() {
	const routes = new Hono<AppBindings>();

	routes.get("/summary", requirePermission("events.read"), async (c) => {
		return c.json(await readBackupSummary(c.var.deps));
	});

	routes.post("/run", requirePermission("settings.manage"), async (c) => {
		const deps = c.var.deps;
		// Also fails `running` rows whose instance is gone, so they stop blocking.
		if (await isBackupRunning(deps))
			return c.json({ error: "backup_running" }, 409);
		const day = new Date(deps.now()).toISOString().slice(0, 10);
		const backupId = `backup-${day}-manual-${newId("bkp").slice(4).toLowerCase()}`;
		// The row and its audit land together. `backups_one_running_idx`
		// makes a racing second POST fail its insert, so only one wins.
		try {
			await deps.db.batch([
				deps.db
					.insert(backups)
					.values(newBackupRow(deps.now(), backupId, "manual")),
				auditStmt(c, {
					action: "backup.run",
					resourceType: "backup",
					resourceId: backupId,
				}),
			]);
		} catch (err) {
			if (/unique/i.test(String(err)))
				return c.json({ error: "backup_running" }, 409);
			throw err;
		}
		// The Workflow cannot join the batch: start it after, and fail the row
		// if it does not start so it never blocks the next run.
		try {
			await startBackupRun(
				deps,
				{ instanceId: backupId, backupId, trigger: "manual" },
				c.var.logger,
			);
		} catch (err) {
			await deps.db
				.update(backups)
				.set({ status: "failed", error: `start failed: ${String(err)}` })
				.where(eq(backups.id, backupId));
			throw err;
		}
		return c.json({ backup_id: backupId, instance_id: backupId }, 202);
	});

	return routes;
}
