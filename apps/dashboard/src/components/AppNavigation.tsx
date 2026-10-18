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

/** Every destination the shell links to; literal so `Link` stays type-checked. */
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
	/** Stricter than the group's permission (for example `audit.read`). */
	permission?: Permission;
};

type NavGroupSpec = {
	label: string;
	/** A group renders only when this permission is held (spec §9). */
	permission: Permission;
	items: NavItemSpec[];
};

/**
 * Spec §6 navigation groups. `permission` is the shared capability the route
 * needs, never a role name: a 403 mid-session refetch of `/me` removes the
 * entry on the next render.
 */
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
			{ to: "/audit", label: "Audit", Icon: ScrollText, permission: "audit.read" },
			{ to: "/settings", label: "Settings", Icon: Settings },
		],
	},
];

/**
 * The primary navigation, shared by the ≥1024px sidebar and the mobile drawer.
 * `onNavigate` lets the drawer close itself when a destination is chosen.
 */
export function AppNavigation({
	onNavigate,
}: {
	onNavigate?: () => void;
}): JSX.Element {
	return (
		<nav aria-label="Main" className="flex flex-col gap-6">
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
			<h2 className="px-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
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
	if (!allowed) return null;
	const { to, label, Icon } = item;
	return (
		<li>
			<Link
				to={to}
				onClick={onNavigate}
				// Spec §6: active shows background plus text weight, not color
				// alone. `exact` only for `/`, so detail routes light up parents.
				className="flex min-h-11 items-center gap-2.5 rounded-md px-3 py-2 text-sm text-foreground transition-colors hover:bg-accent"
				activeProps={{
					className: "bg-selected font-medium text-selected-foreground",
					"aria-current": "page",
				}}
				activeOptions={{ exact: to === "/" }}
			>
				<Icon className="size-4 shrink-0" aria-hidden="true" />
				<span className="truncate">{label}</span>
			</Link>
		</li>
	);
}
