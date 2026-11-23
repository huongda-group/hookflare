import type { Page } from "@hookflare/shared";
import { useInfiniteQuery } from "@tanstack/react-query";
import { api } from "../api";
import { qk } from "./keys";

export type ResourceKind = "project" | "source" | "destination";

export type ResourceOption = { id: string; name: string; projectId?: string };

export const RESOURCE_OPTION_LIMIT = 50;

const PATH: Record<ResourceKind, string> = {
	project: "/projects",
	source: "/sources",
	destination: "/destinations",
};

type ResourceRow = { id: string; name: string; project_id?: string };

function toOption(kind: ResourceKind, row: ResourceRow): ResourceOption {
	return kind === "project"
		? { id: row.id, name: row.name }
		: { id: row.id, name: row.name, projectId: row.project_id };
}

export function useResourceOptions(kind: ResourceKind, projectId?: string) {
	return useInfiniteQuery({
		queryKey: qk.resourceOptions(kind, projectId),
		queryFn: async ({ pageParam }) => {
			const page = await api.get<Page<ResourceRow>>(PATH[kind], {
				limit: RESOURCE_OPTION_LIMIT,
				cursor: pageParam,
				project_id: kind === "project" ? undefined : projectId,
			});
			return {
				data: page.data.map((row) => toOption(kind, row)),
				next_cursor: page.next_cursor,
			} satisfies Page<ResourceOption>;
		},
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (last) => last.next_cursor ?? undefined,
	});
}
