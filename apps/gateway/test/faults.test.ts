import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { clearAccessKeyCache } from "../src/admin/auth/access";
import { projects } from "../src/core/db/schema";
import { adminApp } from "./helpers/admin";
import { recordingQueue, testDeps } from "./helpers/deps";
import { faultyD1, faultyDeps, faultyQueue, faultyR2 } from "./helpers/faults";

describe("fault injection", () => {
	it("fails only the n-th matching D1 statement", async () => {
		const db = faultyD1(env.DB, [{ match: /SELECT 2/, on: { nth: 2 } }]);
		await expect(db.prepare("SELECT 2").first()).resolves.toBeTruthy();
		await expect(db.prepare("SELECT 2").first()).rejects.toThrow(/D1_ERROR/);
		await expect(db.prepare("SELECT 2").first()).resolves.toBeTruthy();
		await expect(db.prepare("SELECT 1").first()).resolves.toBeTruthy();
	});

	it("fails a batch containing a matching statement and passes others through", async () => {
		const db = faultyD1(env.DB, [{ match: /SELECT 3/, on: { from: 1 } }]);
		await expect(
			db.batch([
				db.prepare("SELECT 1"),
				db.prepare("SELECT ?").bind(3),
				db.prepare("SELECT 3"),
			]),
		).rejects.toThrow(/D1_ERROR/);
		const [r] = await db.batch([db.prepare("SELECT ? AS v").bind(9)]);
		expect(r.results).toEqual([{ v: 9 }]);
	});

	it("works underneath drizzle", async () => {
		const deps = faultyDeps(testDeps(), { d1: [{ match: /from "projects"/ }] });
		// drizzle wraps driver errors in DrizzleQueryError; the fault surfaces as `cause`.
		const err = await deps.db.query.projects.findFirst().then(
			() => null,
			(e: unknown) => e as Error & { cause?: unknown },
		);
		expect(err).toBeInstanceOf(Error);
		expect(String(err?.cause)).toMatch(/D1_ERROR/);
	});

	it("fails queue sends and R2 operations and logs R2 calls", async () => {
		const q = faultyQueue(recordingQueue(), [{ match: /^send$/ }]);
		await expect(q.send({ deliveryId: "x" })).rejects.toThrow();
		await expect(
			q.sendBatch([{ body: { deliveryId: "x" } }]),
		).resolves.toBeUndefined();

		const r2 = faultyR2(env.PAYLOADS, [{ match: /^get / }]);
		await r2.put("faults/a", "x");
		await expect(r2.get("faults/a")).rejects.toThrow();
		await r2.delete("faults/a");
		expect(r2.log).toEqual(["put faults/a", "get faults/a", "delete faults/a"]);
	});

	it("writes neither the mutation nor the audit row when the batch fails", async () => {
		const base = testDeps();
		await (await adminApp(base)).request("GET", "/me"); // bootstrap outside the fault
		clearAccessKeyCache(); // each adminApp mints fresh keys under the same kid
		const deps = faultyDeps(base, {
			d1: [{ match: /insert into "audit_logs"/i }],
		});
		const api = await adminApp(deps);
		const res = await api.request("POST", "/projects", {
			name: "Atomic",
			slug: `atomic-${crypto.randomUUID().slice(0, 8)}`,
		});
		expect(res.status).toBe(500);
		const rows = await base.db
			.select()
			.from(projects)
			.where(eq(projects.name, "Atomic"));
		expect(rows).toEqual([]);
	});
});
