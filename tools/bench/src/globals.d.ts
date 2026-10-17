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

declare const Buffer: {
	byteLength(data: string, encoding?: "utf8"): number;
};

declare module "node:child_process" {
	export function execFileSync(
		file: string,
		args: string[],
		options?: { stdio?: string | unknown[] },
	): unknown;
}

declare module "node:crypto" {
	export interface BenchHash {
		update(data: string, encoding: "utf8" | "hex"): BenchHash;
		update(data: Uint8Array): BenchHash;
		digest(encoding: "hex" | "base64"): string;
	}
	export function createHash(algorithm: string): BenchHash;
	export function createHmac(algorithm: string, key: string): BenchHash;
	export interface BenchRandom {
		toString(encoding: "hex" | "base64"): string;
		readUInt32BE(offset?: number): number;
	}
	export function randomBytes(size: number): BenchRandom;
}

declare module "node:fs" {
	export function mkdirSync(
		path: string,
		options?: { recursive?: boolean },
	): void;
	export function writeFileSync(
		path: string,
		data: string,
		encoding?: "utf8",
	): void;
	export function readFileSync(path: string | URL, encoding: "utf8"): string;
	export function readdirSync(path: string): string[];
	export function unlinkSync(path: string): void;
	export function renameSync(from: string, to: string): void;
	export function openSync(path: string, flags: "w" | "a"): number;
	export function writeSync(fd: number, data: string): number;
	export function closeSync(fd: number): void;
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

declare module "*/jsonc.mjs" {
	export function parseJsonc(text: string): unknown;
}

interface ImportMeta {
	url: string;
}
