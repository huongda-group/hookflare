import { Copy } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

/**
 * A copyable identifier. The value is always on screen and selectable, so the
 * identifier stays usable without the clipboard API (spec §7: a rejected
 * clipboard write produces an actionable explanation, never a false “Copied”).
 */
export function IdText({
	id,
	className,
}: {
	id: string;
	className?: string;
}) {
	const [copyFailed, setCopyFailed] = useState(false);

	async function copy() {
		try {
			const clipboard = navigator.clipboard;
			if (!clipboard || typeof clipboard.writeText !== "function") {
				throw new Error("clipboard_unavailable");
			}
			await clipboard.writeText(id);
			setCopyFailed(false);
			toast.success("Copied");
		} catch {
			setCopyFailed(true);
			toast.error("Could not copy automatically.");
		}
	}

	return (
		<span
			className={cn(
				"inline-flex max-w-full flex-wrap items-center gap-x-1 font-mono text-xs",
				className,
			)}
		>
			<span className="select-all break-all">{id}</span>
			<button
				type="button"
				aria-label={`Copy ${id}`}
				className="shrink-0 rounded-sm p-0.5 text-muted-foreground transition-colors duration-150 hover:text-action focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
				onClick={(event) => {
					event.stopPropagation();
					void copy();
				}}
			>
				<Copy aria-hidden="true" className="size-3.5" />
			</button>
			{copyFailed && (
				<span
					role="alert"
					className="basis-full font-sans text-xs leading-snug text-failure"
				>
					Could not copy automatically. Select the ID and copy it manually.
				</span>
			)}
		</span>
	);
}
