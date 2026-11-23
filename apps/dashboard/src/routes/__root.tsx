import type { QueryClient } from "@tanstack/react-query";
import {
	createRootRouteWithContext,
	Outlet,
	redirect,
	useLocation,
	useMatches,
} from "@tanstack/react-router";
import { useEffect } from "react";
import { AppShell } from "@/components/AppShell";
import { Toaster } from "@/components/ui/sonner";
import { authStateQuery } from "@/lib/queries/auth";

export type RouterContext = { queryClient: QueryClient };

declare module "@tanstack/react-router" {
	interface StaticDataRouteOption {
		pageTitle?: string;
	}
}

const BARE_ROUTES = new Set(["/setup", "/login"]);

export const Route = createRootRouteWithContext<RouterContext>()({
	beforeLoad: async ({ context, location }) => {
		const state = await context.queryClient
			.ensureQueryData(authStateQuery)
			.catch(() => null);
		if (state === null) {
			if (BARE_ROUTES.has(location.pathname)) return;
			throw redirect({ to: "/login", search: { next: location.href } });
		}
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
	const pageTitle = useMatches({
		select: (matches) =>
			matches.some((match) => match._notFound)
				? undefined
				: matches.at(-1)?.staticData.pageTitle,
	});
	useEffect(() => {
		document.title = pageTitle ? `${pageTitle} · Hookflare` : "Hookflare";
	}, [pageTitle]);

	return (
		<>
			{BARE_ROUTES.has(pathname) ? <Outlet /> : <AppShell />}
			<Toaster />
		</>
	);
}
