import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [
		tanstackRouter({
			target: "react",
			autoCodeSplitting: true,
			codeSplittingOptions: { addHmr: !process.env.VITEST },
		}),
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
