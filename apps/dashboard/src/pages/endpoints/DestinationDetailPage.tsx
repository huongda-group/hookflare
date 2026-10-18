import type {
	Destination,
	RetryDefaults,
	TestDelivery,
} from "@hookflare/shared";
import { CursorTable } from "@/components/CursorTable";
import { IdText } from "@/components/IdText";
import { LoadError } from "@/components/LoadError";
import { NamedResourceLink } from "@/components/ResourceLabel";
import { StatusBadge } from "@/components/StatusBadge";
import { TimeText } from "@/components/TimeText";
import { ApiError } from "@/lib/api";
import {
	useDestination,
	useDestinationStats,
	useDestinationTests,
	useSettings,
} from "@/lib/queries/endpoints";
import { DestinationActions } from "./DestinationActions";
import {
	BackToEndpoints,
	Field,
	FieldList,
	SecretFingerprints,
	Section,
} from "./detail";

const POLICY: { key: keyof RetryDefaults; label: string; unit: string }[] = [
	{ key: "timeout_ms", label: "Timeout", unit: " ms" },
	{ key: "max_attempts", label: "Max attempts", unit: "" },
	{ key: "backoff_base_s", label: "Backoff base", unit: " s" },
	{ key: "backoff_max_s", label: "Backoff max", unit: " s" },
];

export function DestinationDetailPage({
	destinationId,
}: {
	destinationId: string;
}) {
	const destination = useDestination(destinationId);
	if (destination.error instanceof ApiError && destination.error.status === 404)
		return <p>Destination {destinationId} was not found.</p>;
	if (destination.error)
		return (
			<LoadError
				what="the destination"
				error={destination.error}
				onRetry={() => void destination.refetch()}
				retrying={destination.isFetching}
			/>
		);
	if (!destination.data)
		return <p className="p-6 text-muted-foreground">Loading…</p>;
	const d = destination.data;
	return (
		<div className="space-y-6">
			<BackToEndpoints tab="destinations" projectId={d.project_id} />
			<div className="flex items-center gap-3">
				<h1 className="text-xl font-semibold">{d.name}</h1>
				<StatusBadge status={d.status} />
				<IdText id={d.id} />
				<div className="ml-auto">
					<DestinationActions destination={d} />
				</div>
			</div>
			<Section title="Configuration">
				<FieldList>
					<Field label="URL">
						<span className="font-mono text-xs break-all">{d.url}</span>
					</Field>
					<Field label="Project">
						<NamedResourceLink
							kind="project"
							id={d.project_id}
							href={`/projects/${d.project_id}`}
						/>
					</Field>
					<Field label="Created">
						<TimeText ms={d.created_at} />
					</Field>
					<Field label="Updated">
						<TimeText ms={d.updated_at} />
					</Field>
				</FieldList>
			</Section>
			<PolicySection destination={d} />
			<Section title="Signing secret">
				<SecretFingerprints
					fingerprint={d.signing_secret_fingerprint}
					previous={d.previous_secret_fingerprint}
					previousExpiresAt={d.previous_secret_expires_at}
				/>
			</Section>
			<StatsSection destination={d} />
			<TestsSection destinationId={d.id} />
		</div>
	);
}

/** Spec §10: an empty policy field falls back to the `/settings` retry defaults. */
function PolicySection({ destination: d }: { destination: Destination }) {
	const defaults = useSettings().data?.retry_defaults;
	return (
		<Section title="Retry policy">
			<FieldList>
				{POLICY.map(({ key, label, unit }) => {
					const own = d[key];
					const fallback = defaults?.[key];
					return (
						<Field key={key} label={label}>
							{own !== null ? (
								`${own}${unit}`
							) : (
								<span className="text-muted-foreground">
									{fallback === undefined
										? "default"
										: `default: ${fallback}${unit}`}
								</span>
							)}
						</Field>
					);
				})}
			</FieldList>
		</Section>
	);
}

function StatsSection({ destination: d }: { destination: Destination }) {
	const s = useDestinationStats(d.project_id).data?.get(d.id);
	if (!s) return null;
	return (
		<Section title="Last 24 hours">
			<FieldList>
				<Field label="Success rate">
					{s.success_rate === null
						? "—"
						: `${(s.success_rate * 100).toFixed(1)}%`}
				</Field>
				<Field label="Delivered / failed">
					{s.delivered} / {s.failed}
				</Field>
				<Field label="Last delivery">
					<TimeText ms={s.last_delivery_at} />
				</Field>
				<Field label="Last error">
					{s.last_http_status
						? `HTTP ${s.last_http_status}`
						: (s.last_error ?? "—")}
				</Field>
			</FieldList>
		</Section>
	);
}

function TestsSection({ destinationId }: { destinationId: string }) {
	const query = useDestinationTests(destinationId);
	return (
		<Section title="Test deliveries">
			<CursorTable<TestDelivery>
				query={query}
				rowKey={(t) => t.id}
				empty="No test deliveries yet."
				columns={[
					{ header: "Sent", cell: (t) => <TimeText ms={t.started_at} /> },
					{ header: "By", cell: (t) => t.actor },
					{
						header: "Result",
						cell: (t) =>
							t.http_status !== null
								? `HTTP ${t.http_status}`
								: (t.error_kind ?? "—"),
					},
					{ header: "Duration", cell: (t) => `${t.duration_ms} ms` },
					{
						header: "Error",
						cell: (t) => t.error_message ?? "",
					},
					{
						header: "Response",
						cell: (t) =>
							t.response_snippet ? (
								<span className="line-clamp-2 font-mono text-xs break-all">
									{t.response_snippet}
								</span>
							) : (
								""
							),
					},
				]}
			/>
		</Section>
	);
}
