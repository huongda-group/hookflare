import type { Permission } from "@hookflare/shared";
import { Link } from "@tanstack/react-router";
import {
	Activity,
	Archive,
	Bell,
	FolderKanban,
	LayoutDashboard,
	ScrollText,
	Settings,
	TriangleAlert,
	Webhook,
} from "lucide-react";
import type { ComponentType, JSX, SVGProps } from "react";
import { useCan } from "@/lib/permissions";
import { isProjectCollection, useActiveProject } from "@/lib/project-selection";

type NavPath =
	| "/"
	| "/events"
	| "/failures"
	| "/alerts"
	| "/projects"
	| "/endpoints"
	| "/archives"
	| "/audit"
	| "/settings";

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

type NavItemSpec = {
	to: NavPath;
	label: string;
	Icon: IconComponent;
	permission?: Permission;
};

type NavGroupSpec = {
	label: string;
	permission: Permission;
	items: NavItemSpec[];
};

const GROUPS: NavGroupSpec[] = [
	{
		label: "Monitor",
		permission: "events.read",
		items: [
			{ to: "/", label: "Overview", Icon: LayoutDashboard },
			{ to: "/events", label: "Events", Icon: Activity },
			{ to: "/failures", label: "Failures", Icon: TriangleAlert },
			{ to: "/alerts", label: "Alerts", Icon: Bell },
		],
	},
	{
		label: "Configure",
		permission: "events.read",
		items: [
			{ to: "/projects", label: "Projects", Icon: FolderKanban },
			{ to: "/endpoints", label: "Endpoints", Icon: Webhook },
		],
	},
	{
		label: "Administer",
		permission: "events.read",
		items: [
			{ to: "/archives", label: "Archives", Icon: Archive },
			{
				to: "/audit",
				label: "Audit",
				Icon: ScrollText,
				permission: "audit.read",
			},
			{ to: "/settings", label: "Settings", Icon: Settings },
		],
	},
];

export function AppNavigation({
	onNavigate,
}: {
	onNavigate?: () => void;
}): JSX.Element {
	return (
		<nav aria-label="Main" className="flex flex-col gap-5">
			{GROUPS.map((group) => (
				<NavGroup key={group.label} group={group} onNavigate={onNavigate} />
			))}
		</nav>
	);
}

function NavGroup({
	group,
	onNavigate,
}: {
	group: NavGroupSpec;
	onNavigate?: () => void;
}): JSX.Element | null {
	const allowed = useCan(group.permission);
	if (!allowed) return null;
	return (
		<div className="flex flex-col gap-1">
			<h2 className="px-3 text-[11px] font-semibold tracking-[0.1em] text-muted-foreground uppercase">
				{group.label}
			</h2>
			<ul className="flex flex-col gap-0.5">
				{group.items.map((item) => (
					<NavItem
						key={item.to}
						item={item}
						fallbackPermission={group.permission}
						onNavigate={onNavigate}
					/>
				))}
			</ul>
		</div>
	);
}

function NavItem({
	item,
	fallbackPermission,
	onNavigate,
}: {
	item: NavItemSpec;
	fallbackPermission: Permission;
	onNavigate?: () => void;
}): JSX.Element | null {
	const allowed = useCan(item.permission ?? fallbackPermission);
	const { projectId } = useActiveProject();
	if (!allowed) return null;
	const { to, label, Icon } = item;
	return (
		<li>
			<Link
				to={to}
				search={
					isProjectCollection(to) && projectId
						? { project_id: projectId }
						: undefined
				}
				onClick={onNavigate}
				className="flex min-h-10 items-center gap-2.5 rounded-[7px] px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [@media(pointer:coarse)]:min-h-11"
				activeProps={{
					className: "bg-selected font-medium text-selected-foreground",
					"aria-current": "page",
				}}
				activeOptions={{ exact: to === "/", includeSearch: false }}
			>
				<Icon className="size-4 shrink-0" aria-hidden="true" />
				<span className="truncate">{label}</span>
			</Link>
		</li>
	);
}
