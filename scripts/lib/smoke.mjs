export function smokeEnv(env = process.env, { urlVar = "HOOKFLARE_URL" } = {}) {
	const url = env[urlVar];
	const token = env.HOOKFLARE_API_TOKEN;
	const sinkUrl = env.SINK_URL;
	if (!url || !token || !sinkUrl) {
		return null;
	}
	const projectId =
		env[`${urlVar.replace(/_URL$/, "")}_SMOKE_PROJECT_ID`]?.trim();
	return { url, token, sinkUrl, ...(projectId ? { projectId } : {}) };
}

export function smokeUrlVar(worker) {
	return `${worker.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_URL`;
}

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

function realSleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function isPollTimeout(err) {
	return err instanceof Error && err.message.startsWith("poll: ");
}

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

export function runId() {
	let time = Date.now();
	const rand = crypto.getRandomValues(new Uint8Array(16));
	let out = "";
	for (const byte of rand) {
		out += CROCKFORD[byte % 32];
	}
	let timePart = "";
	for (let i = 0; i < 10; i++) {
		timePart = CROCKFORD[time % 32] + timePart;
		time = Math.floor(time / 32);
	}
	return timePart + out;
}

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

async function throwForStatus(res, what) {
	if (res.ok) {
		return;
	}
	const text = await res.text().catch(() => "");
	throw new Error(
		`smoke: ${what} failed with ${res.status} ${text.slice(0, 200)}`,
	);
}

const SMOKE_NAME = "smoke";
const SMOKE_REASON = "post-deploy smoke test";
const PAGE = 100;

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
	let smokeSecret = null;
	const smokeHeader = "x-smoke-signature";
	const smokeAuthConfig = {
		header: smokeHeader,
		algorithm: "sha256",
		encoding: "hex",
	};

	async function readJson(what, res) {
		await throwForStatus(res, what);
		return res.json();
	}

	async function findListed(kind, filters, pick, unique = false) {
		let cursor = null;
		let found = null;
		do {
			const params = new URLSearchParams({ ...filters, limit: String(PAGE) });
			if (cursor !== null) {
				params.set("cursor", cursor);
			}
			const page = await readJson(
				`list ${kind}`,
				await fetchFn(`${base}/api/admin/v1/${kind}?${params}`, { headers }),
			);
			for (const row of page.data ?? []) {
				if (!pick(row)) continue;
				if (!unique) return row;
				if (found !== null) {
					throw new Error(
						`smoke: multiple ${kind} match; configure the dedicated smoke project ID`,
					);
				}
				found = row;
			}
			cursor = page.next_cursor ?? null;
		} while (cursor !== null);
		return found;
	}

	return {
		sinkUrl,
		async ensureProject(name) {
			if (env.projectId) {
				const project = await readJson(
					`get project ${env.projectId}`,
					await fetchFn(
						`${base}/api/admin/v1/projects/${encodeURIComponent(env.projectId)}`,
						{ headers },
					),
				);
				projectId = project.id;
				return { id: project.id };
			}
			const existing = await findListed(
				"projects",
				{},
				(project) => project.name === name,
				true,
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
					body: JSON.stringify({ name }),
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
