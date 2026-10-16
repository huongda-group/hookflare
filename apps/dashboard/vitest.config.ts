import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

// Fixed zone with no DST, so day grouping is deterministic (spec §12.2).
process.env.TZ = "Asia/Ho_Chi_Minh";

export default mergeConfig(
	viteConfig,
	defineConfig({
		test: {
			environment: "jsdom",
			include: ["src/**/*.test.{ts,tsx}"],
			setupFiles: ["./src/test/setup.ts"],
			// userEvent flows in jsdom can exceed 5 s when every workspace tests at once.
			testTimeout: 15_000,
		},
	}),
);
