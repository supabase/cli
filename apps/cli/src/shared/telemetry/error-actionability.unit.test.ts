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

class DeclaredNoSuggestionError extends Data.TaggedError("DeclaredNoSuggestionError")<{
  readonly message: string;
  readonly suggestion?: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbFinding;
  }
}

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

  it("treats forbidden API statuses as account permission failures", () => {
    const forbidden = classifyCliErrorActionability(new DeclaredStatusError({ status: 403 }));
    expect(forbidden.error_kind).toBe("user_actionable");
    expect(forbidden.error_category).toBe("permission");
    expect(forbidden.error_fingerprint).toBe("tag:DeclaredStatusError:forbidden");

    const gated = classifyCliErrorActionability(
      new DeclaredStatusError({ status: 403, upgradeSuggested: true }),
    );
    expect(gated.error_category).toBe("plan_limit");

    const http = classifyCliErrorActionability({
      _tag: "HttpClientError",
      response: { status: 403 },
    });
    expect(http.error_category).toBe("permission");
  });

  it("classifies the preserved cause of stack wrapper errors", () => {
    const daemonDown = classifyCliErrorActionability({
      _tag: "StackBuildError",
      detail: "Failed to prepare stack assets",
      reason: "asset_preparation",
      cause: { _tag: "DockerPullError", image: "postgres", daemonDown: true },
    });
    expect(daemonDown.error_category).toBe("docker_not_running");
    expect(daemonDown.error_fingerprint).toBe("tag:DockerPullError:docker_not_running");

    const localFs = classifyCliErrorActionability({
      _tag: "DownloadError",
      url: "filesystem error for /cache",
      cause: { _tag: "PlatformError", reason: { _tag: "PermissionDenied" } },
    });
    expect(localFs.error_kind).toBe("user_actionable");
    expect(localFs.error_category).toBe("permission");

    // An unclassifiable cause keeps the wrapper's own bucket.
    const opaque = classifyCliErrorActionability({
      _tag: "DownloadError",
      url: "https://example.com",
      cause: new Error("boom"),
    });
    expect(opaque.error_kind).toBe("external_service");
    expect(opaque.error_category).toBe("network");
  });

  it("splits daemon start failures from other daemon RPC failures", () => {
    const start = classifyCliErrorActionability({
      _tag: "UnixHttpClientError",
      socketPath: "/tmp/daemon.sock",
      path: "/start",
    });
    expect(start.error_category).toBe("invalid_config");
    expect(start.suggested_command).toBe("supabase start");
    expect(start.error_fingerprint).toBe("tag:UnixHttpClientError:daemon_start");

    const status = classifyCliErrorActionability({
      _tag: "UnixHttpClientError",
      socketPath: "/tmp/daemon.sock",
      path: "/status",
    });
    expect(status.error_category).toBe("invalid_config");
    expect(status.suggested_command).toBe("supabase stop");
    expect(status.error_fingerprint).toBe("tag:UnixHttpClientError");
  });

  it("classifies API client configuration failures as token problems", () => {
    const result = classifyCliErrorActionability({
      _tag: "SupabaseApiConfigError",
      message: "Missing access token.",
    });
    expect(result.error_category).toBe("auth");
    expect(result.suggestion_type).toBe("set_env_var");
  });

  it("caps cause-chain recursion instead of overflowing on cycles", () => {
    const a: Record<string, unknown> = {
      _tag: "StackBuildError",
      detail: "x",
      reason: "asset_preparation",
    };
    const b: Record<string, unknown> = {
      _tag: "StackBuildError",
      detail: "y",
      reason: "asset_preparation",
      cause: a,
    };
    a["cause"] = b;
    const result = classifyCliErrorActionability(a);
    expect(result.error_kind).toBe("unknown");
    expect(result.error_fingerprint).toBe("error:CauseChainLimit");

    const self: Record<string, unknown> = { _tag: "UserError" };
    self["cause"] = self;
    expect(classifyCliErrorActionability(self).error_fingerprint).toBe("error:CauseChainLimit");
  });

  it("classifies the user config cause of a reason-less StackBuildError", () => {
    const result = classifyCliErrorActionability({
      _tag: "StackBuildError",
      detail: "Failed to configure Edge Functions",
      cause: { _tag: "ProjectConfigParseError", path: "supabase/config.toml" },
    });
    expect(result.error_category).toBe("invalid_config");
    expect(result.error_fingerprint).toBe("tag:ProjectConfigParseError");
  });

  it("keeps HTTP download causes in the download bucket", () => {
    // GitHub/CDN 401/403 during asset download must NOT hit the
    // Management-API auth/permission policy of the HttpClientError adapter.
    const forbidden = classifyCliErrorActionability({
      _tag: "DownloadError",
      url: "https://github.com/releases/x",
      cause: { _tag: "HttpClientError", response: { status: 403 } },
    });
    expect(forbidden.error_kind).toBe("external_service");
    expect(forbidden.error_category).toBe("network");
    expect(forbidden.error_fingerprint).toBe("tag:DownloadError");

    const localFs = classifyCliErrorActionability({
      _tag: "DownloadError",
      url: "filesystem error for /cache",
      cause: { _tag: "PlatformError", reason: { _tag: "PermissionDenied" } },
    });
    expect(localFs.error_category).toBe("permission");
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

  it("reconciles has_suggestion with an instance-level rendered suggestion", () => {
    const withSuggestion = classifyCliErrorActionability(
      new DeclaredNoSuggestionError({ message: "bad row", suggestion: "do X" }),
    );
    expect(withSuggestion.has_suggestion).toBe(true);

    const withoutSuggestion = classifyCliErrorActionability(
      new DeclaredNoSuggestionError({ message: "bad row" }),
    );
    expect(withoutSuggestion.has_suggestion).toBe(false);

    // A declaration-level true is never downgraded, even with no instance
    // suggestion field.
    const declaredTrue = classifyCliErrorActionability(new DeclaredError({ message: "x" }));
    expect(declaredTrue.has_suggestion).toBe(true);
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
