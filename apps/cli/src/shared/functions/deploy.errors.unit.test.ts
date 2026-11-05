import { Data } from "effect";
import { describe, expect, it } from "vitest";
import {
  actionability,
  classifyCliErrorActionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../telemetry/error-actionability.ts";
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

  it("classifies a FunctionsDeployFailedError by its cause when every function fails alike", () => {
    const result = classifyCliErrorActionability(
      new FunctionsDeployFailedError(
        [
          new FunctionsApiStatusError({ status: 403, message: "forbidden" }),
          new FunctionsApiStatusError({ status: 403, message: "forbidden" }),
        ],
        "forbidden",
      ),
    );
    expect(result.error_kind).toBe("user_actionable");
    expect(result.error_category).toBe("permission");
    expect(result.error_fingerprint).toBe("error:FunctionsDeployFailedError:forbidden");
  });

  it("classifies a FunctionsDeployFailedError by its most severe cause in any order", () => {
    const forbidden = new FunctionsApiStatusError({ status: 403, message: "forbidden" });
    const unavailable = new FunctionsApiStatusError({ status: 503, message: "unavailable" });
    const expected = classifyCliErrorActionability(unavailable);
    for (const errors of [
      [forbidden, unavailable],
      [unavailable, forbidden],
    ]) {
      const result = classifyCliErrorActionability(new FunctionsDeployFailedError(errors, "x"));
      expect(result.error_kind).toBe("external_service");
      expect(result.error_category).toBe(expected.error_category);
      expect(result.error_fingerprint).toMatch(/^error:FunctionsDeployFailedError/u);
    }
  });

  it("does not let a user error mask an unclassified or internal cause", () => {
    class InternalCauseError extends Data.TaggedError("InternalCauseError")<{
      readonly message: string;
    }> {
      get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
        return actionability.internalPanic;
      }
    }
    const forbidden = new FunctionsApiStatusError({ status: 403, message: "forbidden" });
    const transport = new FunctionsApiTransportError({ message: "reset" });

    const unclassified = classifyCliErrorActionability(
      new FunctionsDeployFailedError([forbidden, transport, new Error("undeclared")], "x"),
    );
    expect(unclassified.error_kind).toBe("unknown");

    const internal = classifyCliErrorActionability(
      new FunctionsDeployFailedError(
        [forbidden, new Error("undeclared"), new InternalCauseError({ message: "bug" }), transport],
        "x",
      ),
    );
    expect(internal.error_kind).toBe("internal_bug");
    expect(internal.error_fingerprint).toMatch(/^error:FunctionsDeployFailedError/u);
  });

  it("classifies a FunctionsDeployFailedError without classified causes as unknown", () => {
    for (const errors of [[], [new Error("plain")]]) {
      const result = classifyCliErrorActionability(new FunctionsDeployFailedError(errors, "x"));
      expect(result.error_kind).toBe("unknown");
      expect(result.error_fingerprint).toMatch(/^error:FunctionsDeployFailedError/u);
    }
  });
});
