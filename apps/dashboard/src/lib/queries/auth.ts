import type { AuthState } from "@hookflare/shared";
import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";
import { qk } from "./keys";

/** `GET /auth/state` (public): whether onboarding is open and the Turnstile key. */
export function getAuthState(): Promise<AuthState> {
	return api.get<AuthState>("/auth/state");
}

/** The root loader awaits this before rendering any route (spec §6.7). */
export const authStateQuery = queryOptions({
	queryKey: qk.authState,
	queryFn: getAuthState,
	staleTime: Number.POSITIVE_INFINITY,
});

export type SetupBody = {
	username: string;
	password: string;
	turnstile_token?: string;
};

/** `POST /auth/setup` (public): claims the first admin and logs them in. */
export function setup(body: SetupBody): Promise<void> {
	return api.postVoid("/auth/setup", body);
}

export type LoginBody = {
	username: string;
	password: string;
	turnstile_token?: string;
};

/** `POST /auth/login` (public): starts a session. */
export function login(body: LoginBody): Promise<void> {
	return api.postVoid("/auth/login", body);
}

/** `POST /auth/logout` (public): deletes the session and clears the cookie. */
export function logout(): Promise<void> {
	return api.postVoid("/auth/logout");
}

/** `POST /me/password`: changes the caller's own password. */
export function changePassword(body: {
	current_password: string;
	new_password: string;
}): Promise<void> {
	return api.postVoid("/me/password", body);
}
