import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["state-workflow-extension/**/*.test.ts"],
	},
});
