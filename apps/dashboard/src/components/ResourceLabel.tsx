import type { Page } from "@hookflare/shared";
import type { InfiniteData } from "@tanstack/react-query";
import { skipToken, useQuery } from "@tanstack/react-query";
import { qk } from "@/lib/queries/keys";
import type {
	ResourceKind,
	ResourceOption,
} from "@/lib/queries/resource-options";

/** Stable so the observer only re-selects when the cached pages change. */
function indexPages(
	data: InfiniteData<Page<ResourceOption>> | undefined,
): Map<string, ResourceOption> {
	const byId = new Map<string, ResourceOption>();
	for (const page of data?.pages ?? [])
		for (const option of page.data) byId.set(option.id, option);
	return byId;
}

/**
 * Shows the name of a resource from the pages already cached by a
 * `ResourcePicker` — no request is issued for a label (spec §7: name lookups
 * are decoration). A missing permission, deleted resource, failed lookup, or
 * simply unloaded page falls back to the exact ID.
 */
export function ResourceLabel({
	kind,
	id,
	projectId,
}: {
	kind: ResourceKind;
	id: string;
	projectId?: string;
}) {
	const { data } = useQuery<
		InfiniteData<Page<ResourceOption>>,
		Error,
		Map<string, ResourceOption>
	>({
		queryKey: qk.resourceOptions(kind, projectId),
		// `skipToken` keeps the query disabled: this observer only reads the
		// shared cache, it never fetches.
		queryFn: skipToken,
		select: indexPages,
	});

	const option = data?.get(id);
	if (!option)
		return (
			<span className="font-mono text-xs" title={id}>
				{id}
			</span>
		);
	return <span title={id}>{option.name}</span>;
}
