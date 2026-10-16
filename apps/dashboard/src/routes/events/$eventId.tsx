import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/events/$eventId")({
	component: () => <h1 className="p-6 text-xl font-semibold">Event</h1>,
});
