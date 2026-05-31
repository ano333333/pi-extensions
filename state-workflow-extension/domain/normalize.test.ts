import { describe, expect, it } from "vitest";

import { normalizeExecutionResult } from "./normalize.js";

describe("normalizeExecutionResult", () => {
	it("treats command exitCode 0 as success", () => {
		const result = normalizeExecutionResult({ kind: "command", exitCode: 0, stdout: "ok" });
		expect(result.outcome).toBe("success");
		expect(result.output).toBe("ok");
	});

	it("treats non-zero command exitCode as error", () => {
		const result = normalizeExecutionResult({ kind: "command", exitCode: 1, stderr: "boom" });
		expect(result.outcome).toBe("error");
		expect(result.error).toEqual({ code: "EXIT_1", message: "boom" });
	});

	it("treats successful function result as success", () => {
		const result = normalizeExecutionResult({ kind: "function", ok: true, output: { ok: true } });
		expect(result.outcome).toBe("success");
		expect(result.output).toEqual({ ok: true });
	});

	it("treats failed function result as error", () => {
		const result = normalizeExecutionResult({
			kind: "function",
			ok: false,
			error: { code: "X", message: "failed" },
		});
		expect(result.outcome).toBe("error");
		expect(result.error).toEqual({ code: "X", message: "failed" });
	});

	it("treats continueSession result as success", () => {
		const result = normalizeExecutionResult({ kind: "continueSession", status: "success" });
		expect(result.outcome).toBe("success");
	});
});
