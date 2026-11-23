import type { AuthState } from "@hookflare/shared";
import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";
import { qk } from "./keys";

export function getAuthState(): Promise<AuthState> {
	return api.get<AuthState>("/auth/state");
}

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

export function setup(body: SetupBody): Promise<void> {
	return api.postVoid("/auth/setup", body);
}

export type LoginBody = {
	username: string;
	password: string;
	turnstile_token?: string;
};

export function login(body: LoginBody): Promise<void> {
	return api.postVoid("/auth/login", body);
}

export function logout(): Promise<void> {
	return api.postVoid("/auth/logout");
}

export function changePassword(body: {
	current_password: string;
	new_password: string;
}): Promise<void> {
	return api.postVoid("/me/password", body);
}
