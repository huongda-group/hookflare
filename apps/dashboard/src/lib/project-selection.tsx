import {
	useLocation,
	useMatches,
	useNavigate,
	useParams,
} from "@tanstack/react-router";
import { createContext, useContext, useEffect, useState } from "react";
import { z } from "zod";
import { useProjectCatalog } from "./queries/projects";

const STORAGE_KEY = "hookflare.activeProjectId";
export const projectDetailSearch = z.object({
	project_id: z.string().optional().catch(undefined),
});

const PROJECT_COLLECTIONS = new Set<string>([
	"/",
	"/endpoints",
	"/events",
	"/failures",
	"/alerts",
]);

export function isProjectCollection(path: string): boolean {
	return PROJECT_COLLECTIONS.has(path);
}

export function alertLinkScope(search: URLSearchParams) {
	if (search.has("project_id")) return "project";
	if (search.get("scope") === "deployment") return "deployment";
	return search.has("scope") ? "project" : "legacy";
}

type Selection = {
	projectId: string | undefined;
	selectProject: (id: string) => void;
};

export const ActiveProjectContext = createContext<Selection>({
	projectId: undefined,
	selectProject: () => {},
});

export function useActiveProject() {
	return useContext(ActiveProjectContext);
}

function remember(id: string) {
	try {
		window.localStorage.setItem(STORAGE_KEY, id);
	} catch {}
}

export function useProjectSelection(enabled: boolean) {
	const catalog = useProjectCatalog(enabled);
	const navigate = useNavigate();
	const location = useLocation();
	const route = useMatches({ select: (matches) => matches.at(-1)?.routeId });
	const matchedPath = useMatches({
		select: (matches) => matches.at(-1)?.pathname,
	});
	const { sourceId, destinationId, eventId, alertId } = useParams({
		strict: false,
	});
	const [remembered, setRemembered] = useState(() => {
		try {
			return window.localStorage.getItem(STORAGE_KEY) ?? undefined;
		} catch {
			return undefined;
		}
	});
	const search = new URLSearchParams(location.searchStr);
	const projectScoped = Boolean(
		route &&
			(isProjectCollection(route.replace(/(.+)\/$/, "$1")) ||
				route === "/events/$eventId" ||
				route === "/endpoints/sources/$sourceId" ||
				route === "/endpoints/destinations/$destinationId" ||
				(route === "/alerts/$alertId" && alertLinkScope(search) === "project")),
	);
	const explicit = projectScoped ? search.getAll("project_id") : [];
	const projects = enabled ? catalog.data : undefined;
	const hasProject = (id: string | undefined) =>
		projects?.some((p) => p.id === id);
	const projectId =
		explicit.length > 0
			? explicit.length === 1 && hasProject(explicit[0])
				? explicit[0]
				: undefined
			: hasProject(remembered)
				? remembered
				: projects?.[0]?.id;
	const missingScope = projectScoped && explicit.length === 0;

	useEffect(() => {
		if (!projectId) return;
		setRemembered(projectId);
		remember(projectId);
		if (
			!missingScope ||
			matchedPath?.replace(/\/$/, "") !== location.pathname.replace(/\/$/, "")
		)
			return;
		const search = { project_id: projectId };
		const opts = { hash: true, replace: true, resetScroll: false } as const;
		switch (route) {
			case "/endpoints/sources/$sourceId":
				/* istanbul ignore else -- @preserve */
				if (sourceId)
					void navigate({ ...opts, to: route, params: { sourceId }, search });
				break;
			case "/endpoints/destinations/$destinationId":
				/* istanbul ignore else -- @preserve */
				if (destinationId)
					void navigate({
						...opts,
						to: route,
						params: { destinationId },
						search,
					});
				break;
			case "/events/$eventId":
				/* istanbul ignore else -- @preserve */
				if (eventId)
					void navigate({ ...opts, to: route, params: { eventId }, search });
				break;
			/* istanbul ignore next -- @preserve */
			case "/alerts/$alertId":
				if (alertId)
					void navigate({ ...opts, to: route, params: { alertId }, search });
				break;
			default:
				updateCollection(navigate, route, projectId, false);
		}
	}, [
		projectId,
		missingScope,
		matchedPath,
		location.pathname,
		navigate,
		route,
		sourceId,
		destinationId,
		eventId,
		alertId,
	]);

	const selectProject = (id: string) => {
		/* istanbul ignore if -- @preserve */
		if (id === projectId || !hasProject(id)) return;
		if (!projectScoped) {
			setRemembered(id);
			remember(id);
			return;
		}
		switch (route) {
			case "/endpoints/sources/$sourceId":
				void navigate({
					to: "/endpoints",
					search: { project_id: id, tab: "sources" },
				});
				break;
			case "/endpoints/destinations/$destinationId":
				void navigate({
					to: "/endpoints",
					search: { project_id: id, tab: "destinations" },
				});
				break;
			case "/events/$eventId":
				void navigate({ to: "/events", search: { project_id: id } });
				break;
			case "/alerts/$alertId":
				void navigate({
					to: "/alerts",
					search: { project_id: id, status: "open" },
				});
				break;
			default:
				updateCollection(navigate, route, id, true);
		}
	};

	return {
		catalog,
		projects,
		projectId,
		selectProject,
		projectScoped,
		missingScope,
	};
}

function updateCollection(
	navigate: ReturnType<typeof useNavigate>,
	route: string | undefined,
	project_id: string,
	switching: boolean,
) {
	const opts = { hash: true, replace: !switching, resetScroll: false } as const;
	switch (route) {
		case "/":
			void navigate({
				...opts,
				to: "/",
				search: ({ range }) => ({ range, project_id }),
			});
			break;
		case "/endpoints/":
			void navigate({
				...opts,
				to: "/endpoints",
				search: ({ tab }) => ({
					tab: tab === "sources" ? "sources" : "destinations",
					project_id,
				}),
			});
			break;
		case "/events/":
			void navigate({
				...opts,
				to: "/events",
				search: ({
					source_id,
					destination_id,
					provider_event_id,
					status,
					http_status,
					from,
					to,
				}) => ({
					project_id,
					source_id: switching ? undefined : source_id,
					destination_id: switching ? undefined : destination_id,
					provider_event_id: switching ? undefined : provider_event_id,
					status: Array.isArray(status) ? status : undefined,
					http_status,
					from,
					to,
				}),
			});
			break;
		case "/failures":
			void navigate({
				...opts,
				to: "/failures",
				search: ({ tab, destination_id, unresolved, from, to }) => ({
					project_id,
					tab: tab === "failed_final" ? "failed_final" : "dead",
					destination_id: switching ? undefined : destination_id,
					unresolved,
					from,
					to,
				}),
			});
			break;
		case "/alerts/":
			void navigate({
				...opts,
				to: "/alerts",
				search: ({ status, rule }) => ({
					project_id,
					status: status === "all" || status === "resolved" ? status : "open",
					rule,
				}),
			});
			break;
	}
}
