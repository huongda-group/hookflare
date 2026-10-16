export type BackupParams = {
	backupId: string;
	trigger: "cron" | "manual";
	resume?: {
		tableIndex: number;
		cursor: string | number | null;
		partNo: number;
	};
};
