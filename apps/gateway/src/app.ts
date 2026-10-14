import { Hono } from "hono";

type Bindings = {
	DB: D1Database;
	CF_VERSION_METADATA?: WorkerVersionMetadata;
};

const app = new Hono<{ Bindings: Bindings }>();

const D1_TIMEOUT_MS = 2000;

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

function requestIdFor(header: (name: string) => string | undefined): string {
	return header("cf-ray") ?? crypto.randomUUID();
}

app.get("/healthz", async (c) => {
	try {
		await withTimeout(c.env.DB.prepare("SELECT 1").first(), D1_TIMEOUT_MS);
		const version = c.env.CF_VERSION_METADATA?.id ?? "unknown";
		return c.json({ status: "ok", version }, 200);
	} catch {
		console.error(JSON.stringify({ level: "error", msg: "health.d1_failed" }));
		return c.json({ status: "degraded" }, 503);
	}
});

app.notFound((c) => c.json({ error: "not_found" }, 404));

app.onError((err, c) => {
	const request_id = requestIdFor((name) => c.req.header(name));
	console.error(
		JSON.stringify({
			level: "error",
			msg: "unhandled_error",
			request_id,
			error: { name: err?.name, message: err?.message },
		}),
	);
	return c.json({ error: "internal_error", request_id }, 500);
});

export default app;
