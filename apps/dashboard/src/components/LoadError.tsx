import { Button } from "@/components/ui/button";
import { errorText } from "@/lib/forms";

/** A failed load: the error code and a Retry that refetches (instead of "Loading…" forever). */
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
		<div role="status" className="space-y-2 p-6">
			<p className="text-red-700">
				Could not load {what} ({errorText(error)}).
			</p>
			<Button variant="outline" disabled={retrying} onClick={onRetry}>
				Retry
			</Button>
		</div>
	);
}
