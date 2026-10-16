import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/endpoints/")({
	component: () => <h1 className="p-6 text-xl font-semibold">Endpoints</h1>,
});
