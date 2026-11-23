import { Button } from "@/components/ui/button";
import { errorText } from "@/lib/forms";

export function LoadError({
	what,
	error,
	onRetry,
	retrying,
}: {
	what: string;
	error: unknown;
	onRetry: () => void;
	retrying?: boolean;
}) {
	return (
		<div
			role="alert"
			className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-failure-surface px-4 py-6 text-sm text-failure"
		>
			<p>
				Could not load {what} ({errorText(error)}).
			</p>
			<Button variant="outline" disabled={retrying} onClick={onRetry}>
				Retry
			</Button>
		</div>
	);
}
