import type { Delivery, WebhookEvent } from "@hookflare/shared";
import { useDestination, useSource } from "@/lib/queries/endpoints";
import { StatusBadge } from "./StatusBadge";

export function SourceName({ id }: { id: string }) {
	const { data } = useSource(id);
	return (
		<span title={id} className="break-all">
			{data?.name ?? id}
		</span>
	);
}

function DestinationName({ id }: { id: string }) {
	const { data } = useDestination(id);
	return (
		<span title={id} className="break-all">
			{data?.name ?? id}
		</span>
	);
}

export function EventDeliveryContext({
	event,
	delivery,
}: {
	event: WebhookEvent;
	delivery: Delivery | null;
}) {
	return (
		<section
			aria-label="Event delivery context"
			className="grid gap-3 rounded-lg border bg-card p-5 text-sm sm:grid-cols-[1fr_auto_1fr_auto_1fr] sm:items-center"
		>
			<div>
				<span className="block text-xs text-muted-foreground">Source</span>
				{event.source_id ? (
					<SourceName id={event.source_id} />
				) : (
					"Unknown source"
				)}
			</div>
			<span
				aria-hidden="true"
				className="hidden text-muted-foreground sm:block"
			>
				→
			</span>
			<div>
				<span className="block text-xs text-muted-foreground">
					Selected destination
				</span>
				{delivery?.destination_id ? (
					<DestinationName id={delivery.destination_id} />
				) : (
					"No delivery destination"
				)}
			</div>
			<span
				aria-hidden="true"
				className="hidden text-muted-foreground sm:block"
			>
				→
			</span>
			<div>
				<span className="block text-xs text-muted-foreground">
					Selected delivery outcome
				</span>
				{delivery ? (
					<StatusBadge status={delivery.status} />
				) : (
					"No deliveries yet"
				)}
			</div>
		</section>
	);
}
