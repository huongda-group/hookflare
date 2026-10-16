import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
		<div className="flex flex-wrap items-end gap-2">
			<div>
				<Label htmlFor="range-from">From</Label>
				<Input
					// Remount on URL changes (presets, clear) so the uncontrolled input follows.
					key={`from-${from ?? ""}`}
					id="range-from"
					type="datetime-local"
					defaultValue={from ? toLocalInput(from) : ""}
					onBlur={(e) => onChange({ from: fromLocalInput(e.target.value), to })}
				/>
			</div>
			<div>
				<Label htmlFor="range-to">To</Label>
				<Input
					key={`to-${to ?? ""}`}
					id="range-to"
					type="datetime-local"
					defaultValue={to ? toLocalInput(to) : ""}
					onBlur={(e) => onChange({ from, to: fromLocalInput(e.target.value) })}
				/>
			</div>
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
		</div>
	);
}
