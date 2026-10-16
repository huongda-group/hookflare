/**
 * Post-deploy smoke test: create a project, point a destination at the sink
 * Worker run URL, send one event through ingress, replay it, and verify the
 * sink saw the initial delivery plus the replay. The HTTP layer
 * (`httpSmokeApi`) is separated from the flow (`runSmoke`) so tests can
 * drive the flow with a fake API.
 */

/**
 * Credentials and URLs the smoke test needs. Null when the env is
 * incomplete; see `smokeEnv`.
 * @typedef {{ url: string, clientId: string, clientSecret: string, sinkUrl: string }} SmokeEnv
 */

/**
 * Read the smoke env from a `process.env`-shaped object. Returns null when
 * any of `HOOKFLARE_URL`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`,
 * or `SINK_URL` is missing.
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 * @returns {SmokeEnv | null}
 */
export function smokeEnv(env = process.env) {
	const url = env.HOOKFLARE_URL;
	const clientId = env.CF_ACCESS_CLIENT_ID;
	const clientSecret = env.CF_ACCESS_CLIENT_SECRET;
	const sinkUrl = env.SINK_URL;
	if (!url || !clientId || !clientSecret || !sinkUrl) {
		return null;
	}
	return { url, clientId, clientSecret, sinkUrl };
}

/**
 * Poll options. The attempt count derives from the timeout so a fake
 * `sleep` clock still terminates.
 * @typedef {{ timeoutMs?: number, intervalMs?: number, sleep?: (ms: number) => Promise<void> }} PollOptions
 */

/**
 * Default sleep: a real timer.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function realSleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Call `fn` until it returns a non-nullish value, then resolve with it.
 * Throws `poll: timed out after <timeoutMs>ms` when the timeout elapses.
 * @template T
 * @param {(attempt: number) => Promise<T | null | undefined>} fn
 * @param {PollOptions} [options]
 * @returns {Promise<T>}
 */
export async function pollUntil(
	fn,
	{ timeoutMs = 60000, intervalMs = 1000, sleep = realSleep } = {},
) {
	const attempts = Math.max(1, Math.ceil(timeoutMs / Math.max(1, intervalMs)));
	for (let attempt = 0; attempt < attempts; attempt++) {
		const value = await fn(attempt);
		if (value !== null && value !== undefined) {
			return value;
		}
		if (attempt + 1 < attempts) {
			await sleep(intervalMs);
		}
	}
	throw new Error(`poll: timed out after ${timeoutMs}ms`);
}

/**
 * True for the timeout error thrown by `pollUntil`.
 * @param {unknown} err
 * @returns {boolean}
 */
function isPollTimeout(err) {
	return err instanceof Error && err.message.startsWith("poll: ");
}

/**
 * Decode a `whsec_`-prefixed (or bare) base64 secret to key bytes.
 * @param {string} secret
 * @returns {Uint8Array}
 */
function secretKeyBytes(secret) {
	const bin = atob(
		secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret,
	);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) {
		out[i] = bin.charCodeAt(i);
	}
	return out;
}

/**
 * Sign a body in the Standard Webhooks format the gateway uses for
 * outbound deliveries: `v1,base64(HMAC-SHA256(secret, "${id}.${ts}." ‖ body))`.
 * @param {string} secret
 * @param {string} id
 * @param {number} ts Unix seconds.
 * @param {string | Uint8Array} body
 * @returns {Promise<string>}
 */
export async function signStandardWebhook(secret, id, ts, body) {
	const bytes =
		typeof body === "string" ? new TextEncoder().encode(body) : body;
	const prefix = new TextEncoder().encode(`${id}.${ts}.`);
	const message = new Uint8Array(prefix.byteLength + bytes.byteLength);
	message.set(prefix, 0);
	message.set(bytes, prefix.byteLength);
	const key = await crypto.subtle.importKey(
		"raw",
		secretKeyBytes(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
	let bin = "";
	for (const b of sig) {
		bin += String.fromCharCode(b);
	}
	return `v1,${btoa(bin)}`;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * New ULID: 48-bit millisecond time plus 80 bits of randomness. Used as
 * the sink run ID so each smoke run gets its own `/r/<run>/hook` URL.
 * @returns {string}
 */
export function runId() {
	let time = Date.now();
	const rand = crypto.getRandomValues(new Uint8Array(10));
	let out = "";
	for (let i = 9; i >= 0; i--) {
		out = CROCKFORD[rand[i] % 32] + out;
	}
	let timePart = "";
	for (let i = 0; i < 10; i++) {
		timePart = CROCKFORD[time % 32] + timePart;
		time = Math.floor(time / 32);
	}
	return timePart + out;
}

/**
 * Minimal delivery view the smoke flow polls on.
 * @typedef {{ id: string, status: string }} SmokeDelivery
 */

/**
 * Admin plus ingress calls the smoke flow needs, plus the sink base URL.
 * The HTTP implementation closes over the project/source IDs it creates.
 * @typedef {{
 *   sinkUrl: string,
 *   ensureProject: (name: string) => Promise<{ id: string }>,
 *   ensureDestination: (url: string) => Promise<{ id: string }>,
 *   ensureSource: () => Promise<{ id: string, ingress_url: string }>,
 *   send: () => Promise<string>,
 *   deliveries: (eventId: string) => Promise<SmokeDelivery[]>,
 *   replay: (eventId: string) => Promise<{ delivery_id: string }>,
 *   sinkStats: (run: string) => Promise<{ unique: number, received: number }>
 * }} SmokeApi
 */

/**
 * Smoke result.
 * @typedef {{ eventId: string, deliveryIds: string[], sinkRun: string }} SmokeResult
 */

/**
 * Extra run options (test seam for the clock).
 * @typedef {{ sleep?: (ms: number) => Promise<void> }} RunOptions
 */

/**
 * Run the smoke flow against a SmokeApi: ensure project, destination (at
 * `${sinkUrl}/r/<run>/hook`), and source; send one event; wait for its
 * delivery; replay it; wait for the replay; then verify the sink saw both.
 * @param {SmokeApi} api
 * @param {(line: string) => void} [log]
 * @param {RunOptions} [options]
 * @returns {Promise<SmokeResult>}
 */
export async function runSmoke(api, log = () => {}, { sleep } = {}) {
	const pollOptions = sleep === undefined ? {} : { sleep };
	const project = await api.ensureProject("smoke");
	log(`smoke: project ${project.id}`);
	const run = runId();
	const hookUrl = `${api.sinkUrl}/r/${run}/hook`;
	const destination = await api.ensureDestination(hookUrl);
	log(`smoke: destination ${destination.id} -> ${hookUrl}`);
	const source = await api.ensureSource();
	log(`smoke: source ${source.id}`);
	const eventId = await api.send();
	log(`smoke: event ${eventId}`);
	let initial;
	try {
		initial = await pollUntil(async () => {
			const found = await api.deliveries(eventId);
			return found.length > 0 &&
				found.every((delivery) => delivery.status === "delivered")
				? found
				: null;
		}, pollOptions);
	} catch (err) {
		if (isPollTimeout(err)) {
			throw new Error("smoke: event not delivered within 60s");
		}
		throw err;
	}
	log(`smoke: initial delivery ${initial[0].id} delivered`);
	const replay = await api.replay(eventId);
	log(`smoke: replay delivery ${replay.delivery_id}`);
	try {
		await pollUntil(async () => {
			const found = await api.deliveries(eventId);
			const current = found.find(
				(delivery) => delivery.id === replay.delivery_id,
			);
			return current !== undefined && current.status === "delivered"
				? current
				: null;
		}, pollOptions);
	} catch (err) {
		if (isPollTimeout(err)) {
			throw new Error("smoke: replay not delivered within 60s");
		}
		throw err;
	}
	const stats = await api.sinkStats(run);
	if (stats.received !== 2) {
		throw new Error(`smoke: expected sink received=2, got ${stats.received}`);
	}
	log(
		`smoke: sink run ${run} unique=${stats.unique} received=${stats.received}`,
	);
	return {
		eventId,
		deliveryIds: [initial[0].id, replay.delivery_id],
		sinkRun: run,
	};
}

/**
 * Throw for a non-2xx admin/ingress response.
 * @param {Response} res
 * @param {string} what
 */
async function throwForStatus(res, what) {
	if (res.ok) {
		return;
	}
	const text = await res.text().catch(() => "");
	throw new Error(
		`smoke: ${what} failed with ${res.status} ${text.slice(0, 200)}`,
	);
}

/**
 * Build the HTTP SmokeApi for a deployed gateway plus sink Worker.
 * @param {SmokeEnv} env
 * @param {typeof fetch} [fetchFn]
 * @returns {SmokeApi}
 */
export function httpSmokeApi(env, fetchFn = fetch) {
	const base = env.url.replace(/\/$/, "");
	const sinkUrl = env.sinkUrl.replace(/\/$/, "");
	const headers = {
		"content-type": "application/json",
		"CF-Access-Client-Id": env.clientId,
		"CF-Access-Client-Secret": env.clientSecret,
	};
	let projectId = null;
	let destinationId = null;
	let ingressUrl = null;

	/**
	 * Parse a JSON response, throwing on non-2xx.
	 * @param {string} what
	 * @param {Response} res
	 * @returns {Promise<any>}
	 */
	async function readJson(what, res) {
		await throwForStatus(res, what);
		return res.json();
	}

	return {
		sinkUrl,
		async ensureProject(name) {
			const res = await fetchFn(`${base}/api/admin/v1/projects?limit=200`, {
				headers,
			});
			const page = await readJson("list projects", res);
			const existing = (page.data ?? []).find(
				(project) => project.slug === name || project.name === name,
			);
			if (existing) {
				projectId = existing.id;
				return { id: existing.id };
			}
			const created = await readJson(
				"create project",
				await fetchFn(`${base}/api/admin/v1/projects`, {
					method: "POST",
					headers,
					body: JSON.stringify({ name, slug: name }),
				}),
			);
			projectId = created.id;
			return { id: created.id };
		},
		async ensureDestination(url) {
			if (projectId === null) {
				throw new Error("smoke: ensureProject must run first");
			}
			const created = await readJson(
				"create destination",
				await fetchFn(`${base}/api/admin/v1/destinations`, {
					method: "POST",
					headers,
					body: JSON.stringify({ project_id: projectId, name: "smoke", url }),
				}),
			);
			destinationId = created.id;
			return { id: created.id };
		},
		async ensureSource() {
			if (projectId === null || destinationId === null) {
				throw new Error("smoke: ensureDestination must run first");
			}
			const created = await readJson(
				"create source",
				await fetchFn(`${base}/api/admin/v1/sources`, {
					method: "POST",
					headers,
					body: JSON.stringify({
						project_id: projectId,
						destination_id: destinationId,
						name: "smoke",
						auth_type: "none",
						auth_config: {},
					}),
				}),
			);
			ingressUrl = created.ingress_url;
			return { id: created.id, ingress_url: created.ingress_url };
		},
		async send() {
			if (ingressUrl === null) {
				throw new Error("smoke: ensureSource must run first");
			}
			const id = `smoke-${runId()}`;
			const ts = Math.floor(Date.now() / 1000);
			const body = JSON.stringify({ smoke: true, sent_at: ts });
			const secretBytes = crypto.getRandomValues(new Uint8Array(32));
			let bin = "";
			for (const b of secretBytes) {
				bin += String.fromCharCode(b);
			}
			const signature = await signStandardWebhook(
				`whsec_${btoa(bin)}`,
				id,
				ts,
				body,
			);
			const res = await fetchFn(ingressUrl, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"webhook-id": id,
					"webhook-timestamp": String(ts),
					"webhook-signature": signature,
				},
				body,
			});
			const parsed = await readJson("send event", res);
			return parsed.event_id;
		},
		async deliveries(eventId) {
			const page = await readJson(
				"list deliveries",
				await fetchFn(`${base}/api/admin/v1/events/${eventId}/deliveries`, {
					headers,
				}),
			);
			return (page.data ?? []).map((delivery) => ({
				id: delivery.id,
				status: delivery.status,
			}));
		},
		async replay(eventId) {
			const parsed = await readJson(
				"replay event",
				await fetchFn(`${base}/api/admin/v1/events/${eventId}/replay`, {
					method: "POST",
					headers,
					body: JSON.stringify({ reason: "post-deploy smoke test" }),
				}),
			);
			return { delivery_id: parsed.delivery_id };
		},
		async sinkStats(run) {
			const res = await fetchFn(`${sinkUrl}/r/${run}/stats`);
			const parsed = await readJson("sink stats", res);
			return { unique: parsed.unique, received: parsed.received };
		},
	};
}
