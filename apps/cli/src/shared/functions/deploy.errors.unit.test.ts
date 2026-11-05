import { describe, expect, it } from "vitest";
import { classifyCliErrorActionability } from "../telemetry/error-actionability.ts";
import {
  FunctionDeployError,
  FunctionImportMapSyntaxError,
  FunctionsDeployFailedError,
} from "./deploy.errors.ts";
import { FunctionsApiStatusError, FunctionsApiTransportError } from "./functions-api.errors.ts";

describe("deploy error telemetry identity", () => {
  it("classifies a FunctionDeployError like a plain Error", () => {
    const message = "failed to bundle function: exit 1";
    const result = classifyCliErrorActionability(new FunctionDeployError({ message }));
    expect(result).toEqual(classifyCliErrorActionability(new Error(message)));
    expect(result.error_kind).toBe("unknown");
    expect(result.error_fingerprint).toBe("error:unknown");
  });

  it("classifies a FunctionImportMapSyntaxError as invalid user config", () => {
    const result = classifyCliErrorActionability(
      new FunctionImportMapSyntaxError({ message: "Expected a valid JSON string" }),
    );
    expect(result.error_kind).toBe("user_actionable");
    expect(result.error_category).toBe("invalid_config");
    expect(result.error_fingerprint).toBe("error:FunctionImportMapSyntaxError");
  });

  it("classifies a FunctionsDeployFailedError by its first declared cause", () => {
    const status = new FunctionsApiStatusError({ status: 403, message: "forbidden" });
    const result = classifyCliErrorActionability(
      new FunctionsDeployFailedError(
        [new Error("undeclared"), status, new FunctionsApiTransportError({ message: "reset" })],
        "forbidden",
      ),
    );
    const cause = classifyCliErrorActionability(status);
    expect(result.error_kind).toBe(cause.error_kind);
    expect(result.error_category).toBe(cause.error_category);
    expect(result.error_kind).not.toBe("internal_bug");
    expect(result.error_fingerprint).toMatch(/^error:FunctionsDeployFailedError/u);
  });

  it("classifies a FunctionsDeployFailedError without declared causes as unknown", () => {
    for (const errors of [[], [new Error("plain")]]) {
      const result = classifyCliErrorActionability(new FunctionsDeployFailedError(errors, "x"));
      expect(result.error_kind).toBe("unknown");
      expect(result.error_fingerprint).toMatch(/^error:FunctionsDeployFailedError/u);
    }
  });
});
