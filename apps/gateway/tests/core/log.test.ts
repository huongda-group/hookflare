import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger, log, redactHeaders } from "../../src/core/log";

function lastJson(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
	const call = spy.mock.calls[spy.mock.calls.length - 1];
	expect(call).toBeDefined();
	return JSON.parse(call?.[0] as string) as Record<string, unknown>;
}

const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

afterEach(() => {
	logSpy.mockClear();
	warnSpy.mockClear();
	errorSpy.mockClear();
});

describe("log", () => {
	it("emits one JSON line with level and msg", () => {
		log("info", "health.ok", { request_id: "r_1" });
		expect(logSpy).toHaveBeenCalledTimes(1);
		expect(lastJson(logSpy)).toMatchObject({
			level: "info",
			msg: "health.ok",
			request_id: "r_1",
		});
	});

	it("redacts nested sensitive keys in any case", () => {
		log("info", "test.redact", {
			user: { Password: "hunter2", name: "ada" },
			deep: { list: [{ apiKey: "key-1" }, { accessToken: "tok-1" }] },
			headers: {
				Authorization: "Bearer abc",
				Cookie: "sess=1",
				"X-Api-Key": "k",
				"content-type": "application/json",
			},
			client_secret: "shh",
			SIGNATURE: "sig",
		});
		const line = lastJson(logSpy);
		const flat = JSON.stringify(line);
		for (const secret of [
			"hunter2",
			"key-1",
			"tok-1",
			"Bearer abc",
			"sess=1",
			"shh",
			"sig",
		]) {
			expect(flat).not.toContain(secret);
		}
		expect(flat).toContain("[REDACTED]");
		const fields = line as Record<string, unknown>;
		expect((fields.user as Record<string, unknown>).name).toBe("ada");
		expect((fields.headers as Record<string, unknown>)["content-type"]).toBe(
			"application/json",
		);
	});

	it("leaves non-sensitive fields untouched", () => {
		log("info", "evt.created", {
			userId: "u_1",
			action: "created",
			count: 3,
			ok: true,
		});
		expect(lastJson(logSpy)).toMatchObject({
			userId: "u_1",
			action: "created",
			count: 3,
			ok: true,
		});
	});

	it("serializes Error values as {name, message, stack}", () => {
		const err = new Error("boom");
		log("error", "test.failed", { error: err });
		expect(errorSpy).toHaveBeenCalledTimes(1);
		const line = lastJson(errorSpy);
		const serialized = line.error as Record<string, unknown>;
		expect(serialized.name).toBe("Error");
		expect(serialized.message).toBe("boom");
		expect(typeof serialized.stack).toBe("string");
	});

	it("filters below LOG_LEVEL and defaults to info", () => {
		log("debug", "test.debug", {}, { LOG_LEVEL: "warn" });
		log("info", "test.info", {}, { LOG_LEVEL: "warn" });
		expect(logSpy).not.toHaveBeenCalled();
		log("warn", "test.warn", {}, { LOG_LEVEL: "warn" });
		expect(warnSpy).toHaveBeenCalledTimes(1);
		log("error", "test.error", {}, { LOG_LEVEL: "warn" });
		expect(errorSpy).toHaveBeenCalledTimes(1);

		logSpy.mockClear();
		log("debug", "test.debug");
		expect(logSpy).not.toHaveBeenCalled();
		log("info", "test.info");
		expect(logSpy).toHaveBeenCalledTimes(1);
	});

	it("createLogger binds env and base fields", () => {
		const logger = createLogger({ LOG_LEVEL: "debug" }, { request_id: "r_9" });
		logger.debug("test.bound", { a: 1 });
		expect(lastJson(logSpy)).toMatchObject({
			level: "debug",
			msg: "test.bound",
			request_id: "r_9",
			a: 1,
		});
	});

	it("redactHeaders redacts sensitive headers and honors extraNames", () => {
		const headers = new Headers({
			authorization: "Bearer abc",
			"content-type": "application/json",
			"x-tenant": "t_1",
		});
		expect(redactHeaders(headers)).toEqual({
			authorization: "[REDACTED]",
			"content-type": "application/json",
			"x-tenant": "t_1",
		});
		expect(
			redactHeaders({ "X-Tenant": "t_1", "x-custom": "v" }, ["x-custom"]),
		).toEqual({ "x-tenant": "t_1", "x-custom": "[REDACTED]" });
	});

	it("never lets fields override level or msg", () => {
		log("error", "real.msg", { level: "debug", msg: "spoofed" });
		expect(lastJson(errorSpy)).toMatchObject({
			level: "error",
			msg: "real.msg",
		});
	});

	it("serializes BigInt, circular refs, Date, Map, Set, and URL", () => {
		const circular: Record<string, unknown> = { name: "loop" };
		circular.self = circular;
		expect(() =>
			log("info", "test.odd", {
				big: 10n ** 20n,
				circular,
				at: new Date(0),
				map: new Map([
					["token", "t-1"],
					["k", "v"],
				]),
				set: new Set([1, 2]),
				url: new URL("https://example.com/a"),
			}),
		).not.toThrow();
		const line = lastJson(logSpy);
		expect(line).toMatchObject({
			big: "100000000000000000000",
			circular: { name: "loop", self: "[CIRCULAR]" },
			at: "1970-01-01T00:00:00.000Z",
			map: { token: "[REDACTED]", k: "v" },
			set: [1, 2],
			url: "https://example.com/a",
		});
	});

	it("never throws, even when a getter throws", () => {
		const evil = {
			get boom(): string {
				throw new Error("getter exploded");
			},
		};
		expect(() => log("info", "test.evil", { evil })).not.toThrow();
		expect(lastJson(errorSpy)).toMatchObject({
			level: "error",
			msg: "log_error",
			original_msg: "test.evil",
		});
	});
});
