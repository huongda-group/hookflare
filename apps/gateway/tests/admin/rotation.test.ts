import type { Destination, Source } from "@hookflare/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
	decryptSecret,
	encryptSecret,
	secretFingerprint,
} from "../../src/core/crypto";
import { destinations, sources } from "../../src/core/db/schema";
import { aad } from "../../src/core/secrets";
import { adminApp, auditRows, beforeNextBatch } from "../helpers/admin";
import { testDeps } from "../helpers/deps";
import {
	seedPipeline,
	TEST_SIGNING_SECRET,
	TEST_SOURCE_SECRET,
} from "../helpers/seed";

const HOUR = 3_600_000;

describe("POST /destinations/:id/rotate-secret", () => {
	it("returns a new secret once and keeps the old one as prev for the grace window", async () => {
		const deps = testDeps();
		const { destination } = await seedPipeline(deps);
		const api = await adminApp(deps);
		const res = await api.request(
			"POST",
			`/destinations/${destination.id}/rotate-secret`,
			{
				grace_hours: 2,
			},
		);
		expect(res.status).toBe(200);
		const body = await res.json<Destination & { signing_secret: string }>();
		expect(body.signing_secret).toMatch(/^whsec_/);
		expect(body.signing_secret_fingerprint).toBe(
			await secretFingerprint(body.signing_secret),
		);
		expect(body.previous_secret_fingerprint).toBe(
			await secretFingerprint(TEST_SIGNING_SECRET),
		);
		expect(body.previous_secret_expires_at).toBeGreaterThan(deps.now() + HOUR);
		const [row] = await deps.db
			.select()
			.from(destinations)
			.where(eq(destinations.id, destination.id));
		expect(
			await decryptSecret(
				deps.env,
				row.signingSecretPrevEnc as string,
				aad.destinationPrev(destination.id),
			),
		).toBe(TEST_SIGNING_SECRET);
		const get = await (
			await api.request("GET", `/destinations/${destination.id}`)
		).json<Destination>();
		expect(get).not.toHaveProperty("signing_secret");
		const [audit] = await auditRows(deps, destination.id);
		expect(audit.action).toBe("destination.secret_rotated");
		expect(audit.diffJson).toMatchObject({
			grace_hours: 2,
			new_fingerprint: body.signing_secret_fingerprint,
		});
		expect(audit.diffJson?.prev_expires_at).toBe(
			body.previous_secret_expires_at,
		);
		expect(JSON.stringify(audit)).not.toContain(body.signing_secret);
	});

	it("clears the prev with grace_hours 0 and drops an older prev on a second rotation", async () => {
		const deps = testDeps();
		const { destination } = await seedPipeline(deps);
		const api = await adminApp(deps);
		const first = await (
			await api.request(
				"POST",
				`/destinations/${destination.id}/rotate-secret`,
				{},
			)
		).json<Destination & { signing_secret: string }>();
		const second = await (
			await api.request(
				"POST",
				`/destinations/${destination.id}/rotate-secret`,
				{},
			)
		).json<Destination>();
		expect(second.previous_secret_fingerprint).toBe(
			await secretFingerprint(first.signing_secret),
		);
		const none = await (
			await api.request(
				"POST",
				`/destinations/${destination.id}/rotate-secret`,
				{ grace_hours: 0 },
			)
		).json<Destination>();
		expect(none.previous_secret_fingerprint).toBeNull();
		expect(none.previous_secret_expires_at).toBeNull();
	});

	it("is admin only", async () => {
		const deps = testDeps();
		const { destination } = await seedPipeline(deps);
		const api = await adminApp(deps, { role: "operator" });
		expect(
			(
				await api.request(
					"POST",
					`/destinations/${destination.id}/rotate-secret`,
				)
			).status,
		).toBe(403);
	});
});

const HMAC = {
	source: {
		authType: "hmac" as const,
		authConfig: { header: "x-sig", algorithm: "sha256", encoding: "hex" },
	},
};

describe("POST /sources/:id/rotate-secret", () => {
	it("uses a supplied secret without echoing it", async () => {
		const deps = testDeps();
		const { source } = await seedPipeline(deps, HMAC);
		const api = await adminApp(deps);
		const supplied = "provider-generated-secret-123";
		const res = await api.request(
			"POST",
			`/sources/${source.id}/rotate-secret`,
			{ secret: supplied },
		);
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).not.toContain(supplied);
		const body = JSON.parse(text) as Source;
		expect(body.secret_fingerprint).toBe(await secretFingerprint(supplied));
		expect(body.previous_secret_fingerprint).toBe(
			await secretFingerprint(TEST_SOURCE_SECRET),
		);
	});

	it("generates and returns a secret once when none is supplied", async () => {
		const deps = testDeps();
		const { source } = await seedPipeline(deps, HMAC);
		const api = await adminApp(deps);
		const body = await (
			await api.request("POST", `/sources/${source.id}/rotate-secret`)
		).json<Source & { secret: string }>();
		expect(body.secret.length).toBeGreaterThanOrEqual(32);
	});

	it("answers 409 no_secret for an auth_type none source", async () => {
		const deps = testDeps();
		const { source } = await seedPipeline(deps); // auth_type none by default
		const api = await adminApp(deps);
		const res = await api.request(
			"POST",
			`/sources/${source.id}/rotate-secret`,
		);
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ error: "no_secret" });
	});

	it("clears an expired prev on the next PATCH", async () => {
		const deps = testDeps();
		const { source } = await seedPipeline(deps, HMAC);
		await deps.db
			.update(sources)
			.set({ secretPrevEnc: "stale", secretPrevExpiresAt: deps.now() - 1 })
			.where(eq(sources.id, source.id));
		const api = await adminApp(deps);
		await api.request("PATCH", `/sources/${source.id}`, { name: "renamed" });
		const [row] = await deps.db
			.select()
			.from(sources)
			.where(eq(sources.id, source.id));
		expect([row.secretPrevEnc, row.secretPrevExpiresAt]).toEqual([null, null]);
	});
});

describe("rotation races", () => {
	it("a PATCH racing a rotation keeps the fresh prev", async () => {
		const deps = testDeps();
		const { destination } = await seedPipeline(deps);
		const where = eq(destinations.id, destination.id);
		await deps.db
			.update(destinations)
			.set({
				signingSecretPrevEnc: "stale",
				signingSecretPrevExpiresAt: deps.now() - 1,
			})
			.where(where);
		const freshEnc = await encryptSecret(
			deps.env,
			TEST_SIGNING_SECRET,
			aad.destinationPrev(destination.id),
		);
		const freshUntil = deps.now() + HOUR;
		// The SSRF check runs between the PATCH's read and its write: rotate there.
		const resolve = deps.resolveDns;
		deps.resolveDns = async (host) => {
			await deps.db
				.update(destinations)
				.set({
					signingSecretPrevEnc: freshEnc,
					signingSecretPrevExpiresAt: freshUntil,
				})
				.where(where);
			return resolve(host);
		};
		const api = await adminApp(deps);
		const res = await api.request("PATCH", `/destinations/${destination.id}`, {
			url: "https://example.com/moved",
		});
		expect(res.status).toBe(200);
		const [row] = await deps.db.select().from(destinations).where(where);
		expect([row.signingSecretPrevEnc, row.signingSecretPrevExpiresAt]).toEqual([
			freshEnc,
			freshUntil,
		]);
	});

	it("a destination rotation that loses the race answers 409 and writes no audit row", async () => {
		const deps = testDeps();
		const { destination } = await seedPipeline(deps);
		const api = await adminApp(deps);
		await api.request("GET", "/me"); // bootstrap batch happens here
		beforeNextBatch(deps, () =>
			deps.db
				.update(destinations)
				.set({ signingSecretEnc: "rotated-elsewhere" })
				.where(eq(destinations.id, destination.id)),
		);
		const res = await api.request(
			"POST",
			`/destinations/${destination.id}/rotate-secret`,
		);
		expect(res.status).toBe(409);
		expect(await auditRows(deps, destination.id)).toEqual([]);
	});

	it("a source rotation that loses the race answers 409 and writes no audit row", async () => {
		const deps = testDeps();
		const { source } = await seedPipeline(deps, HMAC);
		const api = await adminApp(deps);
		await api.request("GET", "/me");
		beforeNextBatch(deps, () =>
			deps.db
				.update(sources)
				.set({ secretEnc: "rotated-elsewhere" })
				.where(eq(sources.id, source.id)),
		);
		const res = await api.request(
			"POST",
			`/sources/${source.id}/rotate-secret`,
		);
		expect(res.status).toBe(409);
		expect(await auditRows(deps, source.id)).toEqual([]);
	});
});
