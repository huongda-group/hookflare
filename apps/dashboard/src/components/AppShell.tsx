import { useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import { ChevronRight, Menu } from "lucide-react";
import { type JSX, useEffect, useState } from "react";
import { AccountMenu } from "@/components/AccountMenu";
import { AppNavigation } from "@/components/AppNavigation";
import { ChangePasswordDialog } from "@/components/ChangePasswordDialog";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { subscribeUnauthorized } from "@/lib/api";
import { logout } from "@/lib/queries/auth";
import { useMeQuery } from "@/lib/queries/me";
import { LoadError } from "./LoadError";

/**
 * Breadcrumb labels for the shell's known route segments (spec §6). The values
 * double as the `to` targets, so a crumb only links to a route that exists.
 */
const KNOWN_SEGMENTS = {
	projects: { label: "Projects", to: "/projects" },
	endpoints: { label: "Endpoints", to: "/endpoints" },
	events: { label: "Events", to: "/events" },
	failures: { label: "Failures", to: "/failures" },
	alerts: { label: "Alerts", to: "/alerts" },
	archives: { label: "Archives", to: "/archives" },
	audit: { label: "Audit", to: "/audit" },
	settings: { label: "Settings", to: "/settings" },
} as const;

/** Segments that are not routes of their own, shown as text only. */
const NESTED_SEGMENT_LABELS: Record<string, string> = {
	sources: "Sources",
	destinations: "Destinations",
};

type KnownRoute = (typeof KNOWN_SEGMENTS)[keyof typeof KNOWN_SEGMENTS]["to"];
type Crumb = { key: string; label: string; to?: KnownRoute };

/**
 * Breadcrumbs derived from the pathname: known parents link to their route and
 * a trailing detail id is shown as text (spec §6). No new route or context.
 */
function Breadcrumbs({ pathname }: { pathname: string }): JSX.Element {
	const segments = pathname.split("/").filter(Boolean);
	const crumbs: Crumb[] = segments.map((segment, index) => {
		const key = `/${segments.slice(0, index + 1).join("/")}`;
		const known = KNOWN_SEGMENTS[segment as keyof typeof KNOWN_SEGMENTS];
		return {
			key,
			label: known?.label ?? NESTED_SEGMENT_LABELS[segment] ?? segment,
			to: known && index < segments.length - 1 ? known.to : undefined,
		};
	});
	if (crumbs.length === 0) {
		crumbs.push({ key: "/", label: "Overview" });
	}
	return (
		<nav aria-label="Breadcrumb" className="min-w-0">
			<ol className="flex min-w-0 items-center gap-1.5 text-sm">
				{crumbs.map((crumb, index) => (
					<li key={crumb.key} className="flex min-w-0 items-center gap-1.5">
						{index > 0 ? (
							<ChevronRight
								className="size-3.5 shrink-0 text-muted-foreground"
								aria-hidden="true"
							/>
						) : null}
						{crumb.to ? (
							<Link
								to={crumb.to}
								className="truncate rounded-sm text-muted-foreground hover:text-foreground"
							>
								{crumb.label}
							</Link>
						) : (
							<span aria-current="page" className="truncate font-medium">
								{crumb.label}
							</span>
						)}
					</li>
				))}
			</ol>
		</nav>
	);
}

export function AppShell() {
	const me = useMeQuery();
	const qc = useQueryClient();
	const navigate = useNavigate();
	const location = useLocation();
	const [pwOpen, setPwOpen] = useState(false);
	const [navOpen, setNavOpen] = useState(false);
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
		return <p className="p-6 text-muted-foreground">Loading…</p>;
	}
	// Logout is idempotent: even if the session is already gone, or the request
	// itself fails, the user meant to leave, so clear every cached query and
	// land on /login either way.
	const doLogout = async () => {
		try {
			await logout();
		} catch {
			// A failed logout must not trap the user inside the app.
		} finally {
			qc.clear();
			await navigate({ to: "/login" });
		}
	};
	const account = (
		<AccountMenu
			username={me.data.username}
			role={me.data.role}
			onChangePassword={() => setPwOpen(true)}
			onLogout={() => void doLogout()}
		/>
	);
	return (
		<>
			<a
				href="#main-content"
				className="rounded-md border border-border bg-surface text-sm font-medium text-action sr-only focus:not-sr-only focus:m-2 focus:inline-block focus:px-4 focus:py-2"
			>
				Skip to content
			</a>
			<div className="flex min-h-screen">
				{/* Two copies of the links exist only while the drawer is open: the
				    sidebar is CSS-hidden below 1024px and the dialog is unmounted
				    when closed (loaded while open by `Open navigation`). */}
				<aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-sidebar p-4 lg:flex">
					<Link
						to="/"
						className="mb-6 rounded-md px-3 text-lg font-semibold text-foreground"
					>
						Hookflare
					</Link>
					<AppNavigation />
					<div className="mt-auto pt-6">{account}</div>
				</aside>
				<div className="flex min-w-0 flex-1 flex-col">
					<header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface px-4 lg:px-6">
						<Dialog open={navOpen} onOpenChange={setNavOpen}>
							<DialogTrigger asChild>
								<Button
									variant="outline"
									size="icon"
									className="lg:hidden"
									aria-label="Open navigation"
								>
									<Menu aria-hidden="true" />
								</Button>
							</DialogTrigger>
							<DialogContent className="top-0 left-0 flex h-dvh max-h-dvh w-72 max-w-[85vw] translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-y-0 border-l-0 p-4 sm:max-w-72">
								<DialogTitle>Navigation</DialogTitle>
								<DialogDescription className="sr-only">
									Primary navigation and account actions
								</DialogDescription>
								<div className="flex min-h-0 flex-1 flex-col pt-2">
									<AppNavigation onNavigate={() => setNavOpen(false)} />
									<div className="mt-auto pt-6">{account}</div>
								</div>
							</DialogContent>
						</Dialog>
						<Breadcrumbs pathname={location.pathname} />
					</header>
					<main
						id="main-content"
						tabIndex={-1}
						className="min-w-0 flex-1 p-4 focus:outline-none lg:p-6"
					>
						<TooltipProvider>
							<Outlet />
						</TooltipProvider>
					</main>
				</div>
			</div>
			<ChangePasswordDialog open={pwOpen} onOpenChange={setPwOpen} />
			<Toaster />
		</>
	);
}
