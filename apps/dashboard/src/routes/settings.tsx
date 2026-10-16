import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/settings")({
	component: () => <h1 className="p-6 text-xl font-semibold">Settings</h1>,
});
