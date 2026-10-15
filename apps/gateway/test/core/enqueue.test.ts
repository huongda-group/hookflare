import { describe, expect, it, vi } from "vitest";
import { chunks, enqueueThenMark } from "../../src/core/enqueue";
import { type RecordingQueue, recordingQueue, testDeps } from "../helpers/deps";
import { faultyDeps } from "../helpers/faults";

describe("enqueueThenMark", () => {
	it("chunks by 50", () => {
		expect(chunks([...Array(120).keys()]).map((c) => c.length)).toEqual([
			50, 50, 20,
		]);
	});

	it("sends each chunk and then marks it", async () => {
		const deps = testDeps({ queue: recordingQueue() });
		const mark = vi.fn(async (_chunk: string[]) => {});
		const ids = Array.from({ length: 60 }, (_, i) => `dlv_${i}`);
		expect(await enqueueThenMark(deps, ids, mark)).toEqual({
			sent: 60,
			sendFailed: 0,
		});
		expect((deps.queue as RecordingQueue).sent).toHaveLength(60);
		expect(mark.mock.calls.map((c) => c[0].length)).toEqual([50, 10]);
	});

	it("skips the mark of a chunk whose send failed", async () => {
		const deps = faultyDeps(testDeps({ queue: recordingQueue() }), {
			queue: [{ match: /^sendBatch$/, on: { nth: 1 } }],
		});
		const mark = vi.fn(async (_chunk: string[]) => {});
		const ids = Array.from({ length: 60 }, (_, i) => `dlv_${i}`);
		expect(await enqueueThenMark(deps, ids, mark)).toEqual({
			sent: 10,
			sendFailed: 1,
		});
		expect(mark).toHaveBeenCalledTimes(1);
	});
});
