import type { ReactNode } from "react";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export function FormField({
	htmlFor,
	label,
	children,
	className,
	labelClassName,
}: {
	htmlFor: string;
	label: ReactNode;
	children: ReactNode;
	className?: string;
	labelClassName?: string;
}) {
	return (
		<div className={cn("grid min-w-0 content-start gap-2", className)}>
			<Label htmlFor={htmlFor} className={labelClassName}>
				{label}
			</Label>
			{children}
		</div>
	);
}
