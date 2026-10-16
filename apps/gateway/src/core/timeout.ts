/** Rejects when `p` has not settled within `ms`; the timer never outlives the race. */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`timeout after ${ms} ms`)), ms);
	});
	return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}
