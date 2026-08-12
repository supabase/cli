import { Cause, Data } from "effect";
import { CliError } from "effect/unstable/cli";
import { describe, expect, it } from "vitest";
import { markSupabaseApiInputErrorAsUserInput, SupabaseApiInputError } from "@supabase/api/effect";
import { LegacyBootstrapHealthError } from "../../legacy/commands/bootstrap/bootstrap.errors.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  classifyCliCauseActionability,
  classifyCliErrorActionability,
  CliErrorActionabilityMetricDefinitions,
  ErrorActionabilityFingerprintId,
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
  readonly notFoundIsInvalidInput?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status, {
      upgradeSuggested: this.upgradeSuggested,
      notFoundIsInvalidInput: this.notFoundIsInvalidInput,
    });
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

class PlainDeclaredError extends Error {
  static readonly [ErrorActionabilityFingerprintId] = "PlainDeclaredError";

  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

class DeclarationCarrierError extends Error {
  readonly _tag: string;
  readonly declaration: Record<string, unknown>;

  constructor(tag: string, declaration: Record<string, unknown>) {
    super(tag);
    this._tag = tag;
    this.declaration = declaration;
  }

  get [ErrorActionabilityId](): Record<string, unknown> {
    return this.declaration;
  }
}

function declarationCarrier(tag: string, declaration: Record<string, unknown>) {
  return new DeclarationCarrierError(tag, declaration);
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

  it("uses a declared Error subclass constructor for an untagged fingerprint", () => {
    const result = classifyCliErrorActionability(new PlainDeclaredError("private path"));
    expect(result.error_category).toBe("invalid_config");
    expect(result.error_fingerprint).toBe("error:PlainDeclaredError");
  });

  it("prefers the declared static identifier over a native ancestor's prototype name", () => {
    // TypeError.prototype carries an own `name` data property ("TypeError");
    // without the static-identifier precedence, every declared class extending
    // a native Error subtype would collide on the native name.
    class NativeSubtypeDeclaredError extends TypeError {
      static readonly [ErrorActionabilityFingerprintId] = "NativeSubtypeDeclaredError";

      get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
        return actionability.invalidConfig;
      }
    }
    const result = classifyCliErrorActionability(new NativeSubtypeDeclaredError("boom"));
    expect(result.error_category).toBe("invalid_config");
    expect(result.error_fingerprint).toBe("error:NativeSubtypeDeclaredError");
  });

  it("classifies Effect's runtime unknown-subcommand tag without fingerprinting user input", () => {
    const secret = "customerProjectRef123";
    const result = classifyCliErrorActionability(
      new CliError.UnknownSubcommand({
        subcommand: secret,
        suggestions: [],
      }),
    );

    expect(result).toEqual({
      error_kind: "user_actionable",
      error_category: "invalid_input",
      error_fingerprint: "tag:UnknownSubcommand",
      has_suggestion: false,
      suggestion_type: "none",
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("classifies Effect's unexpected positional arguments without fingerprinting their values", () => {
    const secret = "/Users/alice/private.sql";
    const result = classifyCliErrorActionability(
      new CliError.UnexpectedArgument({ arguments: [secret] }),
    );

    expect(result).toEqual({
      error_kind: "user_actionable",
      error_category: "invalid_input",
      error_fingerprint: "tag:UnexpectedArgument",
      has_suggestion: false,
      suggestion_type: "none",
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("does not claim a generic remediation for local permission failures", () => {
    expect(actionability.permission).toEqual({
      error_kind: "user_actionable",
      error_category: "permission",
      has_suggestion: false,
      suggestion_type: "none",
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

    const notFound = classifyCliErrorActionability(new DeclaredStatusError({ status: 404 }));
    expect(notFound.error_kind).toBe("external_service");
    expect(notFound.error_category).toBe("api_status");
    expect(notFound.error_fingerprint).toBe("tag:DeclaredStatusError:api_status");

    const namedResourceNotFound = classifyCliErrorActionability(
      new DeclaredStatusError({ status: 404, notFoundIsInvalidInput: true }),
    );
    expect(namedResourceNotFound.error_kind).toBe("user_actionable");
    expect(namedResourceNotFound.error_category).toBe("invalid_input");
    expect(namedResourceNotFound.error_fingerprint).toBe("tag:DeclaredStatusError:not_found");

    const status = classifyCliErrorActionability(new DeclaredStatusError({ status: 500 }));
    expect(status.error_kind).toBe("external_service");
    expect(status.error_category).toBe("api_status");
    expect(status.error_fingerprint).toBe("tag:DeclaredStatusError:api_status");
  });

  it("classifies undeclared tagged errors as unknown with a sanitized fingerprint", () => {
    const result = classifyCliErrorActionability(new UndeclaredError({ message: "boom" }));
    expect(result.error_kind).toBe("unknown");
    expect(result.error_fingerprint).toBe("tag:unknown");
  });

  it.each([
    ["user_actionable", "auth"],
    ["user_actionable", "missing_project_ref"],
    ["user_actionable", "project_not_linked"],
    ["user_actionable", "docker_not_running"],
    ["user_actionable", "invalid_config"],
    ["user_actionable", "db_connection"],
    ["user_actionable", "migration_drift"],
    ["user_actionable", "permission"],
    ["user_actionable", "plan_limit"],
    ["user_actionable", "project_paused"],
    ["user_actionable", "invalid_input"],
    ["internal_bug", "panic"],
    ["internal_bug", "impossible_state"],
    ["external_service", "network"],
    ["external_service", "api_status"],
    ["user_cancelled", "cancelled"],
    ["unknown", "unknown"],
  ])("accepts the valid %s and %s taxonomy pair", (errorKind, errorCategory) => {
    const result = classifyCliErrorActionability(
      declarationCarrier("MatrixError", {
        error_kind: errorKind,
        error_category: errorCategory,
        has_suggestion: false,
        suggestion_type: "none",
      }),
    );
    expect(result.error_kind).toBe(errorKind);
    expect(result.error_category).toBe(errorCategory);
  });

  it.each([
    ["user_actionable", "panic"],
    ["internal_bug", "invalid_input"],
    ["external_service", "auth"],
    ["user_cancelled", "unknown"],
    ["unknown", "cancelled"],
  ])("rejects the invalid %s and %s taxonomy pair", (errorKind, errorCategory) => {
    const result = classifyCliErrorActionability(
      declarationCarrier("InvalidMatrixError", {
        error_kind: errorKind,
        error_category: errorCategory,
        has_suggestion: false,
        suggestion_type: "none",
      }),
    );
    expect(result.error_kind).toBe("unknown");
    expect(result.error_fingerprint).toBe("tag:unknown");
  });

  it("accepts a closed command remediation", () => {
    const result = classifyCliErrorActionability(
      declarationCarrier("RunCommandError", {
        error_kind: "user_actionable",
        error_category: "invalid_config",
        has_suggestion: true,
        suggestion_type: "run_command",
        suggested_command: "supabase start",
      }),
    );
    expect(result.suggestion_type).toBe("run_command");
    expect(result.suggested_command).toBe("supabase start");
  });

  it.each([
    [false, "login", undefined],
    [true, "none", undefined],
    [false, "none", "supabase login"],
  ])(
    "rejects inconsistent suggestion metadata (%s, %s, %s)",
    (hasSuggestion, suggestionType, suggestedCommand) => {
      const result = classifyCliErrorActionability(
        declarationCarrier("InvalidSuggestionError", {
          error_kind: "user_actionable",
          error_category: "auth",
          has_suggestion: hasSuggestion,
          suggestion_type: suggestionType,
          suggested_command: suggestedCommand,
        }),
      );
      expect(result.error_kind).toBe("unknown");
      expect(result).not.toHaveProperty("suggested_command");
    },
  );

  it("ignores a declaration whose symbol getter throws", () => {
    const secret = "token-from-throwing-getter";
    class ThrowingDeclarationError extends Error {
      readonly _tag = "ThrowingDeclarationError";

      get [ErrorActionabilityId]() {
        throw new Error(secret);
      }
    }
    const error = new ThrowingDeclarationError();
    const result = classifyCliErrorActionability(error);
    expect(result.error_kind).toBe("unknown");
    expect(result.error_fingerprint).toBe("tag:unknown");
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("falls back safely when even structural property access throws", () => {
    const secret = "token-from-hostile-proxy";
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error(secret);
        },
      },
    );
    const result = classifyCliErrorActionability(hostile);
    expect(result).toEqual({
      error_kind: "unknown",
      error_category: "unknown",
      has_suggestion: false,
      suggestion_type: "none",
      error_fingerprint: "error:ClassificationFailure",
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("rejects arbitrary declaration commands and fingerprint suffixes", () => {
    const commandSecret = "supabase login --token user-secret-token";
    const unsafeCommand = classifyCliErrorActionability(
      declarationCarrier("UnsafeCommandError", {
        error_kind: "user_actionable",
        error_category: "auth",
        has_suggestion: true,
        suggestion_type: "login",
        suggested_command: commandSecret,
      }),
    );
    expect(unsafeCommand.error_kind).toBe("unknown");
    expect(JSON.stringify(unsafeCommand)).not.toContain(commandSecret);

    const suffixSecret = "customer_project_reference";
    const unsafeSuffix = classifyCliErrorActionability(
      declarationCarrier("UnsafeSuffixError", {
        error_kind: "user_actionable",
        error_category: "invalid_input",
        has_suggestion: false,
        suggestion_type: "none",
        fingerprint_suffix: suffixSecret,
      }),
    );
    expect(unsafeSuffix.error_fingerprint).toBe("tag:unknown");
    expect(JSON.stringify(unsafeSuffix)).not.toContain(suffixSecret);
  });

  it("rejects a closed command paired with the wrong suggestion type", () => {
    const result = classifyCliErrorActionability(
      declarationCarrier("MismatchedSuggestionError", {
        error_kind: "user_actionable",
        error_category: "auth",
        has_suggestion: true,
        suggestion_type: "login",
        suggested_command: "supabase stop",
      }),
    );
    expect(result.error_kind).toBe("unknown");
    expect(result).not.toHaveProperty("suggested_command");
  });

  it("snapshots validated declaration fields before emitting them", () => {
    const secret = "supabase login --token later-secret";
    let reads = 0;
    const declaration = {
      error_kind: "user_actionable",
      error_category: "auth",
      has_suggestion: true,
      suggestion_type: "login",
      get suggested_command() {
        reads += 1;
        return reads === 1 ? "supabase login" : secret;
      },
    };
    const result = classifyCliErrorActionability(
      declarationCarrier("ChangingDeclarationError", declaration),
    );
    expect(result.suggested_command).toBe("supabase login");
    expect(reads).toBe(1);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("does not include sensitive error fields in classification output", () => {
    const secrets = [
      "/Users/alice/private/project/config.toml",
      "select * from private_table",
      "abcdefghijklmnopqrst",
      "db.customer.internal",
      "user-specific-project-ref",
    ];
    const result = classifyCliErrorActionability({
      _tag: "UndeclaredSensitiveError",
      message: secrets[0],
      sql: secrets[1],
      token: secrets[2],
      hostname: secrets[3],
      projectRef: secrets[4],
    });
    const encoded = JSON.stringify(result);
    for (const secret of secrets) expect(encoded).not.toContain(secret);
  });

  it("does not fingerprint an unknown tag that looks like an identifier", () => {
    const secret = "CustomerSecret123";
    const result = classifyCliErrorActionability({ _tag: secret });
    expect(result.error_fingerprint).toBe("tag:unknown");
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("does not trust an arbitrary declaration carrier as a fingerprint authority", () => {
    const secret = "CustomerProjectRef123";
    const plainResult = classifyCliErrorActionability({
      _tag: secret,
      [ErrorActionabilityId]: actionability.invalidInput,
    });
    expect(plainResult.error_fingerprint).toBe("tag:unknown");

    const errorResult = classifyCliErrorActionability(
      declarationCarrier(secret, actionability.invalidInput),
    );
    expect(errorResult.error_fingerprint).toBe("error:DeclaredError");
    expect(JSON.stringify([plainResult, errorResult])).not.toContain(secret);
  });

  it("does not trust mutable instance tags or names over the tagged prototype", () => {
    const secret = "CustomerProjectRef123";
    const error = new DeclaredError({ message: "failed" });
    Reflect.set(error, "_tag", secret);
    Reflect.set(error, "name", secret);

    const result = classifyCliErrorActionability(error);
    expect(result.error_fingerprint).toBe("error:DeclaredError");
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("does not accept declarations through the global symbol registry", () => {
    const secret = "CustomerProjectRef123";
    const globalDeclarationKey = Symbol.for("@supabase/cli/telemetry/ErrorActionability");
    class HostileDeclaredError extends Error {
      readonly _tag = secret;

      get [globalDeclarationKey](): CliErrorActionabilityDeclaration {
        return actionability.invalidInput;
      }
    }
    Object.defineProperty(HostileDeclaredError, "name", { value: secret });

    const result = classifyCliErrorActionability(new HostileDeclaredError(secret));
    expect(result.error_fingerprint).toBe("tag:unknown");
    expect(JSON.stringify(result)).not.toContain(secret);
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

    const dockerNotRunning = classifyCliErrorActionability({
      _tag: "StackBuildError",
      detail: "Failed to prepare stack assets",
      reason: "docker_not_running",
    });
    expect(dockerNotRunning.error_category).toBe("docker_not_running");
    expect(dockerNotRunning.error_fingerprint).toBe("tag:StackBuildError:docker_not_running");

    const internal = classifyCliErrorActionability({ _tag: "StackBuildError", detail: "bug" });
    expect(internal.error_kind).toBe("internal_bug");
    expect(internal.error_category).toBe("impossible_state");
    expect(internal.error_fingerprint).toBe("tag:StackBuildError:internal_build");
  });

  it("classifies stack readiness and state-claim failures without reading details", () => {
    const readiness = classifyCliErrorActionability({
      _tag: "StackReadinessError",
      target: "auth",
      timeoutMs: 10,
      detail: "private runtime detail",
    });
    expect(readiness.error_category).toBe("invalid_config");
    expect(readiness.suggestion_type).toBe("run_command");
    expect(readiness.suggested_command).toBe("supabase start");

    const claimed = classifyCliErrorActionability({
      _tag: "StateClaimError",
      reason: "already-claimed",
      path: "/private/state.json",
    });
    expect(claimed.suggested_command).toBe("supabase stop");
    expect(claimed.suggestion_type).toBe("run_command");
    expect(claimed.error_fingerprint).toBe("tag:StateClaimError:conflict");

    const filesystem = classifyCliErrorActionability({
      _tag: "StateClaimError",
      reason: "io-error",
      path: "/private/state.json",
    });
    expect(filesystem.error_category).toBe("permission");
    expect(filesystem.has_suggestion).toBe(false);
    expect(filesystem.error_fingerprint).toBe("tag:StateClaimError:filesystem");
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

    const notFound = classifyCliErrorActionability({
      _tag: "HttpClientError",
      response: { status: 404 },
    });
    expect(notFound.error_kind).toBe("external_service");
    expect(notFound.error_category).toBe("api_status");
    expect(notFound.error_fingerprint).toBe("tag:HttpClientError:api_status");

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

    for (const reason of ["DecodeError", "EmptyBodyError"]) {
      const decode = classifyCliErrorActionability({
        _tag: "HttpClientError",
        reason: { _tag: reason },
        response: { status: 200 },
      });
      expect(decode.error_category).toBe("api_status");
      expect(decode.error_fingerprint).toBe("tag:HttpClientError:api_response");
    }
  });

  it("classifies a stopped external stack through its static adapter", () => {
    const result = classifyCliErrorActionability({
      _tag: "StackNotRunningError",
      statePath: "/private/project/.temp/stack.json",
    });
    expect(result.error_kind).toBe("user_actionable");
    expect(result.error_category).toBe("invalid_config");
    expect(result.suggested_command).toBe("supabase start");
    expect(JSON.stringify(result)).not.toContain("/private/project");
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

  // Managed registry errors are plain `Error` subclasses that rename themselves
  // and carry no `_tag`, so `code` is the only thing routing them to their
  // adapter. `managed-model.unit.test.ts` in `@supabase/stack` pins the real
  // classes to the (name, code) pairs reproduced here.
  it.each([
    [
      "InvalidManagedIdentityError",
      "INVALID_MANAGED_IDENTITY",
      "managed_identity",
      "invalid_input",
    ],
    ["InvalidManagedPortError", "MANAGED_INVALID_PORT", "managed_port", "invalid_config"],
    [
      "UnsafeManagedStackPathError",
      "UNSAFE_MANAGED_STACK_PATH",
      "bad_argument",
      "impossible_state",
    ],
    // The operation pid and the pending-update guard are both internal
    // invariants: the CLI supplies the pid, and only repository misuse can
    // update an unpublished row.
    [
      "InvalidManagedOwnerPidError",
      "MANAGED_INVALID_OWNER_PID",
      "managed_owner_pid",
      "impossible_state",
    ],
    [
      "ManagedPendingStackUpdateError",
      "MANAGED_PENDING_STACK_UPDATE",
      "managed_pending_update",
      "impossible_state",
    ],
    // Each of these five used to share a suffix with an unrelated failure, so
    // distinct defects grouped together as repeats (CLI-2106).
    [
      "ManagedOperationInProgressError",
      "MANAGED_OPERATION_IN_PROGRESS",
      "managed_operation_in_progress",
      "invalid_config",
    ],
    [
      "ManagedOperationOwnershipError",
      "MANAGED_OPERATION_OWNERSHIP_MISMATCH",
      "managed_operation_ownership",
      "invalid_config",
    ],
    [
      "ManagedStackPublicationTimeoutError",
      "MANAGED_STACK_PUBLICATION_TIMEOUT",
      "managed_publication_timeout",
      "invalid_config",
    ],
    [
      "ManagedStackNotStoppedError",
      "MANAGED_STACK_NOT_STOPPED",
      "managed_stack_not_stopped",
      "invalid_config",
    ],
    [
      "ManagedRunningStackPortChangeError",
      "MANAGED_RUNNING_STACK_PORT_CHANGE",
      "managed_port_change",
      "invalid_config",
    ],
  ])("classifies %s by its stable managed code", (name, code, suffix, category) => {
    const error = new Error("managed registry failure");
    error.name = name;
    Object.defineProperty(error, "code", { value: code });
    const result = classifyCliErrorActionability(error);
    expect(result.error_category).toBe(category);
    expect(result.error_fingerprint).toBe(`error:ManagedStackError:${suffix}`);
  });

  it("leaves an unrecognized managed-shaped code unclassified", () => {
    const unrecognized = new Error("managed failure");
    unrecognized.name = "ManagedFutureError";
    Object.defineProperty(unrecognized, "code", { value: "MANAGED_FUTURE_FAILURE" });
    expect(classifyCliErrorActionability(unrecognized).error_kind).toBe("unknown");
  });

  // ManagedStackInitializationError wraps the real provisioning failure in
  // `cause`; reporting the generic initialization verdict would lose it.
  it("classifies the provisioning cause of a managed initialization failure", () => {
    const wrapped = new Error("managed stack initialization failed");
    wrapped.name = "ManagedStackInitializationError";
    Object.defineProperty(wrapped, "code", { value: "MANAGED_STACK_INITIALIZATION_FAILED" });
    Object.defineProperty(wrapped, "cause", {
      value: { _tag: "DockerPullError", image: "postgres", daemonDown: true },
    });
    expect(classifyCliErrorActionability(wrapped)).toEqual(
      classifyCliErrorActionability({
        _tag: "DockerPullError",
        image: "postgres",
        daemonDown: true,
      }),
    );
  });

  it("falls back to the managed initialization verdict for an opaque cause", () => {
    const wrapped = new Error("managed stack initialization failed");
    wrapped.name = "ManagedStackInitializationError";
    Object.defineProperty(wrapped, "code", { value: "MANAGED_STACK_INITIALIZATION_FAILED" });
    Object.defineProperty(wrapped, "cause", { value: { detail: "opaque" } });
    const result = classifyCliErrorActionability(wrapped);
    expect(result.error_kind).toBe("user_actionable");
    expect(result.suggested_command).toBe("supabase start");
    expect(result.error_fingerprint).toBe("error:ManagedStackError:managed_initialization");
  });

  it("classifies a managed cause nested inside a stack wrapper", () => {
    const managed = new Error("port already reserved");
    managed.name = "ManagedPortReservationError";
    Object.defineProperty(managed, "code", { value: "MANAGED_PORT_ALREADY_RESERVED" });
    const result = classifyCliErrorActionability({
      _tag: "StackBuildError",
      detail: "x",
      cause: managed,
    });
    expect(result.error_category).toBe("invalid_config");
    expect(result.error_fingerprint).toBe("error:ManagedStackError:port_conflict");
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

  it("classifies a native exception wrapped by StackError as an internal bug", () => {
    const wrapped = new Error("boom");
    wrapped.name = "StackError";
    Object.defineProperty(wrapped, "code", { value: "UNKNOWN" });
    Object.defineProperty(wrapped, "cause", { value: new TypeError("x is not a function") });
    const result = classifyCliErrorActionability(wrapped);
    expect(result.error_kind).toBe("internal_bug");
    expect(result.error_category).toBe("panic");
    expect(result.error_fingerprint).toBe("error:TypeError");
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

  it.each([
    ["PermissionDenied", "user_actionable", "permission", "tag:PlatformError:filesystem"],
    ["NotFound", "user_actionable", "invalid_input", "tag:PlatformError:not_found"],
    ["TimedOut", "unknown", "unknown", "tag:PlatformError:platform_error"],
    ["Unknown", "unknown", "unknown", "tag:PlatformError:platform_error"],
  ])(
    "classifies PlatformError reason %s without conflating it with permissions",
    (reason, errorKind, errorCategory, errorFingerprint) => {
      const result = classifyCliErrorActionability({
        _tag: "PlatformError",
        reason: { _tag: reason },
      });
      expect(result.error_kind).toBe(errorKind);
      expect(result.error_category).toBe(errorCategory);
      expect(result.error_fingerprint).toBe(errorFingerprint);
    },
  );

  it("splits daemon start failures from other daemon RPC failures", () => {
    const start = classifyCliErrorActionability({
      _tag: "UnixHttpClientError",
      socketPath: "/tmp/daemon.sock",
      path: "/start",
      reason: "transport",
    });
    expect(start.error_category).toBe("invalid_config");
    expect(start.suggested_command).toBe("supabase start");
    expect(start.error_fingerprint).toBe("tag:UnixHttpClientError:daemon_start");

    const status = classifyCliErrorActionability({
      _tag: "UnixHttpClientError",
      socketPath: "/tmp/daemon.sock",
      path: "/status",
      reason: "transport",
    });
    expect(status.error_category).toBe("invalid_config");
    expect(status.suggested_command).toBe("supabase stop");
    expect(status.error_fingerprint).toBe("tag:UnixHttpClientError:daemon_transport");
  });

  it("keeps daemon status and protocol failures in the internal-bug bucket", () => {
    for (const [reason, suffix] of [
      ["status", "daemon_status"],
      ["protocol", "daemon_protocol"],
    ] as const) {
      const result = classifyCliErrorActionability({
        _tag: "UnixHttpClientError",
        path: "/status",
        reason,
      });
      expect(result.error_kind).toBe("internal_bug");
      expect(result.error_category).toBe("impossible_state");
      expect(result.error_fingerprint).toBe(`tag:UnixHttpClientError:${suffix}`);
    }
  });

  it("does not claim daemon startup failures are recoverable stack config", () => {
    const result = classifyCliErrorActionability({ _tag: "DaemonStartError" });
    expect(result.error_kind).toBe("unknown");
    expect(result.error_category).toBe("unknown");
  });

  it("classifies API client configuration failures as token problems", () => {
    const result = classifyCliErrorActionability({
      _tag: "SupabaseApiConfigError",
      message: "Missing access token.",
    });
    expect(result.error_category).toBe("auth");
    expect(result.suggestion_type).toBe("set_env_var");
  });

  it("classifies API input-schema rejections from typed provenance", () => {
    const generated = new SupabaseApiInputError("private generated schema details");
    const generatedResult = classifyCliErrorActionability(generated);
    expect(generatedResult.error_kind).toBe("internal_bug");
    expect(generatedResult.error_category).toBe("impossible_state");
    expect(generatedResult.error_fingerprint).toBe("tag:SupabaseApiInputError:request_encoding");
    expect(JSON.stringify(generatedResult)).not.toContain("private generated schema details");

    const userInput = new SupabaseApiInputError("private user schema details");
    expect(markSupabaseApiInputErrorAsUserInput(userInput)).toBe(userInput);
    const userResult = classifyCliErrorActionability(userInput);
    expect(userResult.error_kind).toBe("user_actionable");
    expect(userResult.error_category).toBe("invalid_input");
    expect(userResult.error_fingerprint).toBe("tag:SupabaseApiInputError:request_input");
    expect(JSON.stringify(userResult)).not.toContain("private user schema details");
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

  it("keeps a local stack schema failure in the invalid-config bucket", () => {
    const result = classifyCliErrorActionability({
      _tag: "StackBuildError",
      detail: "Invalid Edge Functions bundle",
      reason: "invalid_config",
      cause: { _tag: "SchemaError", issue: "private local config details" },
    });
    expect(result.error_kind).toBe("user_actionable");
    expect(result.error_category).toBe("invalid_config");
    expect(result.error_fingerprint).toBe("tag:StackBuildError:invalid_config");
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
    expect(result.error_fingerprint).toBe("tag:unknown");
  });

  it("buckets native JS exceptions as internal panics", () => {
    const result = classifyCliErrorActionability(new TypeError("x is not a function"));
    expect(result.error_kind).toBe("internal_bug");
    expect(result.error_category).toBe("panic");
    expect(result.error_fingerprint).toBe("error:TypeError");
  });

  it("does not inspect raw instance-level suggestion text", () => {
    const secret = "run --token user-secret-token";
    const withSuggestion = classifyCliErrorActionability(
      new DeclaredNoSuggestionError({ message: "bad row", suggestion: secret }),
    );
    expect(withSuggestion.has_suggestion).toBe(false);
    expect(withSuggestion.suggestion_type).toBe("none");
    expect(JSON.stringify(withSuggestion)).not.toContain(secret);

    const withoutSuggestion = classifyCliErrorActionability(
      new DeclaredNoSuggestionError({ message: "bad row" }),
    );
    expect(withoutSuggestion.has_suggestion).toBe(false);
  });

  it("never leaks raw text into fingerprints for unknown failures", () => {
    expect(classifyCliErrorActionability("raw failure text").error_fingerprint).toBe(
      "string:unknown",
    );
    const named = new Error("boom");
    named.name = "CustomerSecret123";
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
    expect(CliErrorActionabilityMetricDefinitions.internalUnknownBugRate.denominator).toBe(
      "count where exit_code != 0 AND error_kind IS NOT NULL",
    );
    expect(CliErrorActionabilityMetricDefinitions.classificationCoverage.id).toBe(
      "failed_commands_with_classification",
    );
    expect(CliErrorActionabilityMetricDefinitions.classificationCoverage.numerator).toBe(
      "count where exit_code != 0 AND error_kind IS NOT NULL",
    );
    expect(CliErrorActionabilityMetricDefinitions.classificationCoverage.denominator).toBe(
      "count where exit_code != 0",
    );
    expect(CliErrorActionabilityMetricDefinitions.strictRecovery.partition_by).toEqual([
      "device_id",
      "$session_id",
      "command",
    ]);
    expect(CliErrorActionabilityMetricDefinitions.strictRecovery.eligible_failure).toBe(
      "exit_code != 0 AND error_kind = 'user_actionable'",
    );
    expect(CliErrorActionabilityMetricDefinitions.strictRecovery.recovered_when).toContain(
      "S.device_id = F.device_id, S.$session_id = F.$session_id, and S.command = F.command",
    );
    expect(CliErrorActionabilityMetricDefinitions.repeatError.partition_by).toEqual([
      "device_id",
      "$session_id",
      "command",
    ]);
    expect(CliErrorActionabilityMetricDefinitions.repeatError.eligible_failure).toBe(
      "exit_code != 0 AND error_kind = 'user_actionable' AND error_fingerprint IS NOT NULL",
    );
    expect(CliErrorActionabilityMetricDefinitions.repeatError.repeated_when).toContain(
      "P.error_fingerprint = F.error_fingerprint",
    );
    expect(CliErrorActionabilityMetricDefinitions.repeatError.reset_when).toContain(
      "clears every prior fingerprint",
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

  it("gives defects precedence over typed failures in a combined cause", () => {
    const cause = Cause.combine(
      Cause.fail(new DeclaredError({ message: "recoverable" })),
      Cause.die(new TypeError("boom")),
    );
    expect(classifyCliCauseActionability(cause)).toMatchObject({
      error_kind: "internal_bug",
      error_category: "panic",
      error_fingerprint: "error:TypeError",
    });
  });

  it("preserves a known tagged defect's structured classification", () => {
    const cause = Cause.die({
      _tag: "UnixHttpClientError",
      path: "/status",
      reason: "protocol",
    });
    expect(classifyCliCauseActionability(cause)).toMatchObject({
      error_kind: "internal_bug",
      error_category: "impossible_state",
      error_fingerprint: "tag:UnixHttpClientError:daemon_protocol",
    });
  });

  it("does not let an earlier known defect hide a later panic", () => {
    const cause = Cause.combine(
      Cause.die({ _tag: "UnixHttpClientError", path: "/start", reason: "transport" }),
      Cause.die(new TypeError("boom")),
    );
    expect(classifyCliCauseActionability(cause)).toMatchObject({
      error_kind: "internal_bug",
      error_category: "panic",
      error_fingerprint: "error:TypeError",
    });
  });

  it("classifies interrupt-only causes as user cancellation", () => {
    expect(classifyCliCauseActionability(Cause.interrupt(42))).toEqual({
      error_kind: "user_cancelled",
      error_category: "cancelled",
      has_suggestion: false,
      suggestion_type: "none",
      error_fingerprint: "error:Interrupt",
    });
  });
});

describe("LegacyBootstrapHealthError actionability", () => {
  it("classifies a non-200 health poll on the status-code policy", () => {
    const result = classifyCliErrorActionability(
      new LegacyBootstrapHealthError({ message: "Error status 500: boom", status: 500 }),
    );
    expect(result.error_category).toBe("api_status");
  });

  it("classifies a 200 the generated client could not decode as an api-response problem", () => {
    const result = classifyCliErrorActionability(
      new LegacyBootstrapHealthError({ message: "Error status 0: boom", decode: true }),
    );
    expect(result.error_kind).toBe("external_service");
    expect(result.error_category).toBe("api_status");
    expect(result.error_fingerprint).toBe("tag:LegacyBootstrapHealthError:api_response");
  });

  it("classifies a responseless health poll failure as network", () => {
    const result = classifyCliErrorActionability(
      new LegacyBootstrapHealthError({ message: "Error status 0: boom", transport: true }),
    );
    expect(result.error_kind).toBe("external_service");
    expect(result.error_category).toBe("network");
    expect(result.error_fingerprint).toBe("tag:LegacyBootstrapHealthError:network");
  });

  it("falls back to the api-status policy for an unhealthy service report", () => {
    const result = classifyCliErrorActionability(
      new LegacyBootstrapHealthError({ message: "Service not healthy: db (unhealthy)" }),
    );
    expect(result.error_category).toBe("api_status");
  });
});
