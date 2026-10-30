import type { Overview } from "@hookflare/shared";
import { Link } from "@tanstack/react-router";

export function OverviewAttention({
	overview,
	projectId,
}: {
	overview: Overview;
	projectId?: string;
}) {
	return (
		<section
			aria-labelledby="overview-attention"
			className="overflow-hidden rounded-[10px] border border-border bg-card"
		>
			<div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/30 px-5 py-3">
				<h2 id="overview-attention" className="font-semibold">
					Needs attention
				</h2>
				<span className="text-xs text-muted-foreground">
					Historical failures and current alerts are separate signals
				</span>
			</div>
			{overview.open_alerts.count > 0 && (
				<div role="alert" className="border-b border-border px-5 py-3 text-sm">
					<Link
						to="/alerts"
						search={{
							status: "open",
							...(projectId ? { project_id: projectId } : {}),
						}}
						className="font-medium text-failure underline underline-offset-2"
					>
						{overview.open_alerts.count.toLocaleString("en-US")} open{" "}
						{overview.open_alerts.count === 1 ? "alert" : "alerts"}
					</Link>
					<span className="text-muted-foreground"> · Current alert count</span>
				</div>
			)}
			{overview.failing_destinations.length > 0 ? (
				<div className="divide-y divide-border">
					{overview.failing_destinations.map((f) => (
						<div
							key={f.destination_id}
							className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 text-sm"
						>
							<div className="min-w-0">
								<Link
									to="/failures"
									search={{
										destination_id: f.destination_id,
										...(projectId ? { project_id: projectId } : {}),
										from: overview.from,
										to: overview.to,
									}}
									className="font-semibold text-action underline-offset-2 hover:underline"
								>
									{f.name ?? f.destination_id}
								</Link>
								<p className="mt-1 text-xs text-muted-foreground">
									Failures in selected period ·{" "}
									{f.failed.toLocaleString("en-US")} failed ·{" "}
									{f.delivered.toLocaleString("en-US")} delivered
								</p>
							</div>
							<Link
								to="/failures"
								search={{
									destination_id: f.destination_id,
									...(projectId ? { project_id: projectId } : {}),
									from: overview.from,
									to: overview.to,
								}}
								aria-label={`Investigate ${f.name ?? f.destination_id}`}
								className="rounded-md border border-border px-3 py-2 text-xs font-medium hover:bg-accent"
							>
								Investigate →
							</Link>
						</div>
					))}
				</div>
			) : (
				<p className="px-5 py-4 text-sm text-muted-foreground">
					No destination failures in the selected period.{" "}
					{overview.open_alerts.count
						? "Review open alerts above."
						: "No open alerts in this snapshot."}
				</p>
			)}
		</section>
	);
}
