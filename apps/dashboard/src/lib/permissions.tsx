import type { Me, Permission } from "@hookflare/shared";
import type { ReactNode } from "react";
import { useMeQuery } from "./queries/me";

/** The shell renders children only after /me loaded, so `data` is set there. */
export function useMe(): Me | undefined {
	return useMeQuery().data;
}

export function useCan(permission: Permission): boolean {
	return useMe()?.permissions.includes(permission) ?? false;
}

/** Hides, never disables: the server still decides (spec M4-12). */
export function Can({
	permission,
	children,
}: {
	permission: Permission;
	children: ReactNode;
}) {
	return useCan(permission) ? children : null;
}
