export type Issue = { path: string; code: string; message: string };

export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		readonly issues?: Issue[],
		readonly required?: string,
		readonly body?: Record<string, unknown>,
	) {
		super(code);
	}
}

const BASE = "/api/admin/v1";

// Spec §9.1: an expired Access session answers with a redirect to the login
// domain. fetch either fails (CORS) or follows it to HTML; both mean "reload".
let expired = false;
const listeners = new Set<() => void>();
function markExpired() {
	if (expired) return;
	expired = true;
	for (const l of listeners) l();
}
export function subscribeSessionExpired(cb: () => void) {
	listeners.add(cb);
	return () => listeners.delete(cb);
}
export const isSessionExpired = () => expired;
export function resetSessionExpired() {
	expired = false;
	for (const l of listeners) l();
}

/** `?a=1&s=x&s=y`. Arrays repeat the key; undefined, null, and "" are skipped. */
export function qs(query: Record<string, unknown>): string {
	const p = new URLSearchParams();
	for (const [k, v] of Object.entries(query)) {
		for (const item of Array.isArray(v) ? v : [v]) {
			if (item === undefined || item === null || item === "") continue;
			p.append(k, String(item));
		}
	}
	const s = p.toString();
	return s ? `?${s}` : "";
}

/** Absolute URL: jsdom/undici fetch cannot resolve relative paths. */
const url = (path: string) =>
	new URL(`${BASE}${path}`, window.location.origin).toString();

/** `allowHtml`: the payload endpoint returns the stored body, which may itself be HTML. */
export async function apiRaw(
	path: string,
	init: RequestInit = {},
	opts: { allowHtml?: boolean } = {},
): Promise<Response> {
	let res: Response;
	try {
		res = await fetch(url(path), { credentials: "same-origin", ...init });
	} catch {
		markExpired();
		throw new ApiError(0, "session_expired");
	}
	const type = res.headers.get("content-type") ?? "";
	// The admin API never redirects, so a followed redirect is the Access login.
	if (res.redirected || (!opts.allowHtml && type.includes("text/html"))) {
		markExpired();
		throw new ApiError(res.status, "session_expired");
	}
	if (!res.ok) {
		const body = type.includes("json")
			? ((await res.json()) as Record<string, unknown>)
			: {};
		throw new ApiError(
			res.status,
			typeof body.error === "string" ? body.error : `http_${res.status}`,
			body.issues as Issue[] | undefined,
			body.required as string | undefined,
			body,
		);
	}
	return res;
}

async function json<T>(path: string, init: RequestInit = {}): Promise<T> {
	const res = await apiRaw(path, init);
	return (await res.json()) as T;
}

function send<T>(method: string, path: string, body?: unknown) {
	return json<T>(path, {
		method,
		headers: body === undefined ? {} : { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

export const api = {
	get: <T>(path: string, query: Record<string, unknown> = {}) =>
		json<T>(`${path}${qs(query)}`),
	post: <T>(path: string, body?: unknown) => send<T>("POST", path, body),
	patch: <T>(path: string, body?: unknown) => send<T>("PATCH", path, body),
};
