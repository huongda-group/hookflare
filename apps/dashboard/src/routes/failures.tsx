import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

export const Route = createFileRoute("/failures")({
	validateSearch: z.object({
		destination_id: z.string().optional().catch(undefined),
	}),
	component: () => <h1 className="p-6 text-xl font-semibold">Failures</h1>,
});
