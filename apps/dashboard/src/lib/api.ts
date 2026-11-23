import { toast } from "sonner";
import { getWriteToast } from "./write-toast";

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
const WRITE_METHODS = new Set(["POST", "PUT", "DELETE", "PATCH"]);
export const PERMISSION_DENIED_MESSAGE =
	"You do not have permission for that action.";

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

/** Add scope without dropping existing request parameters. */
export function projectScopedPath(path: string, projectId: string): string {
	const [pathname, query] = path.split(/\?(.*)/s, 2);
	const params = new URLSearchParams(query);
	params.set("project_id", projectId);
	return `${pathname}?${params}`;
}

/** Absolute URL: jsdom/undici fetch cannot resolve relative paths. */
const url = (path: string) =>
	new URL(`${BASE}${path}`, window.location.origin).toString();

export async function apiRaw(
	path: string,
	init: RequestInit = {},
	body?: unknown,
): Promise<Response> {
	const method = init.method?.toUpperCase() ?? "GET";
	const isWrite = WRITE_METHODS.has(method);
	const isPublicAuth = path.startsWith("/auth/");
	const feedback = isWrite
		? getWriteToast(method, path.split("?", 1)[0], body)
		: undefined;
	let res: Response;
	try {
		res = await fetch(url(path), { credentials: "same-origin", ...init });
	} catch {
		if (isWrite) toast.error("Network error. Please try again.");
		throw new ApiError(0, "network_error");
	}
	const type = res.headers.get("content-type") ?? "";
	if (!res.ok) {
		if (isWrite) {
			toast.error(
				res.status === 403 && !isPublicAuth
					? PERMISSION_DENIED_MESSAGE
					: (feedback?.error ?? "Action failed."),
			);
		}
		const body = type.includes("json")
			? ((await res.json()) as Record<string, unknown>)
			: {};
		const code =
			typeof body.error === "string" ? body.error : `http_${res.status}`;
		// `POST /me/password` answers 401 `wrong_password` for a bad current
		// password. That is a form error, not an expired session, so it must
		// not send the user to /login (spec M7 §6.6).
		if (res.status === 401 && !isPublicAuth && code !== "wrong_password")
			notifyUnauthorized();
		throw new ApiError(
			res.status,
			code,
			body.issues as Issue[] | undefined,
			body.required as string | undefined,
			body,
		);
	}
	if (isWrite) {
		toast.success(
			res.status === 202 && !feedback?.queued
				? "Request accepted."
				: (feedback?.success ?? "Action completed."),
		);
	}
	return res;
}

async function json<T>(
	path: string,
	init: RequestInit = {},
	body?: unknown,
): Promise<T> {
	const res = await apiRaw(path, init, body);
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
	return json<T>(path, sendInit(method, body), body);
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
	put: <T>(path: string, body?: unknown) => send<T>("PUT", path, body),
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
