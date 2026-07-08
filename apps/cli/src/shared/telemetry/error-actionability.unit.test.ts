import { Cause, Data } from "effect";
import { describe, expect, it } from "vitest";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  classifyCliCauseActionability,
  classifyCliErrorActionability,
  CliErrorActionabilityMetricDefinitions,
  ErrorActionabilityId,
  statusCodeActionability,
} from "./error-actionability.ts";

class DeclaredError extends Data.TaggedError("DeclaredError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.authLogin;
  }
}

class DeclaredStatusError extends Data.TaggedError("DeclaredStatusError")<{
  readonly status: number;
  readonly upgradeSuggested?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status, { upgradeSuggested: this.upgradeSuggested });
  }
}

class UndeclaredError extends Data.TaggedError("UndeclaredError")<{
  readonly message: string;
}> {}

describe("classifyCliErrorActionability", () => {
  it("uses the declaration co-located on the error class", () => {
    expect(
      classifyCliErrorActionability(new DeclaredError({ message: "raw secret text" })),
    ).toEqual({
      error_kind: "user_actionable",
      error_category: "auth",
      error_fingerprint: "tag:DeclaredError",
      has_suggestion: true,
      suggestion_type: "login",
      suggested_command: "supabase login",
    });
  });

  it("lets instance-dependent declarations branch on typed fields", () => {
    const auth = classifyCliErrorActionability(new DeclaredStatusError({ status: 401 }));
    expect(auth.error_category).toBe("auth");
    expect(auth.error_fingerprint).toBe("tag:DeclaredStatusError:auth");

    const gated = classifyCliErrorActionability(
      new DeclaredStatusError({ status: 404, upgradeSuggested: true }),
    );
    expect(gated.error_category).toBe("plan_limit");
    expect(gated.suggestion_type).toBe("upgrade_plan");
    expect(gated.error_fingerprint).toBe("tag:DeclaredStatusError:plan_limit");

    const status = classifyCliErrorActionability(new DeclaredStatusError({ status: 500 }));
    expect(status.error_kind).toBe("external_service");
    expect(status.error_category).toBe("api_status");
    expect(status.error_fingerprint).toBe("tag:DeclaredStatusError:api_status");
  });

  it("classifies undeclared tagged errors as unknown with a sanitized fingerprint", () => {
    const result = classifyCliErrorActionability(new UndeclaredError({ message: "boom" }));
    expect(result.error_kind).toBe("unknown");
    expect(result.error_fingerprint).toBe("tag:UndeclaredError");
  });

  it("classifies external stack build errors by structured reason", () => {
    const invalidConfig = classifyCliErrorActionability({
      _tag: "StackBuildError",
      detail: "imgproxy requires storage to be enabled",
      reason: "invalid_config",
    });
    expect(invalidConfig.error_category).toBe("invalid_config");
    expect(invalidConfig.error_fingerprint).toBe("tag:StackBuildError:invalid_config");

    const assetPreparation = classifyCliErrorActionability({
      _tag: "StackBuildError",
      detail: "Failed to prepare stack assets",
      reason: "asset_preparation",
    });
    expect(assetPreparation.error_kind).toBe("external_service");
    expect(assetPreparation.error_fingerprint).toBe("tag:StackBuildError:asset_preparation");

    const internal = classifyCliErrorActionability({ _tag: "StackBuildError", detail: "bug" });
    expect(internal.error_kind).toBe("internal_bug");
    expect(internal.error_category).toBe("impossible_state");
    expect(internal.error_fingerprint).toBe("tag:StackBuildError:internal_build");
  });

  it("splits docker pull failures from a stopped docker daemon", () => {
    const daemonDown = classifyCliErrorActionability({
      _tag: "DockerPullError",
      image: "postgres",
      daemonDown: true,
    });
    expect(daemonDown.error_category).toBe("docker_not_running");
    expect(daemonDown.suggestion_type).toBe("start_docker");

    const pull = classifyCliErrorActionability({ _tag: "DockerPullError", image: "postgres" });
    expect(pull.error_kind).toBe("external_service");
    expect(pull.error_fingerprint).toBe("tag:DockerPullError:registry_pull");
  });

  it("classifies http client errors by response presence and status", () => {
    const auth = classifyCliErrorActionability({
      _tag: "HttpClientError",
      response: { status: 401 },
    });
    expect(auth.error_category).toBe("auth");

    const status = classifyCliErrorActionability({
      _tag: "HttpClientError",
      response: { status: 503 },
    });
    expect(status.error_category).toBe("api_status");

    const transport = classifyCliErrorActionability({
      _tag: "HttpClientError",
      reason: { _tag: "TransportError" },
    });
    expect(transport.error_category).toBe("network");
  });

  it("recurses into single-error ShowHelp wrappers", () => {
    const single = classifyCliErrorActionability({
      _tag: "ShowHelp",
      errors: [new DeclaredError({ message: "inner" })],
    });
    expect(single.error_fingerprint).toBe("tag:DeclaredError");

    const multiple = classifyCliErrorActionability({
      _tag: "ShowHelp",
      errors: [{ _tag: "MissingOption" }, { _tag: "MissingOption" }],
    });
    expect(multiple.error_category).toBe("invalid_input");
    expect(multiple.error_fingerprint).toBe("tag:ShowHelp");
  });

  it("classifies StackError port allocation failures", () => {
    const error = new Error("no free port");
    error.name = "StackError";
    Object.defineProperty(error, "code", { value: "PORT_ALLOCATION" });
    const result = classifyCliErrorActionability(error);
    expect(result.error_category).toBe("invalid_config");
    expect(result.error_fingerprint).toBe("error:StackError:port_allocation");

    const other = new Error("other");
    other.name = "StackError";
    expect(classifyCliErrorActionability(other).error_kind).toBe("unknown");
  });

  it("classifies the preserved tagged cause of a StackError wrapper", () => {
    const wrapped = new Error("stack failure");
    wrapped.name = "StackError";
    Object.defineProperty(wrapped, "code", { value: "BUILD_ERROR" });
    Object.defineProperty(wrapped, "cause", {
      value: { _tag: "StackBuildError", detail: "x", reason: "invalid_config" },
    });
    const result = classifyCliErrorActionability(wrapped);
    expect(result.error_category).toBe("invalid_config");
    expect(result.error_fingerprint).toBe("tag:StackBuildError:invalid_config");
  });

  it("does not treat Object.prototype members as external adapters", () => {
    const result = classifyCliErrorActionability({ _tag: "constructor" });
    expect(result.error_kind).toBe("unknown");
    expect(result.error_fingerprint).toBe("tag:constructor");
  });

  it("buckets native JS exceptions as internal panics", () => {
    const result = classifyCliErrorActionability(new TypeError("x is not a function"));
    expect(result.error_kind).toBe("internal_bug");
    expect(result.error_category).toBe("panic");
    expect(result.error_fingerprint).toBe("error:TypeError");
  });

  it("never leaks raw text into fingerprints for unknown failures", () => {
    expect(classifyCliErrorActionability("raw failure text").error_fingerprint).toBe(
      "string:unknown",
    );
    const named = new Error("boom");
    named.name = "Weird Name With Spaces";
    expect(classifyCliErrorActionability(named).error_fingerprint).toBe("error:unknown");
  });
});

describe("metric definitions", () => {
  it("keeps the Q2 baseline definitions stable for reporting queries", () => {
    // These ids are referenced by the PostHog reporting built in CLI-1562;
    // changing them invalidates the Q2 baseline and must be deliberate.
    expect(CliErrorActionabilityMetricDefinitions.strictRecovery.id).toBe(
      "same_command_success_same_session",
    );
    expect(CliErrorActionabilityMetricDefinitions.repeatError.id).toBe(
      "same_command_same_error_same_session_before_success",
    );
    expect(CliErrorActionabilityMetricDefinitions.internalUnknownBugRate.id).toBe(
      "failed_commands_internal_bug_or_unknown",
    );
  });
});

describe("classifyCliCauseActionability", () => {
  it("classifies the typed failure inside a cause", () => {
    const cause = Cause.fail(new DeclaredError({ message: "inner" }));
    expect(classifyCliCauseActionability(cause).error_category).toBe("auth");
  });

  it("classifies defects", () => {
    const cause = Cause.die(new TypeError("boom"));
    expect(classifyCliCauseActionability(cause).error_category).toBe("panic");
  });
});
