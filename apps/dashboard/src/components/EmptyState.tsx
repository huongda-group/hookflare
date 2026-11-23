import { Inbox } from "lucide-react";
import type { JSX, ReactNode } from "react";
import { cn } from "@/lib/utils";

export function EmptyState({
	title,
	description,
	action,
	icon,
	className,
}: {
	title: ReactNode;
	description: ReactNode;
	action?: ReactNode;
	icon?: ReactNode;
	className?: string;
}): JSX.Element {
	return (
		<div
			className={cn(
				"flex flex-col items-center gap-3 rounded-lg border border-border bg-card px-6 py-10 text-center",
				className,
			)}
		>
			<span
				aria-hidden="true"
				className="grid size-10 place-items-center rounded-full bg-secondary text-muted-foreground"
			>
				{icon ?? <Inbox className="size-5" />}
			</span>
			<p className="text-[15px] font-medium text-foreground">{title}</p>
			<p className="max-w-prose text-sm text-muted-foreground">{description}</p>
			{action ? (
				<div className="mt-1 flex flex-wrap justify-center gap-2">{action}</div>
			) : null}
		</div>
	);
}
