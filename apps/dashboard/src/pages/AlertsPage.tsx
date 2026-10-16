import { ALERT_RULES, type Alert } from "@hookflare/shared";
import { Link } from "@tanstack/react-router";
import { z } from "zod";
import { type Column, CursorTable } from "@/components/CursorTable";
import { ProjectSelect } from "@/components/ProjectSelect";
import { TimeText } from "@/components/TimeText";
import { Badge } from "@/components/ui/badge";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAlertsPage } from "@/lib/queries/alerts";
import { formatDuration } from "@/lib/time";

export const alertsSearch = z.object({
	status: z.enum(["open", "resolved", "all"]).default("open").catch("open"),
	rule: z.enum(ALERT_RULES).optional().catch(undefined),
	project_id: z.string().optional().catch(undefined),
});
export type AlertsSearch = z.infer<typeof alertsSearch>;

export function resourceLabel(a: Alert): string {
	return a.resource_type === "system"
		? `system / ${a.resource_id}`
		: (a.resource_name ?? a.resource_id);
}

const columns: Column<Alert>[] = [
	{
		header: "Rule",
		cell: (a) => (
			<Badge variant={a.status === "open" ? "destructive" : "secondary"}>
				{a.rule}
			</Badge>
		),
	},
	{
		header: "Resource",
		cell: (a) => (
			<Link
				to="/alerts/$alertId"
				params={{ alertId: a.id }}
				className="underline"
			>
				{resourceLabel(a)}
			</Link>
		),
	},
	{ header: "Opened", cell: (a) => <TimeText ms={a.opened_at} /> },
	{
		header: "Duration",
		cell: (a) => formatDuration((a.resolved_at ?? Date.now()) - a.opened_at),
	},
];

const RULE_ALL = "__all_rules";

export function AlertsPage({
	search,
	setSearch,
}: {
	search: AlertsSearch;
	setSearch: (s: Partial<AlertsSearch>) => void;
}) {
	const { status, ...rest } = search;
	const query = useAlertsPage({
		...rest,
		...(status === "all" ? {} : { status }),
	});
	return (
		<div className="space-y-4">
			<h1 className="text-xl font-semibold">Alerts</h1>
			<div className="flex flex-wrap items-center gap-3">
				<Tabs
					value={status}
					onValueChange={(v) =>
						setSearch({ status: v as AlertsSearch["status"] })
					}
				>
					<TabsList>
						<TabsTrigger value="open">Open</TabsTrigger>
						<TabsTrigger value="resolved">Resolved</TabsTrigger>
						<TabsTrigger value="all">All</TabsTrigger>
					</TabsList>
				</Tabs>
				<Select
					value={search.rule ?? RULE_ALL}
					onValueChange={(v) =>
						setSearch({
							rule: v === RULE_ALL ? undefined : (v as AlertsSearch["rule"]),
						})
					}
				>
					<SelectTrigger className="w-56" aria-label="Rule">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value={RULE_ALL}>All rules</SelectItem>
						{ALERT_RULES.map((r) => (
							<SelectItem key={r} value={r}>
								{r}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<ProjectSelect
					value={search.project_id}
					onChange={(project_id) => setSearch({ project_id })}
				/>
			</div>
			<CursorTable
				query={query}
				columns={columns}
				rowKey={(a) => a.id}
				empty="No alerts."
			/>
		</div>
	);
}
