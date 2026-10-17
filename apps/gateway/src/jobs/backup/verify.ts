import { eq } from "drizzle-orm";
import { backups } from "../../core/db/schema";
import { sha256Hex } from "../../core/ndjson";
import type { Deps } from "../../deps";
import type { Manifest } from "./manifest";

export type VerifyResult = { ok: true } | { ok: false; error: string };

/** Stored R2 sha256 back to lowercase hex whatever its runtime shape. */
function storedHex(v: unknown): string | null {
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

/**
 * Re-reads the manifest and HEADs every part: size and sha256 must match
 * what the manifest records. The first mismatch fails the backup; a failed
 * backup keeps its R2 objects so the cause can be inspected.
 */
export async function verifyBackup(
	deps: Pick<Deps, "db" | "backups" | "now">,
	backupId: string,
): Promise<VerifyResult> {
	const row = await deps.db
		.select()
		.from(backups)
		.where(eq(backups.id, backupId))
		.get();
	if (!row) throw new Error(`backup ${backupId} not found`);
	const fail = async (error: string): Promise<VerifyResult> => {
		await deps.db
			.update(backups)
			.set({ status: "failed", error })
			.where(eq(backups.id, backupId));
		return { ok: false, error };
	};
	const manifestKey = `${row.prefix}manifest.json`;
	const head = await deps.backups.head(manifestKey);
	if (!head) return fail("manifest: object missing");
	const obj = await deps.backups.get(manifestKey);
	if (!obj) return fail("manifest: object missing");
	const bytes = new Uint8Array(await obj.arrayBuffer());
	if (head.size !== bytes.byteLength)
		return fail(`manifest: size ${head.size} ≠ ${bytes.byteLength}`);
	if (storedHex(head.checksums?.sha256) !== (await sha256Hex(bytes)))
		return fail("manifest: sha256 mismatch");
	let manifest: Manifest;
	try {
		manifest = JSON.parse(new TextDecoder().decode(bytes)) as Manifest;
	} catch {
		return fail("manifest: invalid JSON");
	}
	for (const table of manifest.tables) {
		for (const part of table.parts) {
			const partHead = await deps.backups.head(part.key);
			if (!partHead) return fail(`part ${part.key}: object missing`);
			if (partHead.size !== part.bytes)
				return fail(`part ${part.key}: size ${partHead.size} ≠ ${part.bytes}`);
			if (storedHex(partHead.checksums?.sha256) !== part.sha256)
				return fail(`part ${part.key}: sha256 mismatch`);
		}
	}
	await deps.db
		.update(backups)
		.set({ status: "verified", finishedAt: deps.now(), error: null })
		.where(eq(backups.id, backupId));
	return { ok: true };
}
