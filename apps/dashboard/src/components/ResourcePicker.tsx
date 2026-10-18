import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorText } from "@/lib/forms";
import {
	type ResourceKind,
	type ResourceOption,
	useResourceOptions,
} from "@/lib/queries/resource-options";
import { cn } from "@/lib/utils";

const ALL_LABEL: Record<ResourceKind, string> = {
	project: "All projects",
	source: "All sources",
	destination: "All destinations",
};

const PLACEHOLDER: Record<ResourceKind, string> = {
	project: "Select project",
	source: "Select source",
	destination: "Select destination",
};

export type ResourcePickerProps = {
	kind: ResourceKind;
	projectId?: string;
	value?: string;
	onChange: (id: string | undefined) => void;
	label: string;
	allowAll?: boolean;
};

/**
 * A cursor-aware named-resource combobox (spec §7). Radix `Select` cannot
 * paginate, so this is a small accessible combobox: a labelled search input
 * that filters the *loaded* options only, a listbox of loaded options, an
 * explicit **Load more**, and an exact-ID escape hatch. It never fetches a
 * page per option and never fetches every page eagerly.
 */
export function ResourcePicker({
	kind,
	projectId,
	value,
	onChange,
	label,
	allowAll,
}: ResourcePickerProps) {
	const listId = useId();
	const searchId = useId();
	const exactId = useId();
	const containerRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const [open, setOpen] = useState(false);
	const [search, setSearch] = useState("");
	const [exact, setExact] = useState("");

	const query = useResourceOptions(kind, projectId);
	const options = useMemo(
		() => query.data?.pages.flatMap((page) => page.data) ?? [],
		[query.data],
	);

	// A new project (or kind) is a new query; drop the local filter with it so
	// it cannot hide the first page of the new scope. Resetting during render is
	// React's "adjust state when a prop changes" pattern.
	const scope = `${kind}|${projectId ?? ""}`;
	const [stateScope, setStateScope] = useState(scope);
	if (stateScope !== scope) {
		setStateScope(scope);
		setSearch("");
		setExact("");
	}

	useEffect(() => {
		if (!open) return;
		searchRef.current?.focus();
		const onPointerDown = (event: PointerEvent) => {
			if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			setOpen(false);
			triggerRef.current?.focus();
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

	// Only duplicate names need the ID/project to stay distinguishable; a
	// unique name keeps its exact accessible name.
	const duplicates = useMemo(() => {
		const counts = new Map<string, number>();
		for (const option of options)
			counts.set(option.name, (counts.get(option.name) ?? 0) + 1);
		return counts;
	}, [options]);

	const needle = search.trim().toLowerCase();
	const filtered = useMemo(
		() =>
			needle
				? options.filter(
						(option) =>
							option.name.toLowerCase().includes(needle) ||
							option.id.toLowerCase().includes(needle),
					)
				: options,
		[options, needle],
	);

	const selected = value
		? options.find((option) => option.id === value)
		: undefined;
	const triggerText = value
		? (selected?.name ?? value)
		: allowAll
			? ALL_LABEL[kind]
			: PLACEHOLDER[kind];

	const choose = (id: string | undefined) => {
		setOpen(false);
		triggerRef.current?.focus();
		onChange(id);
	};

	const submitExact = () => {
		const id = exact.trim();
		if (!id) return;
		setExact("");
		setSearch("");
		choose(id);
	};

	const renderOption = (option: ResourceOption) => {
		const duplicate = (duplicates.get(option.name) ?? 0) > 1;
		return (
			<button
				key={option.id}
				type="button"
				role="option"
				aria-selected={option.id === value}
				onClick={() => choose(option.id)}
				className={cn(
					"flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none",
					"hover:bg-accent hover:text-accent-foreground",
					"focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
					option.id === value && "bg-accent text-accent-foreground",
				)}
			>
				<span className="truncate">{option.name}</span>
				{duplicate && (
					<>
						{" "}
						<span className="shrink-0 font-mono text-xs text-muted-foreground">
							{option.id}
						</span>
						{option.projectId && (
							<>
								{" "}
								<span className="shrink-0 text-xs text-muted-foreground">
									{option.projectId}
								</span>
							</>
						)}
					</>
				)}
			</button>
		);
	};

	return (
		<div ref={containerRef} className="relative inline-block">
			<button
				ref={triggerRef}
				type="button"
				role="combobox"
				aria-label={label}
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-controls={open ? listId : undefined}
				onClick={() => setOpen((current) => !current)}
				className={cn(
					"flex h-10 w-56 max-w-full items-center justify-between gap-2 rounded-md border border-input bg-surface px-3 py-2 text-sm shadow-xs outline-none",
					"focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
				)}
			>
				<span
					className={cn(
						"truncate",
						value ? undefined : "text-muted-foreground",
						value && !selected && "font-mono text-xs",
					)}
				>
					{triggerText}
				</span>
			</button>

			{open && (
				<div className="absolute left-0 top-full z-50 mt-1 w-80 rounded-md border bg-popover p-2 text-popover-foreground shadow-md">
					<label
						htmlFor={searchId}
						className="block text-xs text-muted-foreground"
					>
						Search loaded options
					</label>
					<Input
						id={searchId}
						ref={searchRef}
						value={search}
						onChange={(event) => setSearch(event.target.value)}
						className="mt-1"
					/>

					{query.isPending ? (
						<p role="status" className="p-2 text-sm text-muted-foreground">
							Loading options…
						</p>
					) : query.isError && options.length === 0 ? (
						<div role="alert" className="p-2 text-sm text-failure">
							<p>Could not load options ({errorText(query.error)}).</p>
							<Button
								type="button"
								variant="outline"
								className="mt-2"
								onClick={() => void query.refetch()}
							>
								Retry
							</Button>
						</div>
					) : (
						<>
							<div
								id={listId}
								role="listbox"
								aria-label={`${label} options`}
								className="mt-1 max-h-64 overflow-y-auto"
							>
								{allowAll && !needle && (
									<button
										type="button"
										role="option"
										aria-selected={value === undefined}
										onClick={() => choose(undefined)}
										className={cn(
											"flex w-full items-center rounded-sm px-2 py-1.5 text-left text-sm outline-none",
											"hover:bg-accent hover:text-accent-foreground",
											"focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
											value === undefined && "bg-accent text-accent-foreground",
										)}
									>
										{ALL_LABEL[kind]}
									</button>
								)}
								{filtered.map(renderOption)}
							</div>
							{filtered.length === 0 && (
								<p className="px-2 py-1 text-sm text-muted-foreground">
									No loaded options match.
								</p>
							)}
							{query.isFetchNextPageError ? (
								<div
									role="status"
									className="mt-1 rounded-sm border border-failure-surface bg-failure-surface px-2 py-1.5 text-sm text-failure"
								>
									<p>Could not load more options.</p>
									<Button
										type="button"
										variant="outline"
										className="mt-2"
										onClick={() => void query.fetchNextPage()}
									>
										Retry loading more
									</Button>
								</div>
							) : query.hasNextPage ? (
								<Button
									type="button"
									variant="outline"
									className="mt-1 w-full"
									disabled={query.isFetchingNextPage}
									onClick={() => void query.fetchNextPage()}
								>
									Load more
								</Button>
							) : null}
						</>
					)}

					<div className="mt-2 border-t pt-2">
						<label
							htmlFor={exactId}
							className="block text-xs text-muted-foreground"
						>
							Exact {label.toLowerCase()} ID
						</label>
						<div className="mt-1 flex gap-2">
							<Input
								id={exactId}
								value={exact}
								onChange={(event) => setExact(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === "Enter") {
										event.preventDefault();
										submitExact();
									}
								}}
							/>
							<Button type="button" variant="outline" onClick={submitExact}>
								Use ID
							</Button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
