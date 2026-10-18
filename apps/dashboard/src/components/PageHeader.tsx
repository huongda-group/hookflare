import type { JSX, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The single page-level heading for a screen: one `<h1>`, an optional
 * description, page-level actions, and a slot for page-local controls
 * (filters, tabs, project pickers). Spec §5 typography: 26–28px titles.
 */
export function PageHeader({
	title,
	description,
	actions,
	children,
	className,
}: {
	title: ReactNode;
	description?: ReactNode;
	actions?: ReactNode;
	children?: ReactNode;
	className?: string;
}): JSX.Element {
	return (
		<header className={cn("flex flex-col gap-4", className)}>
			<div className="flex flex-wrap items-start justify-between gap-4">
				<div className="min-w-0">
					<h1 className="text-[26px] leading-tight font-semibold tracking-tight text-foreground sm:text-[28px]">
						{title}
					</h1>
					{description ? (
						<p className="mt-1 max-w-prose text-sm text-muted-foreground">
							{description}
						</p>
					) : null}
				</div>
				{actions ? (
					<div className="flex flex-wrap items-center gap-2">{actions}</div>
				) : null}
			</div>
			{children ? <div className="flex flex-col gap-4">{children}</div> : null}
		</header>
	);
}
