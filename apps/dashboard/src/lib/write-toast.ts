type WriteToast = {
	success: string;
	error: string;
	queued: boolean;
};

function feedback(success: string, action: string, queued = false): WriteToast {
	return { success, error: `Could not ${action}`, queued };
}

const replay = feedback("Replay requested", "request replay", true);

const postToasts: ReadonlyArray<readonly [string | RegExp, WriteToast]> = [
	["/auth/setup", feedback("Initial setup complete", "complete setup")],
	["/auth/login", feedback("Login session", "log in")],
	["/auth/logout", feedback("Logged out", "log out")],
	["/me/password", feedback("Password changed", "change password")],
	["/projects", feedback("Project created", "create project")],
	["/sources", feedback("Source created", "create source")],
	["/destinations", feedback("Destination created", "create destination")],
	[
		/^\/destinations\/[^/]+\/pause$/,
		feedback("Destination paused", "pause destination"),
	],
	[
		/^\/destinations\/[^/]+\/resume$/,
		feedback("Destination resumed", "resume destination"),
	],
	[
		/^\/sources\/[^/]+\/rotate-secret$/,
		feedback("Source secret rotated", "rotate source secret"),
	],
	[
		/^\/destinations\/[^/]+\/rotate-secret$/,
		feedback(
			"Destination signing secret rotated",
			"rotate destination signing secret",
		),
	],
	[
		/^\/destinations\/[^/]+\/test$/,
		feedback("Test delivery finished", "run test delivery"),
	],
	["/failures/replay", replay],
	[/^\/events\/[^/]+\/replay$/, replay],
	[
		"/alert-channels",
		feedback("Alert channel created", "create alert channel"),
	],
	[
		/^\/alert-channels\/[^/]+\/test$/,
		feedback("Alert channel test finished", "test alert channel"),
	],
	[
		"/archives/run",
		feedback("Archive run requested", "request archive run", true),
	],
	["/backups/run", feedback("Backup requested", "request backup", true)],
	["/users", feedback("User created", "create user")],
	[
		/^\/users\/[^/]+\/password$/,
		feedback("User password reset", "reset user password"),
	],
	[
		/^\/users\/[^/]+\/tokens$/,
		feedback("API token created", "create API token"),
	],
	[
		/^\/users\/[^/]+\/tokens\/[^/]+\/revoke$/,
		feedback("API token revoked", "revoke API token"),
	],
];

function updateResource(
	name: string,
	label: string,
	enabled?: boolean,
): WriteToast {
	if (enabled === true) return feedback(`${name} enabled`, `enable ${label}`);
	if (enabled === false)
		return feedback(`${name} disabled`, `disable ${label}`);
	return feedback(`${name} updated`, `update ${label}`);
}

/** Choose fixed copy; never include resource IDs or request/response values. */
export function getWriteToast(
	method: string,
	path: string,
	body?: unknown,
): WriteToast | undefined {
	if (method === "POST") {
		return postToasts.find(([route]) =>
			typeof route === "string" ? route === path : route.test(path),
		)?.[1];
	}

	if (method === "DELETE" && /^\/alert-channels\/[^/]+$/.test(path)) {
		return feedback("Alert channel deleted", "delete alert channel");
	}

	if (method !== "PATCH") return;
	const fields =
		body && typeof body === "object" ? (body as Record<string, unknown>) : {};
	const enabled =
		fields.status === "active"
			? true
			: fields.status === "disabled"
				? false
				: undefined;
	if (/^\/projects\/[^/]+$/.test(path)) {
		return updateResource("Project", "project", enabled);
	}
	if (/^\/sources\/[^/]+$/.test(path)) {
		return updateResource("Source", "source", enabled);
	}
	if (/^\/destinations\/[^/]+$/.test(path)) {
		return updateResource("Destination", "destination", enabled);
	}
	if (/^\/users\/[^/]+$/.test(path)) {
		if (typeof fields.disabled === "boolean") {
			return updateResource("User", "user", !fields.disabled);
		}
		if ("role" in fields)
			return feedback("User role updated", "update user role");
		return updateResource("User", "user");
	}
	if (/^\/alert-channels\/[^/]+$/.test(path)) {
		return updateResource(
			"Alert channel",
			"alert channel",
			typeof fields.enabled === "boolean" ? fields.enabled : undefined,
		);
	}
	if (path === "/settings") {
		if ("retry_defaults" in fields)
			return feedback("Retry defaults saved", "save retry defaults");
		if ("storage" in fields)
			return feedback("Storage settings saved", "save storage settings");
		if ("alert_rules" in fields)
			return feedback("Alert rules saved", "save alert rules");
		return feedback("Settings saved", "save settings");
	}
}
