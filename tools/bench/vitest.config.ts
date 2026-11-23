import { defineConfig } from "vitest/config";

// tools/bench is a dev-only load generator that never ships, so coverage is
// reported but not gated at 100%.
export default defineConfig({
	test: {
		coverage: {
			provider: "istanbul",
			include: ["src/**/*.ts"],
		},
	},
});
