import type { ResourceKind } from "./resource-options";

/** One key factory for every resource; mutations invalidate by prefix (spec §9.2). */
export const qk = {
	me: ["me"] as const,
	authState: ["auth-state"] as const,
	settings: ["settings"] as const,
	overview: (q: object) => ["overview", q] as const,
	/** Named option pages (Task 4): separate from the plain/infinite list keys. */
	resourceOptions: (kind: ResourceKind, projectId?: string) =>
		["resource-options", kind, projectId ?? null] as const,
	projects: {
		all: ["projects"] as const,
		list: (q: object) => ["projects", "list", q] as const,
		one: (id: string) => ["projects", id] as const,
	},
	destinations: {
		all: ["destinations"] as const,
		list: (q: object) => ["destinations", "list", q] as const,
		one: (id: string) => ["destinations", id] as const,
		stats: (q: object) => ["destinations", "stats", q] as const,
		tests: (id: string) => ["destinations", id, "tests"] as const,
	},
	sources: {
		all: ["sources"] as const,
		list: (q: object) => ["sources", "list", q] as const,
		one: (id: string) => ["sources", id] as const,
	},
	events: {
		all: ["events"] as const,
		list: (q: object) => ["events", "list", q] as const,
		one: (id: string) => ["events", id] as const,
	},
	failures: {
		all: ["failures"] as const,
		list: (q: object) => ["failures", "list", q] as const,
	},
	alerts: {
		all: ["alerts"] as const,
		list: (q: object) => ["alerts", "list", q] as const,
		one: (id: string) => ["alerts", id] as const,
	},
	archives: { list: (q: object) => ["archives", "list", q] as const },
	backups: { summary: ["backups", "summary"] as const },
	alertChannels: { all: ["alert-channels"] as const },
	users: { all: ["users"] as const },
	audit: { list: (q: object) => ["audit", q] as const },
};
