import { cn } from "@/lib/utils";

/** One color per delivery status, everywhere (spec §9.4). */
const COLORS: Record<string, string> = {
	pending: "bg-neutral-100 text-neutral-700",
	queued: "bg-neutral-100 text-neutral-700",
	in_flight: "bg-blue-100 text-blue-800",
	retrying: "bg-amber-100 text-amber-800",
	paused: "bg-purple-100 text-purple-800",
	delivered: "bg-green-100 text-green-800",
	failed_final: "bg-red-100 text-red-800",
	dead: "bg-red-200 text-red-900",
	active: "bg-green-100 text-green-800",
	disabled: "bg-neutral-200 text-neutral-700",
};

export function StatusBadge({ status }: { status: string }) {
	return (
		<span
			className={cn(
				"inline-block rounded px-2 py-0.5 text-xs font-medium",
				COLORS[status] ?? "bg-neutral-100",
			)}
		>
			{status.replace("_", " ")}
		</span>
	);
}
