import type { JSX, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A titled group inside a form or detail panel (spec §7: creation/edit forms
 * use consistent sections). The title is the section heading, so pages keep a
 * single `<h1>` from `PageHeader` and a heading level per section.
 */
export function FormSection({
	title,
	description,
	children,
	className,
}: {
	title: ReactNode;
	description?: ReactNode;
	children: ReactNode;
	className?: string;
}): JSX.Element {
	return (
		<section
			className={cn(
				"rounded-lg border border-border bg-card p-6 shadow-xs",
				className,
			)}
		>
			<div className="mb-4">
				<h2 className="text-[15px] leading-snug font-medium text-foreground">
					{title}
				</h2>
				{description ? (
					<p className="mt-1 text-sm text-muted-foreground">{description}</p>
				) : null}
			</div>
			<div className="flex flex-col gap-4">{children}</div>
		</section>
	);
}
