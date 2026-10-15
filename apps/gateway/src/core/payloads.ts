import type { Deps } from "../deps";
import type { WebhookEventRow } from "./db/schema";

/** Bodies above this go to R2 (spec §5.3). */
export const INLINE_BODY_LIMIT = 65_536;

/** events/YYYY/MM/DD/<evt_id>, UTC date of received_at. */
export function payloadKey(eventId: string, receivedAt: number): string {
	const iso = new Date(receivedAt).toISOString();
	return `events/${iso.slice(0, 4)}/${iso.slice(5, 7)}/${iso.slice(8, 10)}/${eventId}`;
}

/** R2 verifies the sha256 (hex) server-side, so a corrupted upload fails here. */
export async function putPayload(
	deps: Deps,
	key: string,
	body: Uint8Array<ArrayBuffer>,
	meta: { sha256: string; contentType: string | null },
): Promise<void> {
	await deps.payloads.put(key, body, {
		sha256: meta.sha256,
		httpMetadata: meta.contentType
			? { contentType: meta.contentType }
			: undefined,
	});
}

/** The stored body; null when the R2 object is missing. R2 errors propagate. */
export async function loadPayload(
	deps: Deps,
	event: Pick<WebhookEventRow, "r2Key" | "bodyInline">,
): Promise<Uint8Array<ArrayBuffer> | null> {
	if (event.r2Key === null) {
		return new Uint8Array(event.bodyInline) as Uint8Array<ArrayBuffer>;
	}
	const object = await deps.payloads.get(event.r2Key);
	return object ? new Uint8Array(await object.arrayBuffer()) : null;
}

export async function deletePayload(deps: Deps, key: string): Promise<void> {
	await deps.payloads.delete(key);
}
