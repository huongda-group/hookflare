import { asc, eq } from "drizzle-orm";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createApp } from "../../src/app";
import { auditLogs, type Role, users } from "../../src/core/db/schema";
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

export function uniqueEmail(prefix = "user"): string {
	return `${prefix}-${crypto.randomUUID().slice(0, 8)}@example.com`;
}

/** Audit rows for one resource, oldest first. */
export async function auditRows(deps: Deps, resourceId: string) {
	return deps.db
		.select()
		.from(auditLogs)
		.where(eq(auditLogs.resourceId, resourceId))
		.orderBy(asc(auditLogs.id));
}

/**
 * Admin API client. With no options it signs as the bootstrap admin; with a
 * role it first stores an active user with that role.
 */
export async function adminApp(
	deps: Deps,
	opts: { role?: Role; email?: string } = {},
) {
	const keys = await accessKeys();
	const app = createApp({
		createDeps: () => deps,
		accessFetch: keys.jwksFetch,
	});
	const email =
		opts.email ?? (opts.role ? uniqueEmail(opts.role) : ACCESS_TEST.admin);
	if (opts.role) {
		const now = deps.now();
		await deps.db
			.insert(users)
			.values({ email, role: opts.role, createdAt: now, updatedAt: now })
			.onConflictDoUpdate({
				target: users.email,
				set: { role: opts.role, disabledAt: null, updatedAt: now },
			});
	}
	const token = await keys.sign({ email });
	return {
		email,
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
