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

/**
 * Spec M7 §6.7: a `401` from the admin API (the session is gone) sends the
 * user to `/login`. The public `/auth/*` paths are exempt because their `401`
 * is `invalid_credentials`, which the login and setup pages show inline.
 */
const listeners = new Set<() => void>();
function notifyUnauthorized() {
	for (const l of listeners) l();
}
export function subscribeUnauthorized(cb: () => void) {
	listeners.add(cb);
	return () => {
		listeners.delete(cb);
	};
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

export async function apiRaw(
	path: string,
	init: RequestInit = {},
): Promise<Response> {
	let res: Response;
	try {
		res = await fetch(url(path), { credentials: "same-origin", ...init });
	} catch {
		throw new ApiError(0, "network_error");
	}
	const type = res.headers.get("content-type") ?? "";
	if (!res.ok) {
		const body = type.includes("json")
			? ((await res.json()) as Record<string, unknown>)
			: {};
		if (res.status === 401 && !path.startsWith("/auth/")) notifyUnauthorized();
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

function sendInit(method: string, body?: unknown): RequestInit {
	return {
		method,
		headers: body === undefined ? {} : { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	};
}

function send<T>(method: string, path: string, body?: unknown) {
	return json<T>(path, sendInit(method, body));
}

/** For endpoints that answer `204 No Content` (login, logout, change password). */
function sendVoid(method: string, path: string, body?: unknown): Promise<void> {
	return apiRaw(path, sendInit(method, body)).then(() => undefined);
}

export const api = {
	get: <T>(path: string, query: Record<string, unknown> = {}) =>
		json<T>(`${path}${qs(query)}`),
	post: <T>(path: string, body?: unknown) => send<T>("POST", path, body),
	/** A POST whose success is an empty body (`204`). */
	postVoid: (path: string, body?: unknown) => sendVoid("POST", path, body),
	patch: <T>(path: string, body?: unknown) => send<T>("PATCH", path, body),
	/** DELETE answers 204 with an empty body, so there is nothing to parse. */
	delete: (path: string) =>
		apiRaw(path, { method: "DELETE" }).then(() => undefined),
};

export type BackupRunResult = { backup_id: string; instance_id: string };

/** Starts a manual backup run (202) or throws ApiError backup_running (409). */
export function runBackupNow(): Promise<BackupRunResult> {
	return api.post<BackupRunResult>("/backups/run", {});
}
