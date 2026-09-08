import { Cause, Data } from "effect";
import { CliError } from "effect/unstable/cli";
import { describe, expect, it } from "vitest";
import { SupabaseApiInputError, markSupabaseApiInputErrorAsUserInput } from "@supabase/api/effect";
import { BootstrapHealthError } from "../../commands/bootstrap/bootstrap.errors.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  classifyCliCauseActionability,
  classifyCliErrorActionability,
  ErrorActionabilityFingerprintId,
  ErrorActionabilityId,
  statusCodeActionability,
} from "./error-actionability.ts";

class DeclaredError extends Data.TaggedError("DeclaredError")<{ readonly message: string }> {
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
    return statusCodeActionability(this.status, this);
  }
}

class PlainDeclaredError extends Error {
  static readonly [ErrorActionabilityFingerprintId] = "PlainDeclaredError";

  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

class UndeclaredError extends Data.TaggedError("UndeclaredError")<{ readonly message: string }> {}

function externalError(
  _tag: string,
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  return { _tag, ...fields };
}

describe("classifyCliErrorActionability", () => {
  it("uses co-located declarations and stable fingerprints", () => {
    expect(classifyCliErrorActionability(new DeclaredError({ message: "private" }))).toEqual({
      error_kind: "user_actionable",
      error_category: "auth",
      error_fingerprint: "tag:DeclaredError",
      has_suggestion: true,
      suggestion_type: "login",
      suggested_command: "supabase login",
    });
    expect(classifyCliErrorActionability(new PlainDeclaredError("private")).error_fingerprint).toBe(
      "error:PlainDeclaredError",
    );
  });

  it("preserves native Error subclass identifiers after minification", () => {
    class NativeSubtype extends TypeError {
      static readonly [ErrorActionabilityFingerprintId] = "NativeSubtype";
      get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
        return actionability.invalidConfig;
      }
    }
    expect(classifyCliErrorActionability(new NativeSubtype("boom")).error_fingerprint).toBe(
      "error:NativeSubtype",
    );
  });

  it("classifies parser failures without including user input", () => {
    const secret = "/Users/alice/private.sql";
    const unknown = classifyCliErrorActionability(
      new CliError.UnknownSubcommand({ subcommand: "secret-project", suggestions: [] }),
    );
    const argument = classifyCliErrorActionability(
      new CliError.UnexpectedArgument({ arguments: [secret] }),
    );
    expect(unknown.error_fingerprint).toBe("tag:UnknownSubcommand");
    expect(argument.error_fingerprint).toBe("tag:UnexpectedArgument");
    expect(JSON.stringify([unknown, argument])).not.toContain(secret);
  });

  it("applies typed status policies", () => {
    expect(
      classifyCliErrorActionability(new DeclaredStatusError({ status: 401 })).error_category,
    ).toBe("auth");
    expect(
      classifyCliErrorActionability(
        new DeclaredStatusError({ status: 404, upgradeSuggested: true }),
      ).error_category,
    ).toBe("plan_limit");
    expect(
      classifyCliErrorActionability(
        new DeclaredStatusError({ status: 404, notFoundIsInvalidInput: true }),
      ).error_category,
    ).toBe("invalid_input");
    expect(
      classifyCliErrorActionability(new DeclaredStatusError({ status: 500 })).error_category,
    ).toBe("api_status");
    expect(statusCodeActionability(undefined).error_category).toBe("network");
  });

  it("rejects malformed declarations and arbitrary remediation text", () => {
    class InvalidDeclaration extends Error {
      get [ErrorActionabilityId]() {
        return {
          error_kind: "user_actionable",
          error_category: "auth",
          has_suggestion: true,
          suggestion_type: "login",
          suggested_command: "supabase login --token secret",
        };
      }
    }
    const result = classifyCliErrorActionability(new InvalidDeclaration());
    expect(result.error_kind).toBe("unknown");
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("handles hostile declarations and unknown failures safely", () => {
    const secret = "customer-project-ref";
    class HostileError extends Error {
      get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
        throw new Error(secret);
      }
    }
    const hostile = classifyCliErrorActionability(new HostileError());
    expect(hostile.error_fingerprint).toBe("error:unknown");
    expect(JSON.stringify(hostile)).not.toContain(secret);
    expect(
      classifyCliErrorActionability(new UndeclaredError({ message: secret })).error_fingerprint,
    ).toBe("tag:unknown");
    expect(classifyCliErrorActionability(new TypeError("boom")).error_category).toBe("panic");
  });

  it("classifies retained external API and filesystem errors by structured fields", () => {
    expect(
      classifyCliErrorActionability(externalError("SupabaseApiConfigError")).suggestion_type,
    ).toBe("set_env_var");
    const generated = new SupabaseApiInputError("private schema details");
    expect(classifyCliErrorActionability(generated).error_fingerprint).toBe(
      "tag:SupabaseApiInputError:request_encoding",
    );
    expect(
      classifyCliErrorActionability(
        markSupabaseApiInputErrorAsUserInput(new SupabaseApiInputError("private")),
      ).error_fingerprint,
    ).toBe("tag:SupabaseApiInputError:request_input");
    expect(
      classifyCliErrorActionability(
        externalError("PlatformError", { reason: { _tag: "PermissionDenied" } }),
      ).error_category,
    ).toBe("permission");
    expect(
      classifyCliErrorActionability(
        externalError("PlatformError", { reason: { _tag: "NotFound" } }),
      ).error_category,
    ).toBe("invalid_input");
    expect(
      classifyCliErrorActionability(externalError("HttpClientError", { response: { status: 403 } }))
        .error_category,
    ).toBe("permission");
    expect(classifyCliErrorActionability(externalError("HttpClientError")).error_category).toBe(
      "network",
    );
  });

  it("unwraps command help and user-error wrappers", () => {
    const secret = "private value";
    const help = classifyCliErrorActionability({
      _tag: "ShowHelp",
      errors: [new DeclaredError({ message: secret })],
    });
    const user = classifyCliErrorActionability({
      _tag: "UserError",
      cause: new DeclaredError({ message: secret }),
    });
    expect(help.error_category).toBe("auth");
    expect(user.error_category).toBe("auth");
    expect(JSON.stringify([help, user])).not.toContain(secret);
  });

  it("classifies bootstrap health failures with their typed cause", () => {
    expect(
      classifyCliErrorActionability(new BootstrapHealthError({ message: "failed", status: 500 }))
        .error_category,
    ).toBe("api_status");
    expect(
      classifyCliErrorActionability(new BootstrapHealthError({ message: "failed", decode: true }))
        .error_fingerprint,
    ).toBe("tag:BootstrapHealthError:api_response");
    expect(
      classifyCliErrorActionability(
        new BootstrapHealthError({ message: "failed", transport: true }),
      ).error_category,
    ).toBe("network");
  });
});

describe("classifyCliCauseActionability", () => {
  it("classifies known defects, internal defects, and cancellation", () => {
    expect(
      classifyCliCauseActionability(Cause.fail(new DeclaredError({ message: "x" }))).error_category,
    ).toBe("auth");
    expect(classifyCliCauseActionability(Cause.die(new TypeError("boom"))).error_category).toBe(
      "panic",
    );
    expect(classifyCliCauseActionability(Cause.interrupt(1))).toEqual({
      error_kind: "user_cancelled",
      error_category: "cancelled",
      has_suggestion: false,
      suggestion_type: "none",
      error_fingerprint: "error:Interrupt",
    });
  });

  it("prefers an internal defect when a cause contains mixed failure reasons", () => {
    const cause = Cause.combine(
      Cause.fail(new DeclaredError({ message: "recoverable" })),
      Cause.die(new TypeError("bug")),
    );
    expect(classifyCliCauseActionability(cause)).toMatchObject({
      error_kind: "internal_bug",
      error_category: "panic",
      error_fingerprint: "error:TypeError",
    });
  });

  it("does not leak details from cause chains", () => {
    const secret = "private-token";
    const cause = Cause.combine(Cause.die(new TypeError("boom")), Cause.die(new Error(secret)));
    const result = classifyCliCauseActionability(cause);
    expect(result.error_category).toBe("panic");
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});
