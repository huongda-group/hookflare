export type SmokeEnv = {
	url: string;
	clientId: string;
	clientSecret: string;
	sinkUrl: string;
};

export type PollOptions = {
	timeoutMs?: number;
	intervalMs?: number;
	sleep?: (ms: number) => Promise<void>;
};

export function smokeEnv(
	env?: Record<string, string | undefined>,
): SmokeEnv | null;

export function pollUntil<T>(
	fn: (attempt: number) => Promise<T | null | undefined>,
	options?: PollOptions,
): Promise<T>;

export function runId(): string;
