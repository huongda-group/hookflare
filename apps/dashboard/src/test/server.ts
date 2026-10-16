import type { Me, Permission, Role, Settings } from "@hookflare/shared";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";

export const ORIGIN = "http://localhost:3000";
export const apiUrl = (path: string) => `${ORIGIN}/api/admin/v1${path}`;

const VIEWER: Permission[] = ["events.read"];
const OPERATOR: Permission[] = [
	...VIEWER,
	"payload.read",
	"deliveries.replay",
	"destinations.operate",
];
const ADMIN: Permission[] = [
	...OPERATOR,
	"config.write",
	"users.manage",
	"audit.read",
	"settings.manage",
];
const BY_ROLE: Record<Role, Permission[]> = {
	viewer: VIEWER,
	operator: OPERATOR,
	admin: ADMIN,
};

export function meFor(role: Role): Me {
	return { email: `${role}@example.com`, role, permissions: BY_ROLE[role] };
}

export const DEFAULT_SETTINGS: Settings = {
	retry_defaults: {
		timeout_ms: 10_000,
		max_attempts: 20,
		backoff_base_s: 30,
		backoff_max_s: 21_600,
	},
	updated_at: null,
	alert_rules: {
		failure_threshold: 5,
		stuck_after_s: 300,
		dead_quiet_s: 1800,
		d1_warn_pct: 80,
		reminder_s: 3600,
	},
	alert_rules_updated_at: null,
};

const empty = { data: [], next_cursor: null };

/** Every list answers empty unless a test overrides it with server.use(...). */
export const server = setupServer(
	http.get(apiUrl("/me"), () => HttpResponse.json(meFor("admin"))),
	http.get(apiUrl("/settings"), () => HttpResponse.json(DEFAULT_SETTINGS)),
	...[
		"/projects",
		"/sources",
		"/destinations",
		"/events",
		"/failures",
		"/users",
		"/audit-logs",
	].map((p) => http.get(apiUrl(p), () => HttpResponse.json(empty))),
	http.get(apiUrl("/destinations/stats"), () =>
		HttpResponse.json({ data: [] }),
	),
);
