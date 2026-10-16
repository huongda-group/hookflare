import { Hono } from "hono";
import type { AppBindings } from "../../app";
import {
	isBackupRunning,
	readBackupSummary,
	startBackupRun,
} from "../../core/backup-run";
import { newId } from "../../core/ids";
import { requirePermission } from "../auth/permission";
import { auditStmt } from "../http";

export function backupRoutes() {
	const routes = new Hono<AppBindings>();

	routes.get("/summary", requirePermission("settings.manage"), async (c) => {
		return c.json(await readBackupSummary(c.var.deps));
	});

	routes.post("/run", requirePermission("settings.manage"), async (c) => {
		const deps = c.var.deps;
		if (await isBackupRunning(deps))
			return c.json({ error: "backup_running" }, 409);
		const day = new Date(deps.now()).toISOString().slice(0, 10);
		const instanceId = `backup-${day}-manual-${newId("bkp").slice(4).toLowerCase()}`;
		await startBackupRun(deps, { instanceId, trigger: "manual" }, c.var.logger);
		// The run is already started and cannot share a transaction with the
		// audit row; if the audit write fails, the start must not be silent.
		try {
			await deps.db.batch([
				auditStmt(c, {
					action: "backup.run",
					resourceType: "backup",
					resourceId: instanceId,
				}),
			]);
		} catch (err) {
			c.var.logger.error("backup.run_audit_failed", {
				instance_id: instanceId,
				error: String(err),
			});
			throw err;
		}
		return c.json({ backup_id: instanceId, instance_id: instanceId }, 202);
	});

	return routes;
}
