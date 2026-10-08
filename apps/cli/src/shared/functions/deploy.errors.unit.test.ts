import { describe, expect, it } from "vitest";
import { classifyCliErrorActionability } from "../telemetry/error-actionability.ts";
import { FunctionDeployError, FunctionImportMapSyntaxError } from "./deploy.errors.ts";

describe("deploy error telemetry identity", () => {
  it("classifies a FunctionDeployError like a plain Error", () => {
    const message = "failed to bundle function: exit 1";
    const result = classifyCliErrorActionability(new FunctionDeployError({ message }));
    expect(result).toEqual(classifyCliErrorActionability(new Error(message)));
    expect(result.error_kind).toBe("unknown");
    expect(result.error_fingerprint).toBe("error:unknown");
  });

  it("classifies a FunctionImportMapSyntaxError like a native SyntaxError", () => {
    const result = classifyCliErrorActionability(
      new FunctionImportMapSyntaxError({ message: "Expected a valid JSON string" }),
    );
    expect(result).toEqual(
      classifyCliErrorActionability(new SyntaxError("JSON Parse error: Expected '}'")),
    );
    expect(result.error_kind).toBe("internal_bug");
    expect(result.error_category).toBe("panic");
    expect(result.error_fingerprint).toBe("error:SyntaxError");
  });
});
