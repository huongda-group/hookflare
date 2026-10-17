import type { Permission } from "@hookflare/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ChangePasswordDialog } from "@/components/ChangePasswordDialog";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { subscribeUnauthorized } from "@/lib/api";
import { useCan } from "@/lib/permissions";
import { logout } from "@/lib/queries/auth";
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
	const qc = useQueryClient();
	const navigate = useNavigate();
	const location = useLocation();
	const [pwOpen, setPwOpen] = useState(false);
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
	// Logout is idempotent: even if the session is already gone, the user
	// meant to leave, so clear the cache and land on /login either way.
	const doLogout = async () => {
		try {
			await logout();
		} finally {
			qc.clear();
			await navigate({ to: "/login" });
		}
	};
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
					<div className="mt-2 flex flex-col items-start gap-1">
						<Button
							variant="ghost"
							size="sm"
							className="h-auto px-0 text-xs"
							onClick={() => setPwOpen(true)}
						>
							Change password
						</Button>
						<Button
							variant="ghost"
							size="sm"
							className="h-auto px-0 text-xs"
							onClick={() => void doLogout()}
						>
							Log out
						</Button>
					</div>
				</div>
			</aside>
			<main className="flex-1 p-6">
				<TooltipProvider>
					<Outlet />
				</TooltipProvider>
			</main>
			<ChangePasswordDialog open={pwOpen} onOpenChange={setPwOpen} />
			<Toaster />
		</div>
	);
}
