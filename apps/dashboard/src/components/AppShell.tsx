import { useQueryClient } from "@tanstack/react-query";
import {
	Link,
	Navigate,
	Outlet,
	useLocation,
	useMatches,
	useNavigate,
} from "@tanstack/react-router";
import { ChevronRight, Folder, Menu } from "lucide-react";
import { type JSX, useEffect, useState } from "react";
import { AccountMenu } from "@/components/AccountMenu";
import { AppNavigation } from "@/components/AppNavigation";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { TooltipProvider } from "@/components/ui/tooltip";
import { subscribeUnauthorized } from "@/lib/api";
import {
	ActiveProjectContext,
	isProjectCollection,
	useActiveProject,
	useProjectSelection,
} from "@/lib/project-selection";
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
	const { projectId } = useActiveProject();
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
								search={
									isProjectCollection(crumb.to) && projectId
										? { project_id: projectId }
										: undefined
								}
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
	const onProjectsIndex = useMatches({
		select: (matches) => matches.at(-1)?.routeId === "/projects/",
	});
	const [navOpen, setNavOpen] = useState(false);
	const selection = useProjectSelection(
		Boolean(me.data && !me.data.project_required),
	);
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
	const projectRequired = me.data.project_required;
	if (
		projectRequired &&
		!["/projects", "/projects/"].includes(location.pathname)
	) {
		return <Navigate to="/projects" replace />;
	}
	// The location may update before the previous route stops rendering.
	if (projectRequired && !onProjectsIndex) return null;
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
	const {
		catalog,
		projectId,
		projects,
		projectScoped,
		selectProject,
		missingScope,
	} = selection;
	const nameCounts = new Map<string, number>();
	for (const p of projects ?? [])
		nameCounts.set(p.name, (nameCounts.get(p.name) ?? 0) + 1);

	return (
		<ActiveProjectContext.Provider value={selection}>
			<a
				href="#main-content"
				className="rounded-md border border-border bg-surface text-sm font-medium text-action sr-only focus:not-sr-only focus:m-2 focus:inline-block focus:px-4 focus:py-2"
			>
				Skip to content
			</a>
			<div className="flex min-h-screen bg-canvas">
				{/* Two copies of the links exist only while the drawer is open: the
				    sidebar is CSS-hidden below 1024px and the dialog is unmounted
				    when closed (loaded while open by `Open navigation`). */}
				<aside className="hidden w-[222px] shrink-0 flex-col border-r border-border bg-sidebar px-3.5 pt-6 pb-4 lg:flex">
					<Link
						to={projectRequired ? "/projects" : "/"}
						search={
							!projectRequired && projectId
								? { project_id: projectId }
								: undefined
						}
						aria-label="Hookflare home"
						className="mb-7 flex items-center gap-2.5 rounded-md px-3 text-xl font-semibold tracking-tight text-foreground"
					>
						<img
							src="/favicon.svg"
							alt=""
							className="size-[29px] shrink-0 object-contain"
						/>
						hookflare
					</Link>
					{!projectRequired && <AppNavigation />}
				</aside>
				<div className="flex min-w-0 flex-1 flex-col">
					<header className="flex h-[54px] shrink-0 items-center gap-2 border-b border-border bg-surface px-4 sm:gap-3 lg:h-[61px] lg:px-9">
						{!projectRequired && (
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
								<DialogContent className="top-0 left-0 flex h-dvh max-h-dvh w-72 max-w-[85vw] translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-y-0 border-l-0 bg-sidebar p-4 sm:max-w-72">
									<DialogTitle>Navigation</DialogTitle>
									<DialogDescription className="sr-only">
										Primary navigation
									</DialogDescription>
									<div className="flex min-h-0 flex-1 flex-col overflow-y-auto pt-5">
										<AppNavigation onNavigate={() => setNavOpen(false)} />
									</div>
								</DialogContent>
							</Dialog>
						)}
						{!projectRequired && !!projects?.length && (
							<Select value={projectId ?? ""} onValueChange={selectProject}>
								<SelectTrigger
									aria-label="Active project"
									size="sm"
									className="min-w-0 max-w-[34vw] shrink-0 gap-1.5 px-2 font-medium hover:bg-accent data-[size=sm]:h-8 lg:max-w-64"
								>
									<Folder className="size-3.5" aria-hidden="true" />
									<span className="min-w-0 truncate">
										<SelectValue placeholder="Choose a project" />
									</span>
								</SelectTrigger>
								<SelectContent
									position="popper"
									align="start"
									collisionPadding={8}
									className="max-w-[min(20rem,var(--radix-select-content-available-width))]"
								>
									{projects.map((p) => (
										<SelectItem
											key={p.id}
											value={p.id}
											className="wrap-anywhere"
										>
											{(nameCounts.get(p.name) ?? 0) > 1
												? `${p.name} (${p.id})`
												: p.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						)}
						<Breadcrumbs pathname={location.pathname} />
						<AccountMenu
							username={me.data.username}
							role={me.data.role}
							canChangePassword={!projectRequired}
							onLogout={doLogout}
						/>
					</header>
					<main
						id="main-content"
						tabIndex={-1}
						className="mx-auto w-full min-w-0 max-w-[1510px] flex-1 px-[17px] py-6 focus:outline-none lg:px-9 lg:py-8"
					>
						<TooltipProvider>
							{projectRequired && (
								<p className="mb-4 rounded-md border border-border bg-surface p-3 text-sm">
									{me.data.permissions.includes("config.write")
										? "Create your first project to unlock the rest of Hookflare."
										: "Ask an admin to create the first project before you can use Hookflare."}
								</p>
							)}
							{!projectRequired && !projects && catalog.isError && (
								<LoadError
									what="projects"
									error={catalog.error}
									retrying={catalog.isFetching}
									onRetry={() => void catalog.refetch()}
								/>
							)}
							{!projectScoped || projectRequired ? (
								<Outlet />
							) : projectId && !missingScope ? (
								<Outlet key={projectId} />
							) : projects ? (
								<p role="alert" className="text-sm text-muted-foreground">
									{projects.length > 0
										? projectId
											? "Loading project…"
											: "Choose an available project to continue."
										: "No projects available."}
								</p>
							) : !catalog.isError ? (
								<p className="text-sm text-muted-foreground">
									Loading projects…
								</p>
							) : null}
						</TooltipProvider>
					</main>
				</div>
			</div>
		</ActiveProjectContext.Provider>
	);
}
