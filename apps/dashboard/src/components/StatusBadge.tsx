import {
	Ban,
	CircleCheck,
	CircleDashed,
	CircleX,
	Clock,
	ListOrdered,
	LoaderCircle,
	type LucideIcon,
	OctagonX,
	Pause,
	RotateCw,
} from "lucide-react";
import { cn } from "@/lib/utils";

type StatusMeta = {
	label: string;
	icon: LucideIcon;
	surface: string;
};

const STATUS: Record<string, StatusMeta> = {
	pending: {
		label: "Pending",
		icon: Clock,
		surface: "bg-secondary text-foreground",
	},
	queued: {
		label: "Queued",
		icon: ListOrdered,
		surface: "bg-secondary text-foreground",
	},
	in_flight: {
		label: "In flight",
		icon: LoaderCircle,
		surface: "bg-info-surface text-info",
	},
	retrying: {
		label: "Retrying",
		icon: RotateCw,
		surface: "bg-warning-surface text-warning",
	},
	paused: {
		label: "Paused",
		icon: Pause,
		surface: "bg-secondary text-foreground",
	},
	delivered: {
		label: "Delivered",
		icon: CircleCheck,
		surface: "bg-success-surface text-success",
	},
	failed_final: {
		label: "Failed final",
		icon: CircleX,
		surface: "bg-failure-surface text-failure",
	},
	dead: {
		label: "Dead letter",
		icon: OctagonX,
		surface: "bg-failure-surface text-failure",
	},
	active: {
		label: "Active",
		icon: CircleCheck,
		surface: "bg-success-surface text-success",
	},
	disabled: {
		label: "Disabled",
		icon: Ban,
		surface: "bg-secondary text-muted-foreground",
	},
};

function humanize(status: string) {
	const words = status.replaceAll("_", " ").trim();
	return words ? words[0].toUpperCase() + words.slice(1) : "Unknown";
}

export function StatusBadge({
	status,
	className,
}: {
	status: string;
	className?: string;
}) {
	const meta = STATUS[status];
	const Icon = meta?.icon ?? CircleDashed;
	return (
		<span
			data-status={status}
			className={cn(
				"inline-flex max-w-full items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium whitespace-nowrap",
				meta?.surface ?? "bg-secondary text-foreground",
				className,
			)}
		>
			<Icon aria-hidden="true" className="size-3.5 shrink-0" />
			{meta?.label ?? humanize(status)}
		</span>
	);
}
