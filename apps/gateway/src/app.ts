import { Hono } from "hono";
import { createLogger, type Logger } from "./core/log";

export const DEFAULT_HEALTH_TIMEOUT_MS = 2000;

export type AppBindings = {
	Bindings: Env;
	Variables: { requestId: string; logger: Logger };
};

export type AppOptions = {
	/** Timeout for the `/healthz` D1 probe. Injectable for tests. */
	healthTimeoutMs?: number;
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
	const app = new Hono<AppBindings>();

	// Every request gets a request_id (cf-ray when present) and a bound logger,
	// so all log lines of one request can be correlated.
	app.use(async (c, next) => {
		const requestId = c.req.header("cf-ray") ?? crypto.randomUUID();
		c.set("requestId", requestId);
		c.set("logger", createLogger(c.env, { request_id: requestId }));
		await next();
	});

	app.get("/healthz", async (c) => {
		try {
			// Wrap in an async fn so a synchronous throw from prepare() is caught too.
			await withTimeout(
				(async () => c.env.DB.prepare("SELECT 1").first())(),
				healthTimeoutMs,
			);
			const version = c.env.CF_VERSION_METADATA?.id ?? "unknown";
			return c.json({ status: "ok", version }, 200);
		} catch (err) {
			c.var.logger.error("health.d1_failed", { error: err });
			return c.json({ status: "degraded" }, 503);
		}
	});

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
