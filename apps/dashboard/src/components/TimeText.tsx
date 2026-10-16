import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatAbsolute, formatIso, formatRelative } from "@/lib/time";

/** Relative text, with local and UTC time on hover (spec §9.4). */
export function TimeText({ ms }: { ms: number | null }) {
	if (ms === null) return <span className="text-neutral-400">—</span>;
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<time dateTime={formatIso(ms)} className="whitespace-nowrap">
					{formatRelative(ms)}
				</time>
			</TooltipTrigger>
			<TooltipContent>
				<div>{formatAbsolute(ms)}</div>
				<div className="font-mono text-xs">{formatIso(ms)}</div>
			</TooltipContent>
		</Tooltip>
	);
}
