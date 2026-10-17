import { Hono } from "hono";
import { turnstileConfig } from "./admin/auth/turnstile";
import { adminRoutes } from "./admin/router";
import { heartbeatStale, readHeartbeat } from "./core/heartbeat";
import { createLogger, type Logger } from "./core/log";
import type { Role } from "./core/rbac";
import { createDeps, type Deps } from "./deps";
import type { AppEnv } from "./env";
import { ingressRoutes } from "./ingress/route";

export const DEFAULT_HEALTH_TIMEOUT_MS = 2000;

export type AppBindings = {
	Bindings: AppEnv;
	Variables: {
		requestId: string;
		logger: Logger;
		deps: Deps;
		/** Set by the built-in auth middleware for /api/admin/v1. */
		actor?: { username: string; role: Role; sessionIdHash?: string };
	};
};

export type AppOptions = {
	/** Timeout for the `/healthz` D1 probe. Injectable for tests. */
	healthTimeoutMs?: number;
	/** Builds the per-request Deps. Injectable for tests. */
	createDeps?: (env: AppEnv) => Deps;
};

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("timed out")), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(err) => {
				clearTimeout(timer);
				reject(err);
			},
		);
	});
}

export function createApp(options: AppOptions = {}) {
	const healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
	const buildDeps = options.createDeps ?? createDeps;
	const app = new Hono<AppBindings>();

	// Every request gets a request_id (cf-ray when present) and a bound logger,
	// so all log lines of one request can be correlated.
	app.use(async (c, next) => {
		const requestId = c.req.header("cf-ray") ?? crypto.randomUUID();
		c.set("requestId", requestId);
		c.set("logger", createLogger(c.env, { request_id: requestId }));
		c.set("deps", buildDeps(c.env));
		await next();
	});

	app.get("/healthz", async (c) => {
		const version = c.env.CF_VERSION_METADATA?.id ?? "unknown";
		// Reported for visibility only; it never changes the health status.
		const turnstile = turnstileConfig(c.env).mode;
		try {
			const deps = c.var.deps;
			// The D1 probe and the heartbeat read share one timeout.
			const [, jobs] = await withTimeout(
				Promise.all([
					// Wrap in an async fn so a synchronous throw from prepare() is caught too.
					(async () => c.env.DB.prepare("SELECT 1").first())(),
					readHeartbeat(deps.db),
				]),
				healthTimeoutMs,
			);
			// Public and unauthenticated: status, reason, version, and the
			// Turnstile mode only.
			if (!jobs)
				return c.json(
					{ status: "ok", reason: "jobs_unknown", version, turnstile },
					200,
				);
			if (heartbeatStale(jobs, deps.now()))
				return c.json(
					{ status: "degraded", reason: "jobs_stale", version, turnstile },
					503,
				);
			return c.json({ status: "ok", version, turnstile }, 200);
		} catch (err) {
			c.var.logger.error("health.d1_failed", { error: err });
			return c.json(
				{ status: "degraded", reason: "d1_unavailable", version, turnstile },
				503,
			);
		}
	});

	app.route("/in", ingressRoutes());
	app.route("/api/admin/v1", adminRoutes());

	app.notFound((c) => c.json({ error: "not_found" }, 404));

	app.onError((err, c) => {
		const requestId = c.var.requestId ?? crypto.randomUUID();
		const logger =
			c.var.logger ?? createLogger(c.env, { request_id: requestId });
		logger.error("http.unhandled_error", { error: err });
		// Never echo the error message or stack to the client.
		return c.json({ error: "internal_error", request_id: requestId }, 500);
	});

	return app;
}
