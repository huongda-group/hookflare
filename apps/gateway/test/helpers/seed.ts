import { encryptSecret } from "../../src/core/crypto";
import {
	type DeliveryStatus,
	type DestinationRow,
	deliveries,
	destinations,
	type ProjectRow,
	projects,
	type SourceRow,
	sources,
	webhookEvents,
} from "../../src/core/db/schema";
import { newId } from "../../src/core/ids";
import type { Deps } from "../../src/deps";

/** The Standard Webhooks reference test secret. */
export const TEST_SIGNING_SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
export const TEST_SOURCE_SECRET = "test-source-secret-0123456789";

export type Pipeline = {
	project: ProjectRow;
	destination: DestinationRow;
	source: SourceRow;
};

export async function seedPipeline(
	deps: Deps,
	opts: {
		destination?: Partial<DestinationRow>;
		source?: Partial<SourceRow> & { secret?: string | null };
	} = {},
): Promise<Pipeline> {
	const now = deps.now();
	const projectId = newId("prj", now);
	const project: ProjectRow = {
		id: projectId,
		name: "Test project",
		slug: `p-${projectId.slice(-12).toLowerCase()}`,
		status: "active",
		createdAt: now,
		updatedAt: now,
	};
	const destinationId = newId("dst", now);
	const destination: DestinationRow = {
		id: destinationId,
		projectId,
		name: "Backend",
		url: "https://backend.example.com/hooks",
		status: "active",
		signingSecretEnc: await encryptSecret(
			deps.env,
			TEST_SIGNING_SECRET,
			`destinations.signing_secret_enc:${destinationId}`,
		),
		signingSecretPrevEnc: null,
		signingSecretPrevExpiresAt: null,
		timeoutMs: null,
		maxAttempts: null,
		backoffBaseS: null,
		backoffMaxS: null,
		createdAt: now,
		updatedAt: now,
		...opts.destination,
	};
	const { secret: secretOverride, ...sourceOverrides } = opts.source ?? {};
	const sourceId = newId("src", now);
	const authType = sourceOverrides.authType ?? "none";
	const secret =
		secretOverride === undefined
			? authType === "none"
				? null
				: TEST_SOURCE_SECRET
			: secretOverride;
	const source: SourceRow = {
		id: sourceId,
		projectId,
		destinationId,
		name: "Provider",
		status: "active",
		authType,
		authConfig: {},
		secretEnc:
			secret === null
				? null
				: await encryptSecret(
						deps.env,
						secret,
						`sources.secret_enc:${sourceId}`,
					),
		secretPrevEnc: null,
		secretPrevExpiresAt: null,
		eventIdFrom: "none",
		eventIdSelector: null,
		maxBodyBytes: null,
		createdAt: now,
		updatedAt: now,
		...sourceOverrides,
	};
	await deps.db.insert(projects).values(project);
	await deps.db.insert(destinations).values(destination);
	await deps.db.insert(sources).values(source);
	return { project, destination, source };
}

export async function seedDelivery(
	deps: Deps,
	p: Pipeline,
	opts: {
		status?: DeliveryStatus;
		body?: Uint8Array;
		headers?: Record<string, string>;
		contentType?: string | null;
		delivery?: Partial<typeof deliveries.$inferInsert>;
		event?: Partial<typeof webhookEvents.$inferInsert>;
	} = {},
): Promise<{ eventId: string; deliveryId: string }> {
	const now = deps.now();
	const eventId = newId("evt", now);
	const deliveryId = newId("dlv", now);
	const body = opts.body ?? new TextEncoder().encode('{"hello":"world"}');
	await deps.db.insert(webhookEvents).values({
		id: eventId,
		projectId: p.project.id,
		sourceId: p.source.id,
		providerEventId: null,
		receivedAt: now,
		headersJson: opts.headers ?? { "content-type": "application/json" },
		contentType:
			opts.contentType === undefined ? "application/json" : opts.contentType,
		sizeBytes: body.byteLength,
		payloadSha256: "0".repeat(64),
		bodyInline: body,
		...opts.event,
	});
	await deps.db.insert(deliveries).values({
		id: deliveryId,
		eventId,
		destinationId: p.destination.id,
		projectId: p.project.id,
		kind: "initial",
		status: opts.status ?? "queued",
		attemptCount: 0,
		enqueuedAt: now,
		createdAt: now,
		...opts.delivery,
	});
	return { eventId, deliveryId };
}
