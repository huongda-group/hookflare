export type ManifestPart = {
	table: string;
	key: string;
	rows: number;
	bytes: number;
	sha256: string;
	blob_bytes: Record<string, number>;
};

export type ManifestTable = {
	name: string;
	key: { column: string } | { rowid: true };
	columns: { name: string; type: string; blob: boolean }[];
	foreign_keys: { column: string; table: string; to: string }[];
	rows: number;
	parts: ManifestPart[];
};

export type Manifest = {
	version: 1;
	backup_id: string;
	prefix: string;
	started_at: number;
	finished_at: number;
	d1_migrations: string[];
	tables: ManifestTable[];
};

export type OrphanReport = Record<
	string,
	{ count: number; sample: unknown[]; blob_bytes?: Record<string, number> }
>;

export function valueLiteral(value: unknown): string;

export function utf8Length(s: string): number;

export function tableOrder(manifest: Manifest): string[];

export function rowStatements(
	table: ManifestTable,
	row: Record<string, unknown>,
	maxStmt?: number,
): string[];

export function createOrphanFilter(manifest: Manifest): {
	admit: (
		table: string | ManifestTable,
		row: Record<string, unknown>,
	) => boolean;
	preload: (
		table: string | ManifestTable,
		rows: Iterable<Record<string, unknown>>,
	) => void;
	report: () => OrphanReport;
};

export class SqlFileWriter {
	constructor(dir: string, maxBytes?: number);
	files: string[];
	writeStatement(sql: string): void;
	close(): string[];
}
