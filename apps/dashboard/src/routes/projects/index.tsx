import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/projects/")({
	component: () => <h1 className="p-6 text-xl font-semibold">Projects</h1>,
});
