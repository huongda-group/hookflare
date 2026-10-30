import {
	ARCHIVE_KINDS,
	ARCHIVE_STATUSES,
	type ArchiveBatch,
	type Page,
} from "@hookflare/shared";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment, useState } from "react";
import { z } from "zod";
import { DataState } from "@/components/DataState";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { api } from "@/lib/api";
import { errorText } from "@/lib/forms";
import { Can } from "@/lib/permissions";
import { qk } from "@/lib/queries/keys";
import { formatBytes } from "@/lib/time";

export const archivesSearch = z.object({
	kind: z.enum(ARCHIVE_KINDS).optional().catch(undefined),
	status: z.enum(ARCHIVE_STATUSES).optional().catch(undefined),
});
export type ArchivesSearch = z.infer<typeof archivesSearch>;

/** Cold storage: list and download only (DEC-12). Batches are grouped by day. */
export function ArchivesPage({ search }: { search: ArchivesSearch }) {
	const [open, setOpen] = useState<string | null>(null);
	const query = useInfiniteQuery({
		queryKey: qk.archives.list(search),
		queryFn: ({ pageParam }) =>
			api.get<Page<ArchiveBatch>>("/archives", {
				...search,
				limit: 20,
				cursor: pageParam,
			}),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (last) => last.next_cursor ?? undefined,
	});
	const rows = query.data?.pages.flatMap((p) => p.data) ?? [];
	const hasLoaded = query.data !== undefined;
	// A failed next page keeps the loaded day groups and rows and retries only
	// that page; only a failure with nothing loaded is a fatal load error.
	const nextPageError = query.isFetchNextPageError && hasLoaded;
	const error = query.isError && !nextPageError ? query.error : null;
	const days = new Map<string, ArchiveBatch[]>();
	for (const b of rows) {
		const g = days.get(b.day) ?? [];
		g.push(b);
		days.set(b.day, g);
	}
	return (
		<div className="space-y-4">
			<PageHeader
				title="Archives"
				description="Cold storage: finished batches are kept for long-term retention. Archiving is list and download only."
			/>
			<p className="text-xs text-muted-foreground">
				Archives are read-only — there is no search or replay here. Find live
				data in{" "}
				<Link to="/events" className="underline">
					Events
				</Link>{" "}
				or{" "}
				<Link to="/failures" className="underline">
					Failures
				</Link>
				.
			</p>
			<DataState
				pending={query.isPending}
				error={error}
				hasData={hasLoaded}
				retrying={query.isRefetching}
				onRetry={() => void query.refetch()}
			>
				{rows.length === 0 ? (
					<div className="rounded-lg border border-border bg-card px-4 py-6 text-center text-sm text-muted-foreground">
						<p>No archive batches yet.</p>
						<p className="mt-2">
							Finished batches appear here once retention archiving runs.{" "}
							<Link to="/events" className="underline">
								View live events
							</Link>
						</p>
					</div>
				) : (
					<div
						role="region"
						aria-label="Archive batches"
						tabIndex={0}
						className="overflow-x-auto rounded-lg border border-border bg-card focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
					>
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Day</TableHead>
									<TableHead>Kind</TableHead>
									<TableHead>Status</TableHead>
									<TableHead>Items</TableHead>
									<TableHead>Size</TableHead>
									<TableHead />
								</TableRow>
							</TableHeader>
							<TableBody>
								{[...days].map(([day, batches]) => {
									const span = batches.reduce(
										(n, b) => n + 1 + (open === b.id ? b.parts.length : 0),
										0,
									);
									return (
										<Fragment key={day}>
											{batches.map((b, i) => (
												<Fragment key={b.id}>
													<TableRow>
														{i === 0 && (
															<TableCell rowSpan={span}>{day}</TableCell>
														)}
														<TableCell>{b.kind}</TableCell>
														<TableCell>
															<Badge
																variant={
																	b.status === "failed"
																		? "destructive"
																		: "secondary"
																}
															>
																{b.status}
															</Badge>
															{b.error && (
																<p className="text-xs text-failure">{b.error}</p>
															)}
														</TableCell>
														<TableCell>
															{b.item_count.toLocaleString("en-US")}
														</TableCell>
														<TableCell>
															{b.with_files ? formatBytes(b.bytes) : "no files"}
														</TableCell>
														<TableCell>
															<Button
																size="sm"
																variant="outline"
																onClick={() =>
																	setOpen(open === b.id ? null : b.id)
																}
															>
																{b.part_count} parts
															</Button>
														</TableCell>
													</TableRow>
													{open === b.id &&
														b.parts.map((p) => (
															<TableRow
																key={`${b.id}-${p.part_no}`}
																className="bg-muted"
															>
																<TableCell
																	colSpan={2}
																	className="font-mono text-xs"
																>
																	part {p.part_no}: {p.first_id} … {p.last_id}
																</TableCell>
																<TableCell>
																	{p.item_count.toLocaleString("en-US")}
																</TableCell>
																<TableCell>{formatBytes(p.bytes)}</TableCell>
																<TableCell>
																	{p.downloadable ? (
																		<Can permission="payload.read">
																			{/* Plain link (not api.ts fetch): the browser must stream the file to disk same-origin with the Access cookie. */}
																			<a
																				className="underline"
																				href={`/api/admin/v1/archives/${b.id}/parts/${p.part_no}`}
																				download
																			>
																				Download part {p.part_no}
																			</a>
																		</Can>
																	) : (
																		<span className="text-xs text-muted-foreground">
																			Download unavailable —{" "}
																			{b.with_files
																				? "this part is not downloadable"
																				: "this batch stored no files"}
																			.
																		</span>
																	)}
																</TableCell>
															</TableRow>
														))}
												</Fragment>
											))}
										</Fragment>
									);
								})}
							</TableBody>
						</Table>
					</div>
				)}
				{nextPageError ? (
					<div
						role="status"
						className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-warning-surface px-4 py-3 text-sm text-warning"
					>
						<p>
							Could not load more rows ({errorText(query.error)}). Loaded
							rows are still shown.
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
			</DataState>
		</div>
	);
}
