import type { Permission } from "@hookflare/shared";
import { Link, Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { subscribeUnauthorized } from "@/lib/api";
import { useCan } from "@/lib/permissions";
import { useMeQuery } from "@/lib/queries/me";
import { LoadError } from "./LoadError";

const NAV: { to: string; label: string; permission?: Permission }[] = [
	{ to: "/", label: "Overview" },
	{ to: "/projects", label: "Projects" },
	{ to: "/endpoints", label: "Endpoints" },
	{ to: "/events", label: "Events" },
	{ to: "/failures", label: "Failures" },
	{ to: "/alerts", label: "Alerts" },
	{ to: "/archives", label: "Archives" },
	{ to: "/audit", label: "Audit", permission: "audit.read" },
	{ to: "/settings", label: "Settings" },
];

function NavItem({ to, label, permission }: (typeof NAV)[number]) {
	const allowed = useCan(permission ?? "events.read");
	if (!allowed) return null;
	return (
		<Link
			to={to}
			className="block rounded px-3 py-2 text-sm hover:bg-neutral-100"
			activeProps={{ className: "bg-neutral-100 font-medium" }}
			activeOptions={{ exact: to === "/" }}
		>
			{label}
		</Link>
	);
}

export function AppShell() {
	const me = useMeQuery();
	const navigate = useNavigate();
	const location = useLocation();
	// Spec §6.7: any 401 from the API sends the user to `/login?next=<here>`.
	useEffect(
		() =>
			subscribeUnauthorized(() => {
				void navigate({ to: "/login", search: { next: location.href } });
			}),
		[navigate, location.href],
	);
	if (!me.data && me.isError) {
		return (
			<LoadError
				what="your account"
				error={me.error}
				retrying={me.isFetching}
				onRetry={() => void me.refetch()}
			/>
		);
	}
	if (!me.data) {
		return <p className="p-6 text-neutral-500">Loading…</p>;
	}
	return (
		<div className="flex min-h-screen min-w-[1024px]">
			<aside className="w-56 shrink-0 border-r p-4">
				<div className="mb-6 text-lg font-semibold">Hookflare</div>
				<nav className="space-y-1">
					{NAV.map((n) => (
						<NavItem key={n.to} {...n} />
					))}
				</nav>
				<div className="mt-8 border-t pt-4 text-xs text-neutral-500">
					<div>{me.data.username}</div>
					<div className="capitalize">{me.data.role}</div>
				</div>
			</aside>
			<main className="flex-1 p-6">
				<TooltipProvider>
					<Outlet />
				</TooltipProvider>
			</main>
			<Toaster />
		</div>
	);
}
