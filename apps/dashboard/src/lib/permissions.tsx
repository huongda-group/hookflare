import type { Me, Permission } from "@hookflare/shared";
import type { ReactNode } from "react";
import { useMeQuery } from "./queries/me";

export function useMe(): Me | undefined {
	return useMeQuery().data;
}

export function useCan(permission: Permission): boolean {
	return useMe()?.permissions.includes(permission) ?? false;
}

export function Can({
	permission,
	children,
}: {
	permission: Permission;
	children: ReactNode;
}) {
	return useCan(permission) ? children : null;
}
