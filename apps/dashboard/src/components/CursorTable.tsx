import type { Page } from "@hookflare/shared";
import type {
	InfiniteData,
	UseInfiniteQueryResult,
} from "@tanstack/react-query";
import type { ReactNode } from "react";
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
import { ApiError } from "@/lib/api";

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
};

/** Cursor lists only: "Load more", never page numbers (spec §9.2). */
export function CursorTable<T>({
	query,
	columns,
	rowKey,
	empty,
	onRowClick,
	selection,
}: Props<T>) {
	const rows = query.data?.pages.flatMap((p) => p.data) ?? [];
	if (query.isPending) return <p className="py-6 text-neutral-500">Loading…</p>;
	if (query.error) {
		const msg = query.error instanceof ApiError ? query.error.code : "error";
		return <p className="py-6 text-red-700">Could not load ({msg}).</p>;
	}
	const toggle = (id: string) => {
		if (!selection) return;
		const next = new Set(selection.selected);
		if (next.has(id)) next.delete(id);
		else if (next.size < selection.max) next.add(id);
		selection.onChange(next);
	};
	return (
		<div>
			<Table>
				<TableHeader>
					<TableRow>
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
								colSpan={columns.length + (selection ? 1 : 0)}
								className="py-8 text-center text-neutral-500"
							>
								{empty}
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
			{query.hasNextPage && (
				<div className="mt-3 flex justify-center">
					<Button
						variant="outline"
						disabled={query.isFetchingNextPage}
						onClick={() => void query.fetchNextPage()}
					>
						{query.isFetchingNextPage ? "Loading…" : "Load more"}
					</Button>
				</div>
			)}
		</div>
	);
}
