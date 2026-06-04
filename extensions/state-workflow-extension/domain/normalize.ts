import type { RawExecutionResult, StateExecutionResult } from "./types.js";

export const normalizeExecutionResult = (raw: RawExecutionResult): StateExecutionResult => {
	if (raw.kind === "command") {
		return raw.exitCode === 0
			? { outcome: "success", raw, output: raw.stdout }
			: {
					outcome: "error",
					raw,
					error: {
						code: `EXIT_${raw.exitCode}`,
						message: raw.stderr ?? `Command failed with exit code ${raw.exitCode}`,
					},
				};
	}

	if (raw.kind === "function") {
		return raw.ok
			? { outcome: "success", raw, output: raw.output }
			: {
					outcome: "error",
					raw,
					error: raw.error ?? {
						code: "FUNCTION_ERROR",
						message: "Function action failed",
					},
				};
	}

	if (raw.kind === "continueSession") {
		return { outcome: "success", raw, output: raw.output };
	}

	return raw.status === "success"
		? { outcome: "success", raw, output: raw.output }
		: {
				outcome: "error",
				raw,
				error: raw.error ?? {
					code: "USER_MESSAGE_ERROR",
					message: "User message action failed",
				},
			};
};
