import type { ApiClient, V1ListAllBranchesOutput } from "@supabase/api/effect";
import { Duration, Effect, Option } from "effect";
import * as HttpClientError from "effect/unstable/http/HttpClientError";

import { CommandPlatformApiFactory } from "../auth/command-platform-api-factory.service.ts";
import { CommandPlatformApi } from "../auth/command-platform-api.service.ts";
import { Output } from "../shared/output/output.service.ts";
import {
  sanitizeErrorBody,
  type NetworkErrorFactory,
  type StatusErrorFactory,
} from "./http-errors.ts";

type BranchLookupBranches = typeof V1ListAllBranchesOutput.Type;

/**
 * Classifies a `GET /v1/projects/{ref}` failure for a ref that might actually
 * be a branch: a 404 means `ref` is a branch — resolve to `None` so the
 * caller proceeds treating it as one; any other status surfaces the response
 * body through the caller-supplied status-error factory/message; a transport
 * failure, or a non-`HttpClientError` cause (the generated client's
 * `SchemaError` rejecting the response body), surfaces through the
 * caller-supplied network-error factory/message.
 *
 * Each caller supplies its own error classes and message templates, so the
 * exact wording stays theirs — this helper only owns the status/transport
 * dispatch, not the message text. Pair with `Effect.asSome` so the 404 case
 * collapses cleanly into `Option.none()`:
 *
 * ```ts
 * api.v1.getProject({ ref }).pipe(Effect.asSome, Effect.catch(classifyProjectLookupError(opts)))
 * ```
 */
export function classifyProjectLookupError<S, N>(opts: {
  readonly statusError: StatusErrorFactory<S>;
  readonly networkError: NetworkErrorFactory<N>;
  readonly statusMessage: (status: number, body: string) => string;
  readonly networkMessage: (cause: unknown) => string;
}): (cause: unknown) => Effect.Effect<Option.Option<never>, S | N> {
  return (cause) => {
    if (HttpClientError.isHttpClientError(cause) && cause.response !== undefined) {
      const status = cause.response.status;
      if (status === 404) {
        return Effect.succeedNone;
      }
      return cause.response.text.pipe(
        Effect.orElseSucceed(() => ""),
        // Caps and strips control chars so an oversized or control-char body can't
        // bloat JSON output or inject ANSI.
        Effect.map(sanitizeErrorBody),
        Effect.flatMap((body) =>
          Effect.fail(
            new opts.statusError({
              status,
              body,
              message: opts.statusMessage(status, body),
            }),
          ),
        ),
      );
    }
    // Everything else: a transport `HttpClientError` (no response) is a network
    // failure; a non-`HttpClientError` (the generated client's `SchemaError`
    // rejecting the response body) is an API response problem.
    return Effect.fail(
      new opts.networkError({
        message: opts.networkMessage(cause),
        decode: !HttpClientError.isHttpClientError(cause),
      }),
    );
  };
}

/**
 * Acquires a Management API client for a best-effort branch lookup; never fails, resolving
 * `None` on any acquisition failure. Prefers an already-built `CommandPlatformApi`; falls
 * back to `CommandPlatformApiFactory` for a token-optional runtime like `status`'s, since the
 * factory only resolves a token and touches the network here, lazily, when a lookup is
 * actually attempted.
 */
const acquireBranchLookupApi = Effect.fnUntraced(function* () {
  const direct = yield* Effect.serviceOption(CommandPlatformApi);
  if (Option.isSome(direct)) return direct;

  const factoryOption = yield* Effect.serviceOption(CommandPlatformApiFactory);
  if (Option.isNone(factoryOption)) return Option.none<ApiClient>();

  return yield* factoryOption.value.make.pipe(
    Effect.map(Option.some),
    Effect.catch(() => Effect.succeed(Option.none<ApiClient>())),
  );
});

/**
 * A branch-name lookup is pure decoration and must never dominate a caller's latency —
 * without this bound, the generated client's own retry policy could stall a caller for
 * several minutes against a blackholed API. Shared with other bounded, best-effort probes
 * (e.g. `push.branch-target.ts`'s `getProject` probe) so they don't re-derive the duration.
 */
export const BRANCH_LOOKUP_TIMEOUT = Duration.seconds(5);

/**
 * Best-effort branch-name lookup against `parentRef`'s branches, returning the matching
 * branch's `name`, or `undefined` on no match or any failure. Shows `options.spinnerLabel`
 * in text mode once an API client is available; an acquisition failure degrades silently,
 * before the spinner is shown.
 *
 * The whole acquisition-and-listing attempt is bounded by {@link BRANCH_LOOKUP_TIMEOUT}; a
 * timeout degrades like any other failure. Spinner cleanup runs via `Effect.ensuring` so it
 * still fires when the timeout interrupts the in-flight listing call.
 */
export const findBranchName = Effect.fnUntraced(function* (
  parentRef: string,
  linkedRef: string,
  options: { readonly spinnerLabel?: string } = {},
) {
  const output = yield* Output;

  const branchesOption: Option.Option<BranchLookupBranches> = yield* Effect.gen(function* () {
    const apiOption = yield* acquireBranchLookupApi();
    if (Option.isNone(apiOption)) return Option.none<BranchLookupBranches>();
    const api = apiOption.value;

    const task =
      output.format === "text" && options.spinnerLabel !== undefined
        ? yield* output.task(options.spinnerLabel)
        : undefined;
    return yield* api.v1
      .listAllBranches({ ref: parentRef })
      .pipe(Effect.map(Option.some), Effect.ensuring(task?.clear() ?? Effect.void));
  }).pipe(
    Effect.timeout(BRANCH_LOOKUP_TIMEOUT),
    // Any failure or the timeout above degrades to `None`; this helper never fails on a
    // flaky or slow lookup.
    Effect.catch(() => Effect.succeed(Option.none<BranchLookupBranches>())),
  );

  return Option.isSome(branchesOption)
    ? branchesOption.value.find((branch) => branch.project_ref === linkedRef)?.name
    : undefined;
});
