import type { MiddlewareHandler } from "hono";
import { createRemoteJWKSet, customFetch, errors, jwtVerify } from "jose";
import type { AppBindings } from "../../app";
import { bootstrapStatements, getUser } from "../../core/db/users";

/** Unknown-kid refetches are bounded to one per team domain per cooldown. */
const COOLDOWN_MS = 60_000;

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

function allowedEmails(value: string | undefined): Set<string> {
	return new Set(
		(value ?? "")
			.split(",")
			.map((e) => e.trim().toLowerCase())
			.filter(Boolean),
	);
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
				email = typeof payload.email === "string" ? payload.email : undefined;
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
		// Spec §6.1: D1 is the source of truth; the env list only seeds admins.
		const { db, now } = c.var.deps;
		let user = await getUser(db, normalized);
		if (!user && allowedEmails(env.BOOTSTRAP_ADMIN_EMAILS).has(normalized)) {
			await db.batch(bootstrapStatements(db, normalized, now()));
			user = await getUser(db, normalized);
			c.var.logger.info("admin.user_bootstrapped", { actor_email: normalized });
		}
		if (!user || user.disabledAt !== null) {
			return c.json({ error: "forbidden" }, 403);
		}
		c.set("actor", { email: normalized, role: user.role });
		await next();
	};
}
