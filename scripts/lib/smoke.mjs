/**
 * Post-deploy smoke test: create a project, point a destination at the sink
 * Worker run URL, send one event through ingress, replay it, and verify the
 * sink saw the initial delivery plus the replay. The HTTP layer
 * (`httpSmokeApi`) is separated from the flow (`runSmoke`) so tests can
 * drive the flow with a fake API.
 */

/**
 * Credentials and URLs the smoke test needs. Null when the env is
 * incomplete; see `smokeEnv`. The token is an `hf_`-prefixed API token
 * for an admin user (the smoke creates projects, destinations, and
 * sources through `config.manage`-gated routes), sent as
 * `authorization: Bearer <token>`.
 * @typedef {{ url: string, token: string, sinkUrl: string }} SmokeEnv
 */

/**
 * Read the smoke env from a `process.env`-shaped object. Returns null when
 * any of the URL variable (`HOOKFLARE_URL` by default; see `smokeUrlVar`),
 * `HOOKFLARE_API_TOKEN`, or `SINK_URL` is missing.
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 * @param {{ urlVar?: string }} [options]
 * @returns {SmokeEnv | null}
 */
export function smokeEnv(env = process.env, { urlVar = "HOOKFLARE_URL" } = {}) {
	const url = env[urlVar];
	const token = env.HOOKFLARE_API_TOKEN;
	const sinkUrl = env.SINK_URL;
	if (!url || !token || !sinkUrl) {
		return null;
	}
	return { url, token, sinkUrl };
}

/**
 * Gateway URL variable for a Worker: its name upper-cased with `-` as `_`,
 * plus `_URL` (`hookflare` → `HOOKFLARE_URL`, `hookflare-staging` →
 * `HOOKFLARE_STAGING_URL`). Per-Worker names keep a production URL left in
 * the shell from smoke-testing a staging deploy, and vice versa.
 * @param {string} worker
 * @returns {string}
 */
export function smokeUrlVar(worker) {
	return `${worker.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_URL`;
}

/**
 * Throw unless the smoke URL plausibly belongs to the Worker being tested:
 * it must be the config's `PUBLIC_BASE_URL` origin when that is set, and a
 * `*.workers.dev` URL must name this Worker in its first label.
 * @param {string} url
 * @param {{ worker: string, publicBaseUrl: string }} target
 */
export function checkSmokeTarget(url, { worker, publicBaseUrl }) {
	const origin = new URL(url).origin;
	if (publicBaseUrl) {
		const expected = new URL(publicBaseUrl).origin;
		if (origin !== expected) {
			throw new Error(
				`smoke: ${origin} does not match PUBLIC_BASE_URL ${expected} of worker ${worker}`,
			);
		}
	}
	const host = new URL(url).hostname;
	if (host.endsWith(".workers.dev") && host.split(".")[0] !== worker) {
		throw new Error(`smoke: ${host} is not worker ${worker}`);
	}
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
 *   sinkStats: (run: string) => Promise<{ unique: number, received: number, ids: string[] }>
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
 * delivery; replay it; wait for the replay; then verify the sink saw both
 * delivery IDs.
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
	// The gateway's webhook-id is the delivery ID and a replay is a new
	// delivery of the same event, so the sink must have seen exactly the
	// initial and the replay delivery IDs, once each.
	const deliveryIds = [initial[0].id, replay.delivery_id];
	const expected = [...deliveryIds].sort().join(",");
	const stats = await api.sinkStats(run);
	const seen = [...stats.ids].sort().join(",");
	if (stats.received !== 2 || seen !== expected) {
		throw new Error(
			`smoke: expected sink received=2 with webhook IDs ${expected}, got received=${stats.received} ids=${seen}`,
		);
	}
	log(`smoke: sink run ${run} received=${stats.received} ids=${seen}`);
	return { eventId, deliveryIds, sinkRun: run };
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

/** Name of the reused smoke destination and source. */
const SMOKE_NAME = "smoke";
/** Audit reason on every smoke mutation. */
const SMOKE_REASON = "post-deploy smoke test";
/** Admin list page size: the shared `pageLimit` maximum. */
const PAGE = 100;

/**
 * Build the HTTP SmokeApi for a deployed gateway plus sink Worker. The
 * project (by slug), destination, and source (by name `smoke`) are reused
 * across runs: the destination is repointed at the run's sink URL, and the
 * source gets the run's HMAC secret through rotate-secret.
 * @param {SmokeEnv} env
 * @param {typeof fetch} [fetchFn]
 * @returns {SmokeApi}
 */
export function httpSmokeApi(env, fetchFn = fetch) {
	const base = env.url.replace(/\/$/, "");
	const sinkUrl = env.sinkUrl.replace(/\/$/, "");
	const headers = {
		"content-type": "application/json",
		authorization: `Bearer ${env.token}`,
	};
	let projectId = null;
	let destinationId = null;
	let ingressUrl = null;
	/** HMAC secret for the run's source: ingress verifies every send against it. */
	let smokeSecret = null;
	/** Header carrying the smoke HMAC (matches the source auth_config below). */
	const smokeHeader = "x-smoke-signature";
	const smokeAuthConfig = {
		header: smokeHeader,
		algorithm: "sha256",
		encoding: "hex",
	};

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

	/**
	 * First row of an admin list that matches `pick`, following
	 * `next_cursor` at the API's maximum page size. Null when none match.
	 * @param {string} kind e.g. `projects`.
	 * @param {Record<string, string>} filters
	 * @param {(row: any) => boolean} pick
	 * @returns {Promise<any | null>}
	 */
	async function findListed(kind, filters, pick) {
		let cursor = null;
		do {
			const params = new URLSearchParams({ ...filters, limit: String(PAGE) });
			if (cursor !== null) {
				params.set("cursor", cursor);
			}
			const page = await readJson(
				`list ${kind}`,
				await fetchFn(`${base}/api/admin/v1/${kind}?${params}`, { headers }),
			);
			const found = (page.data ?? []).find(pick);
			if (found) {
				return found;
			}
			cursor = page.next_cursor ?? null;
		} while (cursor !== null);
		return null;
	}

	return {
		sinkUrl,
		async ensureProject(name) {
			const existing = await findListed(
				"projects",
				{},
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
			const existing = await findListed(
				"destinations",
				{ project_id: projectId },
				(destination) => destination.name === SMOKE_NAME,
			);
			if (existing) {
				destinationId = existing.id;
				// Each run has its own sink URL; repoint the reused destination.
				if (existing.url !== url) {
					await readJson(
						"update destination",
						await fetchFn(`${base}/api/admin/v1/destinations/${existing.id}`, {
							method: "PATCH",
							headers,
							body: JSON.stringify({ url, reason: SMOKE_REASON }),
						}),
					);
				}
				return { id: existing.id };
			}
			const created = await readJson(
				"create destination",
				await fetchFn(`${base}/api/admin/v1/destinations`, {
					method: "POST",
					headers,
					body: JSON.stringify({
						project_id: projectId,
						name: SMOKE_NAME,
						url,
					}),
				}),
			);
			destinationId = created.id;
			return { id: created.id };
		},
		async ensureSource() {
			if (projectId === null || destinationId === null) {
				throw new Error("smoke: ensureDestination must run first");
			}
			// HMAC source: ingress verifies send() against this run secret,
			// so smoke exercises the real ingress verification path.
			const raw = crypto.getRandomValues(new Uint8Array(32));
			let bin = "";
			for (const b of raw) {
				bin += String.fromCharCode(b);
			}
			const secret = btoa(bin);
			const existing = await findListed(
				"sources",
				{ project_id: projectId },
				(source) => source.name === SMOKE_NAME,
			);
			if (existing) {
				if (existing.auth_type !== "hmac") {
					throw new Error(
						`smoke: source ${existing.id} named "${SMOKE_NAME}" is ${existing.auth_type}, not hmac; rename or delete it`,
					);
				}
				/** @type {Record<string, unknown>} */
				const patch = {};
				if (existing.destination_id !== destinationId) {
					patch.destination_id = destinationId;
				}
				if (existing.status === "disabled") {
					patch.status = "active";
				}
				if (
					JSON.stringify(existing.auth_config) !==
					JSON.stringify(smokeAuthConfig)
				) {
					patch.auth_config = smokeAuthConfig;
				}
				if (Object.keys(patch).length > 0) {
					await readJson(
						"update source",
						await fetchFn(`${base}/api/admin/v1/sources/${existing.id}`, {
							method: "PATCH",
							headers,
							body: JSON.stringify({ ...patch, reason: SMOKE_REASON }),
						}),
					);
				}
				// The old secret is unknown (never returned); rotate to this run's
				// secret with no grace window so only the new one verifies.
				await readJson(
					"rotate source secret",
					await fetchFn(
						`${base}/api/admin/v1/sources/${existing.id}/rotate-secret`,
						{
							method: "POST",
							headers,
							body: JSON.stringify({
								secret,
								grace_hours: 0,
								reason: SMOKE_REASON,
							}),
						},
					),
				);
				smokeSecret = secret;
				ingressUrl = existing.ingress_url;
				return { id: existing.id, ingress_url: existing.ingress_url };
			}
			smokeSecret = secret;
			const created = await readJson(
				"create source",
				await fetchFn(`${base}/api/admin/v1/sources`, {
					method: "POST",
					headers,
					body: JSON.stringify({
						project_id: projectId,
						destination_id: destinationId,
						name: SMOKE_NAME,
						auth_type: "hmac",
						auth_config: smokeAuthConfig,
						secret: smokeSecret,
					}),
				}),
			);
			ingressUrl = created.ingress_url;
			return { id: created.id, ingress_url: created.ingress_url };
		},
		async send() {
			if (ingressUrl === null || smokeSecret === null) {
				throw new Error("smoke: ensureSource must run first");
			}
			const body = JSON.stringify({ smoke: true, sent_at: Date.now() });
			const key = await crypto.subtle.importKey(
				"raw",
				new TextEncoder().encode(smokeSecret),
				{ name: "HMAC", hash: "SHA-256" },
				false,
				["sign"],
			);
			const sig = new Uint8Array(
				await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
			);
			const signature = [...sig]
				.map((b) => b.toString(16).padStart(2, "0"))
				.join("");
			const res = await fetchFn(ingressUrl, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					[smokeHeader]: signature,
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
					body: JSON.stringify({ reason: SMOKE_REASON }),
				}),
			);
			return { delivery_id: parsed.delivery_id };
		},
		async sinkStats(run) {
			const res = await fetchFn(`${sinkUrl}/r/${run}/stats?ids=1`);
			const parsed = await readJson("sink stats", res);
			return {
				unique: parsed.unique,
				received: parsed.received,
				ids: parsed.ids ?? [],
			};
		},
	};
}
