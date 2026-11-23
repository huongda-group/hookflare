import { FormField } from "@/components/FormField";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fromLocalInput, toLocalInput } from "@/lib/time";

const PRESETS = [
	{ label: "Last 1h", ms: 3_600_000 },
	{ label: "Last 24h", ms: 86_400_000 },
	{ label: "Last 7d", ms: 7 * 86_400_000 },
] as const;

type Range = { from?: number; to?: number };

/** `from`/`to` in epoch ms, bound to the URL by the caller. Presets set `from` and leave `to` open. */
export function TimeRangeFilter({
	from,
	to,
	onChange,
	now = Date.now,
}: Range & { onChange: (r: Range) => void; now?: () => number }) {
	return (
		<fieldset className="flex flex-wrap items-end gap-2">
			<legend className="sr-only">Time range</legend>
			<FormField htmlFor="range-from" label="From">
				<Input
					// Remount on URL changes (presets, clear) so the uncontrolled input follows.
					key={`from-${from ?? ""}`}
					id="range-from"
					type="datetime-local"
					defaultValue={from ? toLocalInput(from) : ""}
					onBlur={(e) => onChange({ from: fromLocalInput(e.target.value), to })}
				/>
			</FormField>
			<FormField htmlFor="range-to" label="To">
				<Input
					key={`to-${to ?? ""}`}
					id="range-to"
					type="datetime-local"
					defaultValue={to ? toLocalInput(to) : ""}
					onBlur={(e) => onChange({ from, to: fromLocalInput(e.target.value) })}
				/>
			</FormField>
			{PRESETS.map((p) => (
				<Button
					key={p.label}
					type="button"
					variant="outline"
					size="sm"
					onClick={() => onChange({ from: now() - p.ms, to: undefined })}
				>
					{p.label}
				</Button>
			))}
			{(from !== undefined || to !== undefined) && (
				<Button
					type="button"
					variant="ghost"
					size="sm"
					onClick={() => onChange({ from: undefined, to: undefined })}
				>
					Clear time range
				</Button>
			)}
		</fieldset>
	);
}
