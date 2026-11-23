import type { Deps } from "../deps";

export const ENQUEUE_CHUNK = 50;

export function chunks<T>(items: T[], size = ENQUEUE_CHUNK): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size)
		out.push(items.slice(i, i + size));
	return out;
}

export async function enqueueThenMark(
	deps: Deps,
	ids: string[],
	mark: (chunk: string[]) => Promise<unknown>,
): Promise<{ sent: number; sendFailed: number; unsent: string[] }> {
	let sent = 0;
	let sendFailed = 0;
	const unsent: string[] = [];
	for (const chunk of chunks(ids)) {
		try {
			await deps.queue.sendBatch(
				chunk.map((deliveryId) => ({ body: { deliveryId } })),
			);
		} catch {
			sendFailed++;
			unsent.push(...chunk);
			continue;
		}
		await mark(chunk);
		sent += chunk.length;
	}
	return { sent, sendFailed, unsent };
}
