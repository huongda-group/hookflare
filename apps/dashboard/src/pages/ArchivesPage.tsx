import {
	ARCHIVE_KINDS,
	ARCHIVE_STATUSES,
	type ArchiveBatch,
	type Page,
} from "@hookflare/shared";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { z } from "zod";
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
	const days = new Map<string, ArchiveBatch[]>();
	for (const b of rows) {
		const g = days.get(b.day) ?? [];
		g.push(b);
		days.set(b.day, g);
	}
	return (
		<div className="space-y-4">
			<h1 className="text-xl font-semibold">Archives</h1>
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
											{i === 0 && <TableCell rowSpan={span}>{day}</TableCell>}
											<TableCell>{b.kind}</TableCell>
											<TableCell>
												<Badge
													variant={
														b.status === "failed" ? "destructive" : "secondary"
													}
												>
													{b.status}
												</Badge>
												{b.error && (
													<p className="text-xs text-red-700">{b.error}</p>
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
													onClick={() => setOpen(open === b.id ? null : b.id)}
												>
													{b.part_count} parts
												</Button>
											</TableCell>
										</TableRow>
										{open === b.id &&
											b.parts.map((p) => (
												<TableRow
													key={`${b.id}-${p.part_no}`}
													className="bg-neutral-50"
												>
													<TableCell colSpan={2} className="font-mono text-xs">
														part {p.part_no}: {p.first_id} … {p.last_id}
													</TableCell>
													<TableCell>
														{p.item_count.toLocaleString("en-US")}
													</TableCell>
													<TableCell>{formatBytes(p.bytes)}</TableCell>
													<TableCell>
														{p.downloadable && (
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
			{query.hasNextPage && (
				<Button variant="outline" onClick={() => query.fetchNextPage()}>
					Load more
				</Button>
			)}
		</div>
	);
}
