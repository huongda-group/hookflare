import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
	component: () => <h1 className="p-6 text-xl font-semibold">Hookflare</h1>,
});
