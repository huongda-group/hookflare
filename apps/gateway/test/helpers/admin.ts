import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createApp } from "../../src/app";
import type { Deps } from "../../src/deps";
import { ACCESS_TEST } from "./env";

export async function accessKeys() {
	const { publicKey, privateKey } = await generateKeyPair("RS256");
	const jwk = {
		...(await exportJWK(publicKey)),
		kid: "test-kid",
		alg: "RS256",
		use: "sig",
	};
	const jwksFetch = Object.assign(
		async (input: RequestInfo | URL) => {
			jwksFetch.calls++;
			if (String(input) !== `${ACCESS_TEST.teamDomain}/cdn-cgi/access/certs`) {
				return new Response("not found", { status: 404 });
			}
			return Response.json({ keys: [jwk] });
		},
		{ calls: 0 },
	) as typeof fetch & { calls: number };

	async function sign(
		claims: Record<string, unknown> = {},
		opts: { kid?: string; expiresIn?: string } = {},
	) {
		// aud/iss are registered claims: SignJWT's setters overwrite same-named
		// payload fields, so route them through the setters (jose 6 behavior).
		const { iss, aud, ...rest } = claims;
		return new SignJWT({ email: ACCESS_TEST.admin, ...rest })
			.setProtectedHeader({ alg: "RS256", kid: opts.kid ?? "test-kid" })
			.setIssuer(typeof iss === "string" ? iss : ACCESS_TEST.teamDomain)
			.setAudience(typeof aud === "string" ? aud : ACCESS_TEST.aud)
			.setIssuedAt()
			.setExpirationTime(opts.expiresIn ?? "5m")
			.sign(privateKey);
	}
	return { jwksFetch, sign };
}

/** Admin requests signed as the bootstrap admin. */
export async function adminApp(deps: Deps) {
	const keys = await accessKeys();
	const app = createApp({
		createDeps: () => deps,
		accessFetch: keys.jwksFetch,
	});
	const token = await keys.sign();
	return {
		request(
			method: string,
			path: string,
			body?: unknown,
			headers: Record<string, string> = {},
		) {
			const init: RequestInit = {
				method,
				headers: { "cf-access-jwt-assertion": token, ...headers },
			};
			if (body !== undefined) {
				init.body = typeof body === "string" ? body : JSON.stringify(body);
				(init.headers as Record<string, string>)["content-type"] =
					"application/json";
			}
			return app.request(
				`https://hookflare.example.com/api/admin/v1${path}`,
				init,
				deps.env,
			);
		},
	};
}
