import type { Page } from "@hookflare/shared";
import type { InfiniteData } from "@tanstack/react-query";
import { skipToken, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { qk } from "@/lib/queries/keys";
import type {
	ResourceKind,
	ResourceOption,
} from "@/lib/queries/resource-options";
import { useResourceOptions } from "@/lib/queries/resource-options";

function indexPages(
	data: InfiniteData<Page<ResourceOption>> | undefined,
): Map<string, ResourceOption> {
	const byId = new Map<string, ResourceOption>();
	// biome-ignore format: keeps the coverage hint on the fallback operand
	for (const page of data?.pages ?? /* istanbul ignore next -- @preserve */ [])
		for (const option of page.data) byId.set(option.id, option);
	return byId;
}

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

export function NamedResourceLink({
	kind,
	id,
	projectId,
	href,
}: {
	kind: ResourceKind;
	id: string;
	projectId?: string;
	href: string;
}) {
	void useResourceOptions(kind, projectId);
	return (
		<Link
			to={href}
			search={
				kind !== "project" && projectId ? { project_id: projectId } : undefined
			}
			className="font-medium hover:underline"
			onClick={(e) => e.stopPropagation()}
		>
			<ResourceLabel kind={kind} id={id} projectId={projectId} />
		</Link>
	);
}
