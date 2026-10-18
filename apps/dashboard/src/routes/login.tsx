import { createFileRoute } from "@tanstack/react-router";
import { LoginPage, loginSearch } from "@/pages/LoginPage";

export const Route = createFileRoute("/login")({
	validateSearch: loginSearch,
	component: function LoginRoute() {
		const { next } = Route.useSearch();
		return <LoginPage next={next} />;
	},
});
