import type { MiddlewareHandler } from "hono";
import {
	createRemoteJWKSet,
	customFetch,
	errors,
	type JWTPayload,
	jwtVerify,
} from "jose";
import type { AppBindings } from "../../app";
import { getUser } from "../../core/db/users";

/** Unknown-kid refetches are bounded to one per team domain per cooldown. */
const COOLDOWN_MS = 60_000;

/** The only `svc:` identities Access could map to (kept until Access is removed in M7). */
const SERVICE_IDENTITY_PATTERN = /^svc:[a-z0-9._-]{1,200}$/;

type KeySet = ReturnType<typeof createRemoteJWKSet>;
type Entry = { set: KeySet; rotationRefetchAt: number };
const keySets = new Map<string, Entry>();

export function clearAccessKeyCache(): void {
	keySets.clear();
}

function createKeySet(
	teamDomain: string,
	fetchFn: typeof fetch | undefined,
): KeySet {
	return createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`), {
		cooldownDuration: COOLDOWN_MS,
		...(fetchFn ? { [customFetch]: fetchFn } : {}),
	});
}

function keySetFor(
	teamDomain: string,
	fetchFn: typeof fetch | undefined,
): KeySet {
	let entry = keySets.get(teamDomain);
	if (!entry) {
		entry = { set: createKeySet(teamDomain, fetchFn), rotationRefetchAt: 0 };
		keySets.set(teamDomain, entry);
	}
	return entry.set;
}

function verifyOptions(
	audience: string,
	issuer: string,
): {
	algorithms: ["RS256"];
	audience: string;
	issuer: string;
	clockTolerance: number;
} {
	return {
		algorithms: ["RS256"],
		audience,
		issuer,
		clockTolerance: 60,
	};
}

/**
 * Verify an Access JWT, refetching the key set at most once per cooldown when
 * the kid is unknown (key rotation). jose 6 starts its internal cooldown at
 * load, so a freshly-loaded set never refetches on its own — the bound lives
 * here instead. Throws on any verification failure; callers fail closed.
 */
async function verifyWithRotation(
	token: string,
	teamDomain: string,
	audience: string,
	fetchFn: typeof fetch | undefined,
) {
	try {
		return await jwtVerify(
			token,
			keySetFor(teamDomain, fetchFn),
			verifyOptions(audience, teamDomain),
		);
	} catch (err) {
		if (!(err instanceof errors.JWKSNoMatchingKey)) throw err;
		const entry = keySets.get(teamDomain);
		if (!entry || Date.now() - entry.rotationRefetchAt < COOLDOWN_MS) throw err;
		entry.rotationRefetchAt = Date.now();
		entry.set = createKeySet(teamDomain, fetchFn);
		return jwtVerify(token, entry.set, verifyOptions(audience, teamDomain));
	}
}

/** Spec §6.1/DEC-5: a token with an email identifies as that email; a
 * service token (no email) identifies as `svc:<common_name>`. */
export function identityFromPayload(payload: JWTPayload): string | undefined {
	const email =
		typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
	if (email) return email;
	const commonName =
		typeof payload.common_name === "string"
			? payload.common_name.trim().toLowerCase()
			: "";
	if (!commonName) return undefined;
	// A common_name the users API could never store is rejected outright
	// (403) rather than matched against a hand-written row.
	const identity = `svc:${commonName}`;
	return SERVICE_IDENTITY_PATTERN.test(identity) ? identity : undefined;
}

/** Spec §6.1. Fails closed: missing config is a 500, never an open API. */
export function accessMiddleware(
	options: { fetch?: typeof fetch } = {},
): MiddlewareHandler<AppBindings> {
	return async (c, next) => {
		const env = c.env;
		const hostname = new URL(c.req.url).hostname;
		let email: string | undefined;

		if (
			env.ACCESS_DEV_EMAIL &&
			(hostname === "localhost" || hostname === "127.0.0.1")
		) {
			email = env.ACCESS_DEV_EMAIL;
		} else {
			if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
				c.var.logger.error("admin.access_misconfigured");
				return c.json(
					{ error: "internal_error", request_id: c.var.requestId },
					500,
				);
			}
			const token = c.req.header("cf-access-jwt-assertion");
			if (!token) {
				return c.json({ error: "unauthorized" }, 401);
			}
			try {
				const { payload } = await verifyWithRotation(
					token,
					env.ACCESS_TEAM_DOMAIN,
					env.ACCESS_AUD,
					options.fetch,
				);
				email = identityFromPayload(payload);
			} catch (err) {
				c.var.logger.info("admin.access_denied", {
					reason: err instanceof Error ? err.name : "unknown",
				});
				return c.json({ error: "unauthorized" }, 401);
			}
		}

		const normalized = email?.trim().toLowerCase();
		if (!normalized) {
			return c.json({ error: "forbidden" }, 403);
		}
		// Spec §6.1: D1 is the source of truth. Bootstrap-via-env is gone with
		// built-in auth (M7), so an unknown identity is simply forbidden.
		const { db } = c.var.deps;
		const user = await getUser(db, normalized);
		if (!user || user.disabledAt !== null) {
			return c.json({ error: "forbidden" }, 403);
		}
		c.set("actor", { email: normalized, role: user.role });
		await next();
	};
}
