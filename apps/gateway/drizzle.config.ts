import { defineConfig } from "drizzle-kit";

// Generates SQL into migrations/; wrangler applies it (`pnpm db:migrate:*`).
// drizzle-kit only reads migrations/meta/ to diff, never the database.
export default defineConfig({
	dialect: "sqlite",
	schema: "./src/core/db/schema.ts",
	out: "./migrations",
});
