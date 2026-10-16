import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/events/")({
	component: () => <h1 className="p-6 text-xl font-semibold">Events</h1>,
});
