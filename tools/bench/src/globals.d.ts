/**
 * Minimal ambient declarations for the Node APIs the bench uses. The bench
 * has no new runtime dependencies (not even @types/node), so the handful of
 * globals and `node:` imports it needs are declared here instead.
 */

declare const process: {
	argv: string[];
	env: Record<string, string | undefined>;
	exit(code?: number): never;
};

declare module "node:crypto" {
	export interface BenchHash {
		update(data: string, encoding: "utf8"): BenchHash;
		digest(encoding: "hex" | "base64"): string;
	}
	export function createHmac(algorithm: string, key: string): BenchHash;
	export interface BenchRandom {
		toString(encoding: "hex" | "base64"): string;
	}
	export function randomBytes(size: number): BenchRandom;
}

declare module "node:fs/promises" {
	export function readFile(
		path: string | URL,
		encoding: "utf8",
	): Promise<string>;
	export function mkdir(
		path: string,
		options?: { recursive?: boolean },
	): Promise<string | undefined>;
	export function writeFile(
		path: string,
		data: string,
		encoding?: "utf8",
	): Promise<void>;
}

interface ImportMeta {
	url: string;
}
