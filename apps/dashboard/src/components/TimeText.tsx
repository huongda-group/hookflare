import { useId, useState } from "react";
import { formatAbsolute, formatIso, formatRelative } from "@/lib/time";
import { cn } from "@/lib/utils";

export function TimeText({
	ms,
	className,
}: {
	ms: number | null;
	className?: string;
}) {
	const [open, setOpen] = useState(false);
	const detailId = useId();

	if (ms === null)
		return <span className={cn("text-muted-foreground", className)}>—</span>;

	const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
	const utc = new Date(ms).toLocaleString("en-GB", {
		dateStyle: "medium",
		timeStyle: "medium",
		timeZone: "UTC",
	});

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: hover mirrors the inner button's focus/click handlers
		<span
			className={cn("inline-flex flex-wrap items-center gap-x-1", className)}
			onMouseEnter={() => setOpen(true)}
			onMouseLeave={() => setOpen(false)}
		>
			<button
				type="button"
				aria-expanded={open}
				aria-describedby={open ? detailId : undefined}
				className="rounded-sm underline decoration-border decoration-dotted underline-offset-2 transition-colors duration-150 hover:text-action focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
				onClick={() => setOpen(true)}
				onFocus={() => setOpen(true)}
				onBlur={() => setOpen(false)}
			>
				<time dateTime={formatIso(ms)} className="whitespace-nowrap">
					{formatRelative(ms)}
				</time>
			</button>
			{open && (
				<span
					id={detailId}
					className="w-full text-left text-xs leading-snug text-muted-foreground"
				>
					<span className="block">
						Local ({timeZone}): {formatAbsolute(ms)}
					</span>
					<span className="block font-mono">UTC: {utc}</span>
				</span>
			)}
		</span>
	);
}
