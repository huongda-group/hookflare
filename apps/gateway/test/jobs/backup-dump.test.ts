import { beforeEach, describe, expect, it } from "vitest";
import {
	archiveBatches,
	archiveParts,
	deliveries,
	deliveryAttempts,
	destinations,
	projects,
	sources,
	webhookEvents,
} from "../../src/core/db/schema";
import { gunzipToLines } from "../../src/core/ndjson";
import { dumpPage } from "../../src/jobs/backup/dump";
import { dumpPart } from "../../src/jobs/backup/run";
import { listTables } from "../../src/jobs/backup/tables";
import { testDeps } from "../helpers/deps";
import { seedDelivery, seedPipeline } from "../helpers/seed";

const deps = testDeps();

async function clean() {
	await deps.db.delete(deliveryAttempts);
	await deps.db.delete(deliveries);
	await deps.db.delete(webhookEvents);
	await deps.db.delete(sources);
	await deps.db.delete(destinations);
	await deps.db.delete(projects);
	await deps.db.delete(archiveParts);
	await deps.db.delete(archiveBatches);
}

beforeEach(() => clean());

function fromB64(s: string): Uint8Array {
	const bin = atob(s);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

async function readLines(key: string): Promise<Record<string, unknown>[]> {
	const obj = await deps.backups.get(key);
	if (!obj) throw new Error(`backup object ${key} not found`);
	const lines = await gunzipToLines(
		new Uint8Array(await (obj as R2ObjectBody).arrayBuffer()),
	);
	return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Stored R2 sha256 back to lowercase hex whatever its runtime shape. */
function storedSha256Hex(obj: R2Object): string | null {
	const v: unknown =
		(obj.checksums as unknown as Record<string, unknown> | undefined)?.sha256 ??
		(obj as unknown as Record<string, unknown>).sha256 ??
		null;
	if (v == null) return null;
	if (typeof v === "string") {
		if (/^[0-9a-f]{64}$/i.test(v)) return v.toLowerCase();
		const bin = atob(v);
		return [...bin]
			.map((c) => c.charCodeAt(0).toString(16).padStart(2, "0"))
			.join("");
	}
	const bytes = v instanceof Uint8Array ? v : new Uint8Array(v as ArrayBuffer);
	return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("listTables", () => {
	it("discovers user tables with keys, blob page sizes, and sorted names", async () => {
		const tables = await listTables(deps.db);
		const names = tables.map((t) => t.name);
		expect(names).toContain("webhook_events");
		expect(names).toContain("archive_parts");
		expect(names).not.toContain("d1_migrations");
		expect(names).not.toContain("_cf_KV");
		expect(names).toEqual([...names].sort());

		const events = tables.find((t) => t.name === "webhook_events");
		expect(events?.key).toEqual({ column: "id" });
		expect(events?.pageSize).toBe(250);
		expect(events?.columns.find((c) => c.name === "body_inline")).toMatchObject(
			{ blob: true },
		);

		const parts = tables.find((t) => t.name === "archive_parts");
		expect(parts?.key).toEqual({ rowid: true });

		const deliveriesTable = tables.find((t) => t.name === "deliveries");
		expect(deliveriesTable?.foreignKeys).toContainEqual({
			column: "event_id",
			table: "webhook_events",
			to: "id",
		});
	});
});

describe("dumpPage", () => {
	it("pages across parts with 3, 3, and 1 rows, checksums matching", async () => {
		const now = Date.now();
		for (let i = 0; i < 7; i++) {
			const id = `prj_page_${String(i).padStart(2, "0")}`;
			await deps.db.insert(projects).values({
				id,
				name: `Paged ${i}`,
				slug: `paged-${i}`,
				status: "active",
				createdAt: now,
				updatedAt: now,
			});
		}
		const base = (await listTables(deps.db)).find((t) => t.name === "projects");
		if (!base) throw new Error("projects table not found");
		const table = { ...base, pageSize: 3 };
		const prefix = "test/backup/pages/";

		const first = await dumpPage(deps, table, prefix, 1, null);
		const second = await dumpPage(deps, table, prefix, 2, first.next);
		const third = await dumpPage(deps, table, prefix, 3, second.next);

		expect(first.part?.rows).toBe(3);
		expect(second.part?.rows).toBe(3);
		expect(third.part?.rows).toBe(1);
		expect(third.next).toBeNull();
		expect(typeof first.next).toBe("string");
		expect(typeof second.next).toBe("string");

		const ids: string[] = [];
		for (const meta of [first.part, second.part, third.part]) {
			if (!meta) throw new Error("expected a part");
			const obj = await deps.backups.get(meta.key);
			if (!obj) throw new Error(`backup object ${meta.key} not found`);
			expect(storedSha256Hex(obj)).toBe(meta.sha256);
			const lines = await readLines(meta.key);
			expect(lines).toHaveLength(meta.rows);
			ids.push(...lines.map((l) => l.id as string));
		}
		expect(ids).toEqual([...ids].sort());
		expect(new Set(ids).size).toBe(7);
	});

	it("round trips a 64 KiB body_inline through base64 (Review Focus 2)", async () => {
		const p = await seedPipeline(deps);
		const body = new Uint8Array(64 * 1024);
		for (let i = 0; i < body.length; i++) body[i] = i & 0xff;
		const { eventId } = await seedDelivery(deps, p, { body });
		const table = (await listTables(deps.db)).find(
			(t) => t.name === "webhook_events",
		);
		if (!table) throw new Error("webhook_events table not found");

		const { part, next } = await dumpPage(
			deps,
			table,
			"test/backup/blob/",
			1,
			null,
		);
		if (!part) throw new Error("expected a part");
		expect(next).toBeNull();
		expect(part.rows).toBe(1);
		expect(part.blob_bytes.body_inline).toBe(65_536);

		const [row] = await readLines(part.key);
		expect(row.id).toBe(eventId);
		const cell = row.body_inline as { $b64: string };
		expect([...fromB64(cell.$b64)]).toEqual([...body]);
	});

	it("writes rowid tables without __cursor", async () => {
		const now = Date.now();
		await deps.db.insert(archiveBatches).values({
			id: "arb_rowid",
			kind: "events",
			day: "2026-01-02",
			status: "building",
			withFiles: true,
			workflowInstanceId: "test-instance",
			createdAt: now,
		});
		for (const partNo of [1, 2]) {
			await deps.db.insert(archiveParts).values({
				batchId: "arb_rowid",
				partNo,
				r2Key: `archive/k${partNo}`,
				itemCount: 1,
				bytes: 10,
				sha256: "0".repeat(64),
				firstId: `a${partNo}`,
				lastId: `z${partNo}`,
			});
		}
		const table = (await listTables(deps.db)).find(
			(t) => t.name === "archive_parts",
		);
		if (!table) throw new Error("archive_parts table not found");
		expect(table.key).toEqual({ rowid: true });

		const { part, next } = await dumpPage(
			deps,
			table,
			"test/backup/rowid/",
			1,
			null,
		);
		if (!part) throw new Error("expected a part");
		expect(part.rows).toBe(2);
		expect(next).toBeNull();
		const lines = await readLines(part.key);
		expect(lines).toHaveLength(2);
		for (const row of lines) expect(row).not.toHaveProperty("__cursor");
	});

	it("writes nothing for an empty table", async () => {
		const table = (await listTables(deps.db)).find(
			(t) => t.name === "test_deliveries",
		);
		if (!table) throw new Error("test_deliveries table not found");
		const prefix = "test/backup/empty/";
		expect(await dumpPage(deps, table, prefix, 1, null)).toEqual({
			part: null,
			next: null,
		});
		const listed = await deps.backups.list({ prefix });
		expect(listed.objects).toHaveLength(0);
	});

	it("a retried part that finds no rows deletes the first try's part and sidecar", async () => {
		const prefix = "test/backup/retried-empty/";
		const stale = await deps.backups.list({ prefix });
		if (stale.objects.length)
			await deps.backups.delete(stale.objects.map((o) => o.key));
		await deps.db.insert(archiveBatches).values({
			id: "arb_retry",
			kind: "events",
			day: "2026-01-02",
			status: "building",
			withFiles: true,
			workflowInstanceId: "test-instance",
			createdAt: Date.now(),
		});
		await deps.db.insert(archiveParts).values({
			batchId: "arb_retry",
			partNo: 1,
			r2Key: "archive/k1",
			itemCount: 1,
			bytes: 10,
			sha256: "0".repeat(64),
			firstId: "a",
			lastId: "z",
		});
		const table = (await listTables(deps.db)).find(
			(t) => t.name === "archive_parts",
		);
		if (!table) throw new Error("archive_parts table not found");

		const first = await dumpPart(deps, table, prefix, 1, null);
		expect(first.part).not.toBeNull();
		expect((await deps.backups.list({ prefix })).objects).toHaveLength(2);

		// The step's result was lost; by the retry the rows are gone.
		await deps.db.delete(archiveParts);
		expect(await dumpPart(deps, table, prefix, 1, null)).toEqual({
			part: null,
			next: null,
		});
		expect((await deps.backups.list({ prefix })).objects).toHaveLength(0);
	});
});
