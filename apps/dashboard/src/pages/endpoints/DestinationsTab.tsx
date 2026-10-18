import type { Destination } from "@hookflare/shared";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { CursorTable } from "@/components/CursorTable";
import { DestinationFormDialog } from "@/components/DestinationFormDialog";
import { NamedResourceLink } from "@/components/ResourceLabel";
import { SecretRevealDialog } from "@/components/SecretRevealDialog";
import { StatusBadge } from "@/components/StatusBadge";
import { TimeText } from "@/components/TimeText";
import { Button } from "@/components/ui/button";
import { Can } from "@/lib/permissions";
import {
	useDestinationStats,
	useDestinationsPage,
} from "@/lib/queries/endpoints";
import { DestinationActions } from "./DestinationActions";

export function DestinationsTab({ projectId }: { projectId?: string }) {
	const query = useDestinationsPage({ project_id: projectId });
	const stats = useDestinationStats(projectId).data;
	const navigate = useNavigate();
	const [creating, setCreating] = useState(false);
	const [secret, setSecret] = useState<string | null>(null);
	return (
		<div className="space-y-3">
			<div className="flex justify-end">
				<Can permission="config.write">
					<Button onClick={() => setCreating(true)}>New destination</Button>
				</Can>
			</div>
			<CursorTable<Destination>
				query={query}
				rowKey={(d) => d.id}
				empty="No destinations yet."
				emptyAction={
					<Can permission="config.write">
						<Button onClick={() => setCreating(true)}>New destination</Button>
					</Can>
				}
				onRowClick={(d) =>
					void navigate({
						to: "/endpoints/destinations/$destinationId",
						params: { destinationId: d.id },
					})
				}
				columns={[
					{
						header: "Name",
						cell: (d) => (
							<Link
								to="/endpoints/destinations/$destinationId"
								params={{ destinationId: d.id }}
								className="font-medium hover:underline"
								onClick={(e) => e.stopPropagation()}
							>
								{d.name}
							</Link>
						),
					},
					{
						header: "URL",
						cell: (d) => <span className="font-mono text-xs">{d.url}</span>,
					},
					{
						header: "Project",
						cell: (d) => (
							<NamedResourceLink
								kind="project"
								id={d.project_id}
								href={`/projects/${d.project_id}`}
							/>
						),
					},
					{ header: "Status", cell: (d) => <StatusBadge status={d.status} /> },
					{
						header: "Success (24h)",
						cell: (d) => {
							const r = stats?.get(d.id)?.success_rate;
							return r === null || r === undefined
								? "—"
								: `${(r * 100).toFixed(1)}%`;
						},
					},
					{
						header: "Last delivery",
						cell: (d) => (
							<TimeText ms={stats?.get(d.id)?.last_delivery_at ?? null} />
						),
					},
					{
						header: "Last error",
						cell: (d) => {
							const s = stats?.get(d.id);
							return s?.last_http_status
								? `HTTP ${s.last_http_status}`
								: (s?.last_error ?? "");
						},
					},
					{ header: "", cell: (d) => <DestinationActions destination={d} /> },
				]}
			/>
			<DestinationFormDialog
				open={creating}
				onOpenChange={setCreating}
				onCreated={setSecret}
			/>
			<SecretRevealDialog
				secret={secret}
				label="Signing secret"
				onClose={() => setSecret(null)}
			/>
		</div>
	);
}
