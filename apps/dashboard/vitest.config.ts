import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

process.env.TZ = "Asia/Ho_Chi_Minh";

export default mergeConfig(
	viteConfig,
	defineConfig({
		test: {
			coverage: {
				provider: "istanbul",
				include: ["src/**/*.{ts,tsx}"],
				exclude: [
					"src/routeTree.gen.ts",
					"src/components/ui/**",
					"src/main.tsx",
				],
				thresholds: {
					lines: 100,
					branches: 100,
					functions: 100,
					statements: 100,
				},
			},
			environment: "jsdom",
			include: ["tests/**/*.test.{ts,tsx}"],
			setupFiles: ["./tests/helpers/setup.ts"],
			testTimeout: 15_000,
		},
	}),
);
