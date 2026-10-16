import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/failures")({
	component: () => <h1 className="p-6 text-xl font-semibold">Failures</h1>,
});
