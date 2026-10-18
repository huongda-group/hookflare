import type { JSX, ReactNode } from "react";
import { LoadError } from "@/components/LoadError";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { errorText } from "@/lib/forms";

/**
 * The three recoverable data states in one place (spec §7):
 *
 * - initial loading: a geometry-stable skeleton with an accessible status and
 *   no placeholder values, so the layout does not jump when data arrives;
 * - initial failure: a human-readable panel with Retry, never an empty/success
 *   state, because nothing loaded;
 * - failed background refresh (`error` with `hasData`): the loaded `children`
 *   stay on screen with a non-destructive warning and Retry — stale data is
 *   never replaced by an error panel.
 *
 * `onRetry` is only wired to a failure state; a healthy table never calls it.
 */
export function DataState({
	pending,
	error,
	hasData,
	retrying,
	onRetry,
	children,
}: {
	pending: boolean;
	error: unknown;
	hasData: boolean;
	retrying: boolean;
	onRetry: () => void;
	children: ReactNode;
}): JSX.Element {
	if (pending) return <DataSkeleton />;
	if (error && !hasData)
		return <LoadError what="this list" error={error} onRetry={onRetry} retrying={retrying} />;
	return (
		<div className="space-y-3">
			{error ? (
				<div
					role="status"
					className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-warning-surface px-4 py-3 text-sm text-warning"
				>
					<p>
						Could not refresh ({errorText(error)}). Showing the last loaded
						data.
					</p>
					<Button variant="outline" disabled={retrying} onClick={onRetry}>
						Retry
					</Button>
				</div>
			) : null}
			{children}
		</div>
	);
}

/**
 * Table/page geometry at rest: fixed-height bars in the shape of rows, with an
 * accessible "Loading" status and no invented identifiers or counts.
 */
function DataSkeleton(): JSX.Element {
	return (
		<div
			role="status"
			aria-label="Loading"
			className="space-y-3 rounded-lg border border-border bg-card p-4"
		>
			{[0, 1, 2, 3, 4, 5].map((i) => (
				<div key={i} aria-hidden="true" className="flex items-center gap-4">
					<Skeleton className="h-4 w-20 shrink-0" />
					<Skeleton className="h-4 w-40 shrink-0" />
					<Skeleton className="h-4 min-w-0 flex-1" />
					<Skeleton className="h-4 w-16 shrink-0" />
				</div>
			))}
		</div>
	);
}
