import type { QueryClient } from "@tanstack/react-query";
import {
	createRootRouteWithContext,
	Outlet,
	redirect,
	useLocation,
} from "@tanstack/react-router";
import { AppShell } from "@/components/AppShell";
import { authStateQuery } from "@/lib/queries/auth";

export type RouterContext = { queryClient: QueryClient };

/** These render outside the app shell and have no `/me` to load (spec §6.7). */
const BARE_ROUTES = new Set(["/setup", "/login"]);

export const Route = createRootRouteWithContext<RouterContext>()({
	beforeLoad: async ({ context, location }) => {
		const state = await context.queryClient.ensureQueryData(authStateQuery);
		if (state.setup_required && location.pathname !== "/setup") {
			throw redirect({ to: "/setup" });
		}
		if (!state.setup_required && location.pathname === "/setup") {
			throw redirect({ to: "/login" });
		}
	},
	component: RootComponent,
});

function RootComponent() {
	const { pathname } = useLocation();
	if (BARE_ROUTES.has(pathname)) return <Outlet />;
	return <AppShell />;
}
