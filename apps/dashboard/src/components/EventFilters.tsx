import { DELIVERY_STATUS_VALUES } from "@hookflare/shared";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ResourcePicker } from "@/components/ResourcePicker";
import { TimeRangeFilter } from "@/components/TimeRangeFilter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { EventsSearch } from "@/pages/EventsPage";
import { cn } from "@/lib/utils";

/**
 * Committed filters stay in URL state; the text draft inside is local only and
 * never becomes query state. Typing fires no request: values reach the URL
 * (and the API) only through Apply, the search submit, or an immediate
 * committed selection (named pickers, status toggles). Desktop applies
 * committed selections and submitted text, not each keystroke or accidental
 * blur (spec §7).
 */
export function EventFilters({
	value,
	onApply,
}: {
	value: EventsSearch;
	onApply: (patch: Partial<EventsSearch>) => void;
}) {
	const navigate = useNavigate();
	const [provider, setProvider] = useState(value.provider_event_id ?? "");
	const [httpText, setHttpText] = useState(value.http_status?.toString() ?? "");
	const [from, setFrom] = useState<number | undefined>(value.from);
	const [to, setTo] = useState<number | undefined>(value.to);
	const [hint, setHint] = useState<string | null>(null);
	const [httpError, setHttpError] = useState<string | null>(null);

	// Follow committed URL values without remounting: each draft syncs only
	// from its own committed field. Unrelated commits (e.g. a status toggle)
	// leave in-progress text/time drafts alone, while Back/Forward navigation
	// to a different committed value refreshes the matching draft.
	useEffect(() => {
		setProvider(value.provider_event_id ?? "");
	}, [value.provider_event_id]);
	useEffect(() => {
		setHttpText(value.http_status?.toString() ?? "");
		setHttpError(null);
	}, [value.http_status]);
	useEffect(() => {
		setFrom(value.from);
	}, [value.from]);
	useEffect(() => {
		setTo(value.to);
	}, [value.to]);
	useEffect(() => {
		setHint(null);
	}, [value.source_id]);

	const commit = () => {
		const v = provider.trim();
		setHint(null);
		if (v.startsWith("evt_")) {
			void navigate({ to: "/events/$eventId", params: { eventId: v } });
			return;
		}
		if (v && !value.source_id) {
			setHint(
				"Choose a source (Source filter) to search by provider event ID.",
			);
			return;
		}
		const raw = httpText.trim();
		if (!raw) {
			setHttpError(null);
			onApply({
				provider_event_id: v || undefined,
				http_status: undefined,
				from,
				to,
			});
			return;
		}
		const n = Number(raw);
		if (!Number.isInteger(n) || n < 100 || n > 599) {
			setHttpError("HTTP status must be a whole number from 100 to 599.");
			return;
		}
		setHttpError(null);
		onApply({
			provider_event_id: v || undefined,
			http_status: n,
			from,
			to,
		});
	};

	const clear = () => {
		setProvider("");
		setHttpText("");
		setFrom(undefined);
		setTo(undefined);
		setHint(null);
		setHttpError(null);
		onApply({
			source_id: undefined,
			destination_id: undefined,
			status: undefined,
			http_status: undefined,
			provider_event_id: undefined,
			from: undefined,
			to: undefined,
		});
	};

	const toggleStatus = (s: (typeof DELIVERY_STATUS_VALUES)[number]) => {
		const cur = new Set(value.status ?? []);
		if (cur.has(s)) cur.delete(s);
		else cur.add(s);
		onApply({ status: cur.size ? [...cur] : undefined });
	};

	return (
		<div className="space-y-3">
			<div className="flex flex-wrap items-end gap-3">
				<div className="min-w-52 flex-1">
					<Label htmlFor="f-q">Search</Label>
					<Input
						id="f-q"
						placeholder="evt_… or provider event ID"
						value={provider}
						onChange={(e) => setProvider(e.target.value)}
						onKeyDown={(e) => e.key === "Enter" && commit()}
						aria-describedby="events-search-help"
					/>
				</div>
				<ResourcePicker
					kind="source"
					projectId={value.project_id}
					value={value.source_id}
					onChange={(source_id) => onApply({ source_id })}
					label="Source"
					allowAll
				/>
				<ResourcePicker
					kind="destination"
					projectId={value.project_id}
					value={value.destination_id}
					onChange={(destination_id) => onApply({ destination_id })}
					label="Destination"
					allowAll
				/>
			</div>
			<p id="events-search-help" className="text-xs text-muted-foreground">
				Event IDs starting with evt_ open directly. Provider event ID search
				is an exact match and needs a source selected first.
			</p>
			<fieldset className="flex flex-wrap gap-2" aria-label="Status">
				{DELIVERY_STATUS_VALUES.map((s) => (
					<button
						key={s}
						type="button"
						aria-pressed={value.status?.includes(s) ?? false}
						className={cn(
							"rounded border px-2 py-0.5 text-xs",
							value.status?.includes(s)
								? "border-action bg-selected text-selected-foreground"
								: "border-border text-muted-foreground",
						)}
						onClick={() => toggleStatus(s)}
					>
						{s.replace("_", " ")}
					</button>
				))}
			</fieldset>
			<div className="flex flex-wrap items-end gap-3">
				<div>
					<Label htmlFor="f-http">HTTP status</Label>
					<Input
						id="f-http"
						type="number"
						className="w-28"
						value={httpText}
						onChange={(e) => setHttpText(e.target.value)}
						onKeyDown={(e) => e.key === "Enter" && commit()}
						aria-invalid={httpError ? true : undefined}
						aria-describedby={httpError ? "f-http-error" : undefined}
					/>
				</div>
				<TimeRangeFilter
					from={from}
					to={to}
					onChange={(r) => {
						setFrom(r.from);
						setTo(r.to);
					}}
				/>
			</div>
			{httpError && (
				<p id="f-http-error" role="alert" className="text-sm text-failure">
					{httpError}
				</p>
			)}
			{hint && (
				<p className="text-sm text-warning">{hint}</p>
			)}
			<div className="flex flex-wrap gap-2">
				<Button type="button" onClick={commit}>
					Apply filters
				</Button>
				<Button type="button" variant="outline" onClick={clear}>
					Clear filters
				</Button>
			</div>
		</div>
	);
}
