import { Copy } from "lucide-react";
import { toast } from "sonner";

export function IdText({ id }: { id: string }) {
	return (
		<span className="inline-flex items-center gap-1 font-mono text-xs">
			{id}
			<button
				type="button"
				aria-label={`Copy ${id}`}
				className="text-neutral-400 hover:text-neutral-700"
				onClick={(e) => {
					e.stopPropagation();
					void navigator.clipboard
						?.writeText(id)
						.then(() => toast.success("Copied"));
				}}
			>
				<Copy className="size-3" />
			</button>
		</span>
	);
}
