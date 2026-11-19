import { describe, expect, it } from "@effect/vitest";
import { Cause } from "effect";
import { CliError } from "effect/cli";
import * as HttpClientError from "effect/http/HttpClientError";
import { HttpClientRequest, HttpClientResponse } from "effect/http";
import { AccessTokenRequiredError } from "../../auth/errors.ts";
import { InvalidOutputFormatError } from "../../command-internal/output-formats.ts";
import {
  TargetRemoteAmbiguousError,
  TargetSelectorConflictError,
} from "../../command-internal/target/target.errors.ts";
import {
  HostedMutationConsentRequiredError,
  HostedMutationDeclinedError,
} from "../../command-internal/hosted-consent/hosted-consent.errors.ts";
import {
  ApiCommandOperationFailedError,
  ApiCommandStatusError,
  ApiCommandUsageError,
  ApiCommandWaitTimeoutError,
} from "../../command-internal/command-errors/api-command.errors.ts";
import {
  LinkBranchListNetworkError,
  LinkBranchListStatusError,
  LinkBranchNotFoundError,
  LinkBranchNotLinkedError,
  LinkBranchNotReadyError,
  LinkParentRefInvalidError,
} from "../../command-internal/target/branch-resolution.errors.ts";
import { ProjectRefNotLinkedError } from "../../config/project-ref.errors.ts";
import { standardFailureFor } from "./standard-errors.ts";

const request = HttpClientRequest.get("https://api.example.test/v1/projects");
const statusError = (status: number) =>
  new HttpClientError.HttpClientError({
    reason: new HttpClientError.StatusCodeError({
      request,
      response: HttpClientResponse.fromWeb(request, new Response("", { status })),
    }),
  });
const transportError = new HttpClientError.HttpClientError({
  reason: new HttpClientError.TransportError({ request }),
});
const apiStatus = (status: number) =>
  new ApiCommandStatusError({ status, message: `status ${status}`, apiCode: "some_code" });

describe("standardFailureFor", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly cause: Cause.Cause<unknown>;
    readonly expected: {
      readonly exitCode: number;
      readonly code: string;
      readonly status: number | null;
      readonly hint: string | null;
      readonly apiCode?: string;
    };
  }> = [
    ...[
      [400, "invalid_input"],
      [422, "invalid_input"],
      [401, "unauthenticated"],
      [403, "forbidden"],
      [404, "not_found"],
      [409, "conflict"],
      [429, "rate_limited"],
      [500, "api_error"],
      [418, "api_error"],
    ].map(([status, code]) => ({
      name: `API status ${status}`,
      cause: Cause.fail(apiStatus(Number(status))),
      expected: {
        exitCode: 1,
        code: String(code),
        status: Number(status),
        hint: null,
        apiCode: "some_code",
      },
    })),
    {
      name: "API status hint",
      cause: Cause.fail(
        new ApiCommandStatusError({ status: 409, message: "m", hint: "Rename it" }),
      ),
      expected: { exitCode: 1, code: "conflict", status: 409, hint: "Rename it" },
    },
    {
      name: "API usage error",
      cause: Cause.fail(new ApiCommandUsageError({ message: "bad", hint: "Use --name" })),
      expected: { exitCode: 2, code: "usage_error", status: null, hint: "Use --name" },
    },
    {
      name: "consent required",
      cause: Cause.fail(new HostedMutationConsentRequiredError({ message: "m", suggestion: "s" })),
      expected: { exitCode: 2, code: "usage_error", status: null, hint: "s" },
    },
    {
      name: "declined confirmation",
      cause: Cause.fail(new HostedMutationDeclinedError({ message: "no" })),
      expected: { exitCode: 130, code: "cancelled", status: null, hint: null },
    },
    {
      name: "interruption",
      cause: Cause.interrupt(),
      expected: { exitCode: 130, code: "cancelled", status: null, hint: null },
    },
    {
      name: "operation failed",
      cause: Cause.fail(
        new ApiCommandOperationFailedError({ message: "m", status: "FAILED", hint: "Check it" }),
      ),
      expected: { exitCode: 1, code: "operation_failed", status: null, hint: "Check it" },
    },
    {
      name: "wait timeout",
      cause: Cause.fail(
        new ApiCommandWaitTimeoutError({ message: "m", timeoutMillis: 5, hint: "Check it" }),
      ),
      expected: { exitCode: 1, code: "wait_timeout", status: null, hint: "Check it" },
    },
    {
      name: "missing access token",
      cause: Cause.fail(new AccessTokenRequiredError({ message: "log in" })),
      expected: { exitCode: 1, code: "unauthenticated", status: null, hint: null },
    },
    {
      name: "client 401 response",
      cause: Cause.fail(statusError(401)),
      expected: { exitCode: 1, code: "unauthenticated", status: 401, hint: null },
    },
    {
      name: "client transport failure",
      cause: Cause.fail(transportError),
      expected: { exitCode: 1, code: "network_error", status: null, hint: null },
    },
    {
      name: "parse error",
      cause: Cause.fail(
        new CliError.UnrecognizedOption({
          option: "--nope",
          command: ["supabase"],
          suggestions: [],
        }),
      ),
      expected: { exitCode: 2, code: "usage_error", status: null, hint: null },
    },
    {
      name: "invalid output format",
      cause: Cause.fail(new InvalidOutputFormatError({ message: "invalid output format" })),
      expected: { exitCode: 2, code: "usage_error", status: null, hint: null },
    },
    {
      name: "target selector conflict keeps its suggestion",
      cause: Cause.fail(
        new TargetSelectorConflictError({
          flags: ["--remote", "--local"],
          message: "--remote and --local cannot be combined",
          suggestion: "Pass only one target flag.",
        }),
      ),
      expected: {
        exitCode: 2,
        code: "usage_error",
        status: null,
        hint: "Pass only one target flag.",
      },
    },
    {
      name: "unlinked project",
      cause: Cause.fail(new ProjectRefNotLinkedError({ message: "Cannot find project ref." })),
      expected: { exitCode: 2, code: "usage_error", status: null, hint: null },
    },
    {
      name: "branch without a linked parent",
      cause: Cause.fail(
        new LinkBranchNotLinkedError({ message: "No parent.", suggestion: "Run supabase link." }),
      ),
      expected: { exitCode: 2, code: "usage_error", status: null, hint: "Run supabase link." },
    },
    {
      name: "invalid linked parent ref",
      cause: Cause.fail(
        new LinkParentRefInvalidError({ message: "Bad ref.", suggestion: "Re-run supabase link." }),
      ),
      expected: { exitCode: 2, code: "usage_error", status: null, hint: "Re-run supabase link." },
    },
    {
      name: "unknown branch",
      cause: Cause.fail(
        new LinkBranchNotFoundError({ message: "No such branch.", suggestion: "List branches." }),
      ),
      expected: { exitCode: 2, code: "usage_error", status: null, hint: "List branches." },
    },
    {
      name: "branch not ready",
      cause: Cause.fail(
        new LinkBranchNotReadyError({ branch: "b", status: "CREATING_PROJECT", message: "Wait." }),
      ),
      expected: { exitCode: 1, code: "api_error", status: null, hint: null },
    },
    {
      name: "branch list transport failure",
      cause: Cause.fail(new LinkBranchListNetworkError({ message: "offline" })),
      expected: { exitCode: 1, code: "network_error", status: null, hint: null },
    },
    {
      name: "branch list decode failure",
      cause: Cause.fail(new LinkBranchListNetworkError({ message: "bad body", decode: true })),
      expected: { exitCode: 1, code: "api_error", status: null, hint: null },
    },
    ...[
      [401, "unauthenticated"],
      [403, "forbidden"],
      [404, "not_found"],
      [500, "api_error"],
    ].map(([status, code]) => ({
      name: `branch list status ${status}`,
      cause: Cause.fail(
        new LinkBranchListStatusError({ status: Number(status), body: "", message: "failed" }),
      ),
      expected: { exitCode: 1, code: String(code), status: Number(status), hint: null },
    })),
    {
      name: "ambiguous remote whose branch listing was forbidden",
      cause: Cause.fail(
        new TargetRemoteAmbiguousError({
          message: "Could not check branches",
          suggestion: "Ask for branch access",
          status: 403,
        }),
      ),
      expected: { exitCode: 1, code: "forbidden", status: 403, hint: "Ask for branch access" },
    },
    {
      name: "ambiguous remote whose branch listing was not found",
      cause: Cause.fail(
        new TargetRemoteAmbiguousError({
          message: "Could not check branches",
          suggestion: "Pass --project-ref",
          status: 404,
        }),
      ),
      expected: { exitCode: 2, code: "usage_error", status: null, hint: "Pass --project-ref" },
    },
    {
      name: "ambiguous remote with an invalid token",
      cause: Cause.fail(
        new TargetRemoteAmbiguousError({
          message: "Could not check branches",
          suggestion: "Set SUPABASE_ACCESS_TOKEN",
          authFailure: "token",
        }),
      ),
      expected: {
        exitCode: 1,
        code: "unauthenticated",
        status: null,
        hint: "Set SUPABASE_ACCESS_TOKEN",
      },
    },
    {
      name: "defect",
      cause: Cause.die(new Error("boom")),
      expected: { exitCode: 1, code: "internal_error", status: null, hint: null },
    },
    {
      name: "unknown typed failure",
      cause: Cause.fail("nope"),
      expected: { exitCode: 1, code: "internal_error", status: null, hint: null },
    },
  ];

  it.each(cases)("maps $name", ({ cause, expected }) => {
    const { exitCode, document } = standardFailureFor(cause);
    expect({
      exitCode,
      code: document.code,
      status: document.status,
      hint: document.hint,
      apiCode: document.api_code,
    }).toEqual({ ...expected, apiCode: expected.apiCode });
  });
});
