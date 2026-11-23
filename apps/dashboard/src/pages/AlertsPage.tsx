import { ALERT_RULES, type Alert } from "@hookflare/shared";
import { Link } from "@tanstack/react-router";
import { z } from "zod";
import { type Column, CursorTable } from "@/components/CursorTable";
import { PageHeader } from "@/components/PageHeader";
import { StatusBadge } from "@/components/StatusBadge";
import { TimeText } from "@/components/TimeText";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { type AlertScope, useAlertsPage } from "@/lib/queries/alerts";
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

const KNOWN_RULES: readonly string[] = ALERT_RULES;

/**
 * A rule badge that survives a newer server: known rules render as-is, an
 * unknown rule string renders its raw value in a neutral badge with an
 * explicit "Unknown rule" note instead of breaking the row or the filter.
 */
export function RuleBadge({ rule, open }: { rule: string; open: boolean }) {
	if ((KNOWN_RULES as readonly string[]).includes(rule)) {
		return <Badge variant={open ? "destructive" : "secondary"}>{rule}</Badge>;
	}
	return (
		<span className="inline-flex flex-wrap items-center gap-2">
			<StatusBadge status={rule} />
			<span className="text-xs text-muted-foreground">
				Unknown rule: {rule}
			</span>
		</span>
	);
}

const columns = (scope: AlertScope): Column<Alert>[] => [
	{
		header: "Rule",
		cell: (a) => <RuleBadge rule={a.rule} open={a.status === "open"} />,
	},
	{
		header: "Resource",
		cell: (a) => (
			<Link
				to="/alerts/$alertId"
				params={{ alertId: a.id }}
				search={scope}
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
	projectId,
	search,
	setSearch,
}: {
	projectId: string;
	search: AlertsSearch;
	setSearch: (s: Partial<AlertsSearch>) => void;
}) {
	const { status, rule } = search;
	const filters = { rule, status: status === "all" ? undefined : status };
	const projectScope = { project_id: projectId };
	const deploymentScope = { scope: "deployment" } as const;
	const projectQuery = useAlertsPage({ ...filters, ...projectScope });
	const deploymentQuery = useAlertsPage({ ...filters, ...deploymentScope });
	return (
		<div className="space-y-4">
			<PageHeader
				title="Alerts"
				description="Incidents raised by delivery, storage, and backup rules. An alert resolves when its underlying cause clears — there is nothing to acknowledge here."
			>
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
				</div>
			</PageHeader>
			<section aria-labelledby="project-incidents" className="space-y-2">
				<h2 id="project-incidents" className="font-semibold">
					Project incidents
				</h2>
				<CursorTable
					query={projectQuery}
					columns={columns(projectScope)}
					rowKey={(a) => a.id}
					empty="No project alerts match these filters."
					emptyAction={
						rule && (
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => setSearch({ rule: undefined })}
							>
								Clear filter
							</Button>
						)
					}
				/>
			</section>
			<section aria-labelledby="deployment-incidents" className="space-y-2">
				<h2 id="deployment-incidents" className="font-semibold">
					Deployment incidents
				</h2>
				<p className="text-sm text-muted-foreground">
					These incidents are shared across all projects.
				</p>
				<CursorTable
					query={deploymentQuery}
					columns={columns(deploymentScope)}
					rowKey={(a) => a.id}
					empty="No deployment alerts match these filters."
				/>
			</section>
		</div>
	);
}
