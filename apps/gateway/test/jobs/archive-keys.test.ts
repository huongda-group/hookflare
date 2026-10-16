import { describe, expect, it } from "vitest";
import {
	batchPrefix,
	dayOf,
	dayStartOf,
	manifestKey,
	partKey,
} from "../../src/jobs/archive/keys";

describe("archive keys (spec §3.1)", () => {
	it("uses UTC days and batch-scoped prefixes", () => {
		expect(dayOf(Date.UTC(2026, 0, 2, 23, 59))).toBe("2026-01-02");
		expect(dayStartOf("2026-01-02")).toBe(Date.UTC(2026, 0, 2));
		const p = batchPrefix("events", "2026-01-02", "arb_1");
		expect(p).toBe("archive/2026/01/02/arb_1/");
		expect(batchPrefix("audit", "2026-01-02", "arb_2")).toBe(
			"archive/audit/2026/01/02/arb_2/",
		);
		expect(partKey(p, 3)).toBe("archive/2026/01/02/arb_1/part-0003.ndjson.gz");
		expect(manifestKey(p)).toBe("archive/2026/01/02/arb_1/manifest.json");
	});
});
