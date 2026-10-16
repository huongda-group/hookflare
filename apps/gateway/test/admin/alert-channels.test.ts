import type { AlertChannel } from "@hookflare/shared";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearAccessKeyCache } from "../../src/admin/auth/access";
import { alertChannels } from "../../src/core/db/schema";
import { adminApp, auditRows } from "../helpers/admin";
import { resetAlerts } from "../helpers/alerts";
import { testDeps } from "../helpers/deps";

const URL1 = "https://discord.com/api/webhooks/1/secret-part";
const TOKEN = `123456:${"S".repeat(35)}`;

describe("alert channels API (spec §6.5)", () => {
	const deps = testDeps({
		fetch: vi.fn(
			async () => new Response(null, { status: 204 }),
		) as unknown as typeof fetch,
	});
	beforeEach(async () => {
		clearAccessKeyCache();
		await resetAlerts(deps);
	});

	it("creates a channel without ever returning or auditing the secret", async () => {
		const app = await adminApp(deps);
		const res = await app.request("POST", "/alert-channels", {
			name: "ops",
			config: { type: "discord", url: URL1 },
			rules: ["new_dead"],
		});
		expect(res.status).toBe(201);
		const text = await res.clone().text();
		expect(text).not.toContain("secret-part");
		const ch = await res.json<AlertChannel>();
		expect(ch).toMatchObject({
			name: "ops",
			type: "discord",
			enabled: true,
			rules: ["new_dead"],
			project_ids: [],
			chat_id: null,
		});
		expect(ch.config_fingerprint).toMatch(/^[0-9a-f]{8}$/);
		const audits = await auditRows(deps, ch.id);
		expect(audits.map((a) => a.action)).toEqual(["alert_channel.created"]);
		expect(audits[0].diffJson ?? "").not.toContain("secret-part");

		const list = await (await app.request("GET", "/alert-channels")).text();
		expect(list).not.toContain("secret-part");
	});

	it("shows the Telegram chat ID but never the token", async () => {
		const res = await (await adminApp(deps)).request(
			"POST",
			"/alert-channels",
			{
				name: "tg",
				config: { type: "telegram", bot_token: TOKEN, chat_id: "-100777" },
			},
		);
		const body = await res.text();
		expect(body).toContain("-100777");
		expect(body).not.toContain(TOKEN);
	});

	it("rejects hosts outside the allowlist", async () => {
		const res = await (await adminApp(deps)).request(
			"POST",
			"/alert-channels",
			{
				name: "x",
				config: { type: "slack", url: "https://example.com/services/a" },
			},
		);
		expect(res.status).toBe(400);
		expect(
			(await res.json<{ issues: { path: string }[] }>()).issues[0].path,
		).toBe("config.url");
	});

	it("patches routing and config; refuses a type change", async () => {
		const app = await adminApp(deps);
		const ch = await (
			await app.request("POST", "/alert-channels", {
				name: "ops",
				config: { type: "discord", url: URL1 },
			})
		).json<AlertChannel>();
		const p1 = await app.request("PATCH", `/alert-channels/${ch.id}`, {
			enabled: false,
			project_ids: ["prj_01J00000000000000000000000"],
		});
		expect(await p1.json()).toMatchObject({
			enabled: false,
			project_ids: ["prj_01J00000000000000000000000"],
		});
		const p2 = await app.request("PATCH", `/alert-channels/${ch.id}`, {
			config: {
				type: "discord",
				url: "https://discord.com/api/webhooks/2/new",
			},
		});
		expect((await p2.json<AlertChannel>()).config_fingerprint).not.toBe(
			ch.config_fingerprint,
		);
		const p3 = await app.request("PATCH", `/alert-channels/${ch.id}`, {
			config: { type: "slack", url: "https://hooks.slack.com/services/a" },
		});
		expect(p3.status).toBe(400);
		expect(await p3.json()).toEqual({ error: "config_type_mismatch" });
	});

	it("sends a test message synchronously and audits it", async () => {
		const app = await adminApp(deps);
		const ch = await (
			await app.request("POST", "/alert-channels", {
				name: "ops",
				config: { type: "discord", url: URL1 },
			})
		).json<AlertChannel>();
		const res = await app.request("POST", `/alert-channels/${ch.id}/test`);
		expect(await res.json()).toEqual({ ok: true, error: null });
		expect(deps.fetch).toHaveBeenCalledWith(
			URL1,
			expect.objectContaining({ method: "POST" }),
		);
		expect((await auditRows(deps, ch.id)).map((a) => a.action)).toContain(
			"alert_channel.tested",
		);
	});

	it("reports an unreadable config instead of failing the test request", async () => {
		vi.mocked(deps.fetch).mockClear();
		const app = await adminApp(deps);
		const ch = await (
			await app.request("POST", "/alert-channels", {
				name: "ops",
				config: { type: "discord", url: URL1 },
			})
		).json<AlertChannel>();
		await deps.db
			.update(alertChannels)
			.set({ configEnc: "garbage" })
			.where(eq(alertChannels.id, ch.id));
		const res = await app.request("POST", `/alert-channels/${ch.id}/test`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			ok: false,
			error: "config_unreadable",
		});
		expect(deps.fetch).not.toHaveBeenCalled();
	});

	it("deletes a channel and its notifications", async () => {
		const app = await adminApp(deps);
		const ch = await (
			await app.request("POST", "/alert-channels", {
				name: "ops",
				config: { type: "discord", url: URL1 },
			})
		).json<AlertChannel>();
		expect(
			(await app.request("DELETE", `/alert-channels/${ch.id}`)).status,
		).toBe(204);
		expect(
			await deps.db
				.select()
				.from(alertChannels)
				.where(eq(alertChannels.id, ch.id)),
		).toEqual([]);
	});
});
