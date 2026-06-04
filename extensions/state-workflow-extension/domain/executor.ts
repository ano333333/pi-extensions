import type { ActionExecutor, RawExecutionResult, StateId } from "./types.js";

export const createFakeExecutor = (table: Record<StateId, RawExecutionResult>): ActionExecutor => ({
	execute: async ({ state }) => {
		const result = table[state.id];
		if (!result) {
			throw new Error(`No fake execution result registered for state: ${state.id}`);
		}
		return result;
	},
});
