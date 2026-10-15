import { describe, expect, it, type MockInstance, vi } from "vitest";
import { RECONCILE_CRON, runScheduled } from "../../src/jobs/scheduled";
import { testDeps } from "../helpers/deps";
import { faultyDeps } from "../helpers/faults";

const lines = (
	spy: MockInstance<typeof console.log> | MockInstance<typeof console.error>,
) => spy.mock.calls.map((c) => JSON.parse(c[0] as string).msg);

describe("runScheduled", () => {
	it("runs reconcile on the per-minute cron and logs one line", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		await runScheduled(RECONCILE_CRON, testDeps());
		expect(lines(log)).toContain("reconcile.run");
	});

	it("logs reconcile.failed instead of throwing", async () => {
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		const deps = faultyDeps(testDeps(), { d1: [{ match: /deliveries/ }] });
		await expect(runScheduled(RECONCILE_CRON, deps)).resolves.toBeUndefined();
		expect(lines(err)).toContain("reconcile.failed");
	});
});
