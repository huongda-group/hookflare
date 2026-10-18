import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { JsonViewer } from "@/components/JsonViewer";
import { LoadError } from "@/components/LoadError";
import { TimeText } from "@/components/TimeText";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { ApiError } from "@/lib/api";
import { useAlert } from "@/lib/queries/alerts";
import { resourceLabel, RuleBadge } from "./AlertsPage";

export function AlertDetailPage({ alertId }: { alertId: string }) {
	const q = useAlert(alertId);
	const [showDetails, setShowDetails] = useState(false);
	if (q.error instanceof ApiError && q.error.status === 404)
		return <p>Alert {alertId} was not found.</p>;
	if (!q.data && q.isError)
		return (
			<LoadError
				what={`alert ${alertId}`}
				error={q.error}
				retrying={q.isFetching}
				onRetry={() => void q.refetch()}
			/>
		);
	if (!q.data)
		return (
			<div
				role="status"
				aria-label="Loading"
				className="space-y-3 rounded-lg border border-border bg-card p-4"
			>
				{[0, 1, 2].map((i) => (
					<div key={i} aria-hidden="true" className="flex items-center gap-4">
						<Skeleton className="h-4 w-20 shrink-0" />
						<Skeleton className="h-4 w-40 shrink-0" />
						<Skeleton className="h-4 min-w-0 flex-1" />
					</div>
				))}
			</div>
		);
	const a = q.data;
	const deadIds = Array.isArray(a.details.delivery_ids)
		? (a.details.delivery_ids as string[])
		: [];
	return (
		<div className="space-y-4">
			<div className="flex flex-wrap items-center gap-3">
				<h1 className="text-xl font-semibold">
					<RuleBadge rule={a.rule} open={a.status === "open"} />
				</h1>
				<Badge variant={a.status === "open" ? "destructive" : "secondary"}>
					{a.status}
				</Badge>
			</div>
			<dl className="grid grid-cols-[10rem_1fr] gap-y-1 text-sm">
				<dt>Resource</dt>
				<dd>
					{a.resource_type === "destination" ? (
						<Link
							to="/endpoints/destinations/$destinationId"
							params={{ destinationId: a.resource_id }}
							className="underline"
						>
							{resourceLabel(a)}
						</Link>
					) : (
						resourceLabel(a)
					)}
				</dd>
				<dt>Scope</dt>
				<dd>{a.project_id ?? "System-wide"}</dd>
				<dt>Opened</dt>
				<dd>
					<TimeText ms={a.opened_at} />
				</dd>
				<dt>Resolved</dt>
				<dd>{a.resolved_at ? <TimeText ms={a.resolved_at} /> : "—"}</dd>
			</dl>
			{deadIds.length > 0 && (
				<section>
					<h2 className="font-medium">Dead deliveries</h2>
					<p className="text-xs text-muted-foreground">
						Find each delivery in the dead-letter queue.
					</p>
					<ul className="list-disc pl-5 text-sm">
						{deadIds.map((id) => (
							<li key={id}>
								<Link
									to="/failures"
									search={{ tab: "dead" }}
									className="underline"
								>
									{id}
								</Link>
							</li>
						))}
					</ul>
				</section>
			)}
			<section>
				<h2 className="font-medium">Technical details</h2>
				<Button
					type="button"
					variant="outline"
					size="sm"
					className="mt-1"
					aria-expanded={showDetails}
					onClick={() => setShowDetails(!showDetails)}
				>
					{showDetails ? "Hide technical details" : "Show technical details"}
				</Button>
				{showDetails && (
					<div className="mt-2">
						<JsonViewer value={a.details} />
					</div>
				)}
			</section>
			<section>
				<h2 className="font-medium">Notifications</h2>
				<Table aria-label="Notifications">
					<TableHeader>
						<TableRow>
							<TableHead>Channel</TableHead>
							<TableHead>Kind</TableHead>
							<TableHead>Status</TableHead>
							<TableHead>Tries</TableHead>
							<TableHead>Error</TableHead>
							<TableHead>Created</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{a.notifications.length === 0 && (
							<TableRow>
								<TableCell
									colSpan={6}
									className="py-8 text-center text-muted-foreground"
								>
									No notifications recorded.
								</TableCell>
							</TableRow>
						)}
						{a.notifications.map((n) => (
							<TableRow key={n.id}>
								<TableCell>{n.channel_name ?? n.channel_id}</TableCell>
								<TableCell>{n.kind}</TableCell>
								<TableCell>{n.status}</TableCell>
								<TableCell>{n.tries}</TableCell>
								<TableCell>{n.last_error ?? "—"}</TableCell>
								<TableCell>
									<TimeText ms={n.created_at} />
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			</section>
		</div>
	);
}
