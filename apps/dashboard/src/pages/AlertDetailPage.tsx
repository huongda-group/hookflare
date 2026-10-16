import { Link } from "@tanstack/react-router";
import { JsonViewer } from "@/components/JsonViewer";
import { LoadError } from "@/components/LoadError";
import { TimeText } from "@/components/TimeText";
import { Badge } from "@/components/ui/badge";
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
import { resourceLabel } from "./AlertsPage";

export function AlertDetailPage({ alertId }: { alertId: string }) {
	const q = useAlert(alertId);
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
	if (!q.data) return <p className="text-neutral-500">Loading…</p>;
	const a = q.data;
	const deadIds = Array.isArray(a.details.delivery_ids)
		? (a.details.delivery_ids as string[])
		: [];
	return (
		<div className="space-y-4">
			<div className="flex items-center gap-3">
				<h1 className="text-xl font-semibold">{a.rule}</h1>
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
			<JsonViewer value={a.details} />
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
		</div>
	);
}
