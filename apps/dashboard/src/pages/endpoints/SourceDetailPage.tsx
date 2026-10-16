import type { Source } from "@hookflare/shared";
import { Link } from "@tanstack/react-router";
import { IdText } from "@/components/IdText";
import { LoadError } from "@/components/LoadError";
import { StatusBadge } from "@/components/StatusBadge";
import { TimeText } from "@/components/TimeText";
import { ApiError } from "@/lib/api";
import { useSource } from "@/lib/queries/endpoints";
import {
	BackToEndpoints,
	Field,
	FieldList,
	SecretFingerprints,
	Section,
} from "./detail";
import { SourceActions } from "./SourceActions";

export function SourceDetailPage({ sourceId }: { sourceId: string }) {
	const source = useSource(sourceId);
	if (source.error instanceof ApiError && source.error.status === 404)
		return <p>Source {sourceId} was not found.</p>;
	if (source.error)
		return (
			<LoadError
				what="the source"
				error={source.error}
				onRetry={() => void source.refetch()}
				retrying={source.isFetching}
			/>
		);
	if (!source.data) return <p className="text-neutral-500">Loading…</p>;
	const s = source.data;
	return (
		<div className="space-y-6">
			<BackToEndpoints tab="sources" projectId={s.project_id} />
			<div className="flex items-center gap-3">
				<h1 className="text-xl font-semibold">{s.name}</h1>
				<StatusBadge status={s.status} />
				<IdText id={s.id} />
				<div className="ml-auto">
					<SourceActions source={s} />
				</div>
			</div>
			<Section title="Configuration">
				<FieldList>
					<Field label="Ingress URL">
						<IdText id={s.ingress_url} />
					</Field>
					<Field label="Project">
						<IdText id={s.project_id} />
					</Field>
					<Field label="Target destination">
						<Link
							to="/endpoints/destinations/$destinationId"
							params={{ destinationId: s.destination_id }}
							className="font-mono text-xs underline"
						>
							{s.destination_id}
						</Link>
					</Field>
					<Field label="Max body size">
						{s.max_body_bytes === null
							? "default"
							: `${s.max_body_bytes} bytes`}
					</Field>
					<Field label="Created">
						<TimeText ms={s.created_at} />
					</Field>
					<Field label="Updated">
						<TimeText ms={s.updated_at} />
					</Field>
				</FieldList>
			</Section>
			<Section title="Authentication">
				<FieldList>
					<Field label="Auth type">{s.auth_type}</Field>
					<AuthConfigFields source={s} />
				</FieldList>
			</Section>
			<Section title="Provider event ID">
				<FieldList>
					<Field label="Extract from">{s.event_id_from}</Field>
					{s.event_id_selector && (
						<Field label="Selector">
							<span className="font-mono text-xs">{s.event_id_selector}</span>
						</Field>
					)}
				</FieldList>
			</Section>
			{s.auth_type !== "none" && (
				<Section title="Secret">
					<SecretFingerprints
						fingerprint={s.secret_fingerprint}
						previous={s.previous_secret_fingerprint}
						previousExpiresAt={s.previous_secret_expires_at}
					/>
				</Section>
			)}
		</div>
	);
}

const AUTH_LABELS: Record<string, string> = {
	header: "Header",
	algorithm: "Algorithm",
	encoding: "Encoding",
	prefix: "Prefix",
	in: "Token in",
	name: "Token name",
};

function AuthConfigFields({ source: s }: { source: Source }) {
	return Object.entries(s.auth_config).map(([k, v]) => (
		<Field key={k} label={AUTH_LABELS[k] ?? k}>
			<span className="font-mono text-xs">{String(v)}</span>
		</Field>
	));
}
