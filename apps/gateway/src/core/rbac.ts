import type { Permission, Role } from "@hookflare/shared";

export type { Permission, Role };

/** Spec §6.2. Each role is a superset of the one before it. */
const VIEWER: readonly Permission[] = ["events.read"];
const OPERATOR: readonly Permission[] = [
	...VIEWER,
	"payload.read",
	"deliveries.replay",
	"destinations.operate",
];
const ADMIN: readonly Permission[] = [
	...OPERATOR,
	"config.write",
	"users.manage",
	"audit.read",
];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
	viewer: VIEWER,
	operator: OPERATOR,
	admin: ADMIN,
};

export function can(role: Role, permission: Permission): boolean {
	return ROLE_PERMISSIONS[role].includes(permission);
}

export function permissionsOf(role: Role): Permission[] {
	return [...ROLE_PERMISSIONS[role]];
}
