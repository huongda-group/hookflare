import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Spec M4-2: `vite dev` proxies the API to `wrangler dev`.
export default defineConfig({
	// The router plugin must run before the React plugin.
	plugins: [
		tanstackRouter({ target: "react", autoCodeSplitting: true }),
		react(),
		tailwindcss(),
	],
	resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
	server: {
		port: 5173,
		proxy: { "/api": "http://127.0.0.1:8787" },
	},
	build: { outDir: "dist", emptyOutDir: true },
});
