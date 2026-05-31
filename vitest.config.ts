import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["state-workflow-extension/domain/**/*.test.ts"],
	},
});
