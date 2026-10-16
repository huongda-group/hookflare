import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { seedRows, toSqlFiles } from "../src/seed";

/** Deterministic RNG for tests (mulberry32). */
function seeded(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const AT = 1_760_000_000_000;

function collect(n: number, rng: () => number) {
	const rows = [...seedRows(n, rng, AT)];
	const byTable = new Map<string, Record<string, unknown>[]>();
	for (const r of rows) {
		const list = byTable.get(r.table) ?? [];
		list.push(r.row);
		byTable.set(r.table, list);
	}
	return byTable;
}

describe("seedRows status mix", () => {
	it("lands within ±2% of the 96/3/1 target with n = 1000", () => {
		const byTable = collect(1000, seeded(42));
		const deliveries = byTable.get("deliveries") ?? [];
		expect(deliveries.length).toBe(1000);
		const share = (status: string) =>
			deliveries.filter((d) => d.status === status).length / 1000;
		expect(share("delivered")).toBeGreaterThanOrEqual(0.94);
		expect(share("delivered")).toBeLessThanOrEqual(0.98);
		expect(share("failed_final")).toBeGreaterThanOrEqual(0.01);
		expect(share("failed_final")).toBeLessThanOrEqual(0.05);
		expect(share("dead")).toBeGreaterThanOrEqual(0);
		expect(share("dead")).toBeLessThanOrEqual(0.03);
	});
});

describe("seedRows shape", () => {
	it("yields one event and one delivery per event plus 1–3 attempts", () => {
		const byTable = collect(200, seeded(7));
		expect((byTable.get("webhook_events") ?? []).length).toBe(200);
		expect((byTable.get("deliveries") ?? []).length).toBe(200);
		const attempts = byTable.get("delivery_attempts") ?? [];
		const perDelivery = new Map<string, number>();
		for (const a of attempts) {
			perDelivery.set(
				a.delivery_id as string,
				(perDelivery.get(a.delivery_id as string) ?? 0) + 1,
			);
		}
		expect(perDelivery.size).toBe(200);
		for (const n of perDelivery.values()) {
			expect(n).toBeGreaterThanOrEqual(1);
			expect(n).toBeLessThanOrEqual(3);
		}
	});

	it("uses the gateway evt/dlv/att id prefixes", () => {
		const byTable = collect(50, seeded(9));
		for (const e of byTable.get("webhook_events") ?? []) {
			expect(e.id as string).toMatch(/^evt_/);
		}
		for (const d of byTable.get("deliveries") ?? []) {
			expect(d.id as string).toMatch(/^dlv_/);
		}
		for (const a of byTable.get("delivery_attempts") ?? []) {
			expect(a.id as string).toMatch(/^att_/);
		}
	});

	it("every attempt references a delivery that exists", () => {
		const byTable = collect(500, seeded(11));
		const deliveryIds = new Set(
			(byTable.get("deliveries") ?? []).map((d) => d.id as string),
		);
		const attempts = byTable.get("delivery_attempts") ?? [];
		expect(attempts.length).toBeGreaterThan(0);
		for (const a of attempts) {
			expect(deliveryIds.has(a.delivery_id as string)).toBe(true);
		}
	});

	it("spreads created_at over the trailing 30 days", () => {
		const byTable = collect(500, seeded(13));
		const days = 30 * 86_400_000;
		for (const d of byTable.get("deliveries") ?? []) {
			const created = d.created_at as number;
			expect(created).toBeLessThanOrEqual(AT);
			expect(created).toBeGreaterThanOrEqual(AT - days);
		}
	});
});

describe("toSqlFiles", () => {
	it("keeps every statement under 90,000 bytes and writes BLOBs as X'…'", async () => {
		const rows = [...seedRows(1000, seeded(42), AT)];
		const files = toSqlFiles(rows);
		expect(files.length).toBeGreaterThanOrEqual(1);
		let sawBlob = false;
		for (const file of files) {
			const text = await readFile(file, "utf8");
			expect(text).toContain("X'");
			sawBlob = true;
			for (const statement of text.split(";\n")) {
				if (statement.trim() === "") continue;
				expect(new TextEncoder().encode(`${statement};`).length).toBeLessThan(
					90000,
				);
			}
		}
		expect(sawBlob).toBe(true);
	});
});
