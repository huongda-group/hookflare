import type { Page } from "@hookflare/shared";
import type {
	InfiniteData,
	UseInfiniteQueryResult,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { DataState } from "@/components/DataState";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { errorText } from "@/lib/forms";
import { cn } from "@/lib/utils";

export type Column<T> = {
	header: string;
	cell: (row: T) => ReactNode;
	className?: string;
};

type Props<T> = {
	query: UseInfiniteQueryResult<InfiniteData<Page<T>>>;
	columns: Column<T>[];
	rowKey: (row: T) => string;
	empty: string;
	onRowClick?: (row: T) => void;
	selection?: {
		selected: Set<string>;
		onChange: (next: Set<string>) => void;
		max: number;
	};
	/** Accessible name for the table's own focusable, horizontally scrollable region. */
	ariaLabel?: string;
	/**
	 * Makes the row's resource cell — its key — a real link, so every row has a
	 * keyboard-accessible path to the resource. An in-app path (`/…`) becomes a
	 * Router `Link`; anything else is a plain anchor. `onRowClick` may stay for
	 * pointer clicks but is never the only path (spec §7).
	 */
	getRowHref?: (row: T) => string;
	/** Optional next authorized step shown with the empty message. */
	emptyAction?: ReactNode;
};

/** Cursor lists only: "Load more", never page numbers (spec §7). */
export function CursorTable<T>({
	query,
	columns,
	rowKey,
	empty,
	onRowClick,
	selection,
	ariaLabel = "Results",
	getRowHref,
	emptyAction,
}: Props<T>) {
	const rows = query.data?.pages.flatMap((p) => p.data) ?? [];
	const hasLoaded = query.data !== undefined;
	// Three distinct failure modes (spec §7): a failed next page keeps the
	// loaded rows and retries only that page; a failed background refresh keeps
	// the loaded rows with a warning; only a failure with nothing loaded is a
	// fatal load error. Loaded pages are never replaced on an error.
	const nextPageError = query.isFetchNextPageError && hasLoaded;
	const error = query.isError && !nextPageError ? query.error : null;

	const selectLoaded = () => {
		if (!selection) return;
		const next = new Set<string>();
		for (const row of rows) {
			if (next.size >= selection.max) break;
			next.add(rowKey(row));
		}
		selection.onChange(next);
	};

	const toggle = (id: string) => {
		if (!selection) return;
		const next = new Set(selection.selected);
		if (next.has(id)) next.delete(id);
		else if (next.size < selection.max) next.add(id);
		selection.onChange(next);
	};

	const colCount =
		columns.length + (selection ? 1 : 0) + (getRowHref ? 1 : 0);

	return (
		<DataState
			pending={query.isPending}
			error={error}
			hasData={hasLoaded}
			retrying={query.isRefetching}
			onRetry={() => void query.refetch()}
		>
			<div className="space-y-3">
				{selection ? (
					<div className="flex flex-wrap items-center gap-2">
						<Button
							variant="outline"
							size="sm"
							disabled={rows.length === 0}
							onClick={selectLoaded}
						>
							Select loaded
						</Button>
					</div>
				) : null}
				<div
					role="region"
					aria-label={ariaLabel}
					tabIndex={0}
					className="overflow-x-auto rounded-lg border border-border bg-card focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
				>
					<Table>
						<TableHeader>
							<TableRow>
								{getRowHref && <TableHead className="w-0">Resource</TableHead>}
								{selection && <TableHead className="w-8" />}
								{columns.map((c) => (
									<TableHead key={c.header} className={c.className}>
										{c.header}
									</TableHead>
								))}
							</TableRow>
						</TableHeader>
						<TableBody>
							{rows.length === 0 && (
								<TableRow>
									<TableCell
										colSpan={colCount}
										className="py-8 text-center text-muted-foreground"
									>
										<p>{empty}</p>
										{emptyAction ? (
											<div className="mt-2 flex flex-wrap justify-center gap-2">
												{emptyAction}
											</div>
										) : null}
									</TableCell>
								</TableRow>
							)}
							{rows.map((row) => {
								const id = rowKey(row);
								return (
									<TableRow
										key={id}
										className={onRowClick ? "cursor-pointer" : undefined}
										onClick={onRowClick ? () => onRowClick(row) : undefined}
									>
										{getRowHref && (
											<TableCell
												// A pointer click on the link navigates through the
												// link, not the row handler, so it never double-fires.
												onClick={(e) => e.stopPropagation()}
											>
												<ResourceLink href={getRowHref(row)}>
													{id}
												</ResourceLink>
											</TableCell>
										)}
										{selection && (
											<TableCell onClick={(e) => e.stopPropagation()}>
												<Checkbox
													aria-label={`Select ${id}`}
													checked={selection.selected.has(id)}
													onCheckedChange={() => toggle(id)}
												/>
											</TableCell>
										)}
										{columns.map((c) => (
											<TableCell key={c.header} className={c.className}>
												{c.cell(row)}
											</TableCell>
										))}
									</TableRow>
								);
							})}
						</TableBody>
					</Table>
				</div>
				{nextPageError ? (
					<div
						role="status"
						className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-warning-surface px-4 py-3 text-sm text-warning"
					>
						<p>
							Could not load more rows ({errorText(query.error)}). Loaded rows
							are still shown.
						</p>
						<Button
							variant="outline"
							disabled={query.isFetchingNextPage}
							onClick={() => void query.fetchNextPage()}
						>
							{query.isFetchingNextPage ? "Loading…" : "Retry loading more"}
						</Button>
					</div>
				) : query.hasNextPage ? (
					<div className="flex justify-center">
						<Button
							variant="outline"
							disabled={query.isFetchingNextPage}
							onClick={() => void query.fetchNextPage()}
						>
							{query.isFetchingNextPage ? "Loading…" : "Load more"}
						</Button>
					</div>
				) : null}
			</div>
		</DataState>
	);
}

/** A row's resource link: Router `Link` for in-app paths, a plain anchor otherwise. */
function ResourceLink({
	href,
	children,
}: {
	href: string;
	children: ReactNode;
}) {
	const className = cn(
		"font-mono text-xs text-action underline underline-offset-2",
	);
	if (href.startsWith("/")) {
		return (
			<Link to={href} className={className}>
				{children}
			</Link>
		);
	}
	return (
		<a href={href} className={className}>
			{children}
		</a>
	);
}
