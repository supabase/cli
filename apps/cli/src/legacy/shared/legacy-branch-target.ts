import type { ApiClient, V1ListAllBranchesOutput } from "@supabase/api/effect";
import { Duration, Effect, Option } from "effect";
import * as HttpClientError from "effect/unstable/http/HttpClientError";

import { LegacyPlatformApiFactory } from "../auth/legacy-platform-api-factory.service.ts";
import { LegacyPlatformApi } from "../auth/legacy-platform-api.service.ts";
import { Output } from "../../shared/output/output.service.ts";
import {
  sanitizeLegacyErrorBody,
  type NetworkErrorFactory,
  type StatusErrorFactory,
} from "./legacy-http-errors.ts";

type LegacyBranchLookupBranches = typeof V1ListAllBranchesOutput.Type;

/**
 * Classifies a `GET /v1/projects/{ref}` failure for a ref that might actually
 * be a branch: a 404 means `ref` is a branch — resolve to `None` so the
 * caller proceeds treating it as one; any other status surfaces the response
 * body through the caller-supplied status-error factory/message; a transport
 * failure, or a non-`HttpClientError` cause (the generated client's
 * `SchemaError` rejecting the response body), surfaces through the
 * caller-supplied network-error factory/message.
 *
 * Each caller supplies its OWN error classes and message templates, so the
 * exact wording stays theirs — this helper only owns the status/transport
 * dispatch, not the message text. Pair with `Effect.asSome` so the 404 case
 * collapses cleanly into `Option.none()`:
 *
 * ```ts
 * api.v1.getProject({ ref }).pipe(Effect.asSome, Effect.catch(legacyClassifyProjectLookupError(opts)))
 * ```
 */
export function legacyClassifyProjectLookupError<S, N>(opts: {
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
        // Cap + strip control chars, matching `mapLegacyHttpError`'s defence-in-depth
        // so an oversized / control-char body can't bloat JSON output or inject ANSI.
        Effect.map(sanitizeLegacyErrorBody),
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
 * Acquires a Management API client for a best-effort branch-name lookup,
 * total (never fails, resolves `None` on any acquisition failure):
 *
 *   1. `Effect.serviceOption(LegacyPlatformApi)` — the cheapest path; existing
 *      tests provide this directly, and any runtime that eagerly built the
 *      typed client (e.g. `link`/`branches`) already has it in scope.
 *   2. Otherwise `Effect.serviceOption(LegacyPlatformApiFactory)` → `factory.make`,
 *      with every failure (no token, invalid token, network, decode) caught.
 *      This is the path a token-optional runtime like `status`'s needs: the
 *      factory's own layer build never resolves a token or touches the
 *      network — that only happens here, lazily, exactly when a branch lookup
 *      is actually attempted.
 *
 * Neither service being in scope (a runtime that wires up neither) also
 * degrades to `None` rather than a compile-time requirement — this effect's
 * own type carries no `LegacyPlatformApi`/`LegacyPlatformApiFactory`
 * requirement at all, thanks to `Effect.serviceOption`.
 */
const legacyAcquireBranchLookupApi = Effect.fnUntraced(function* () {
  const direct = yield* Effect.serviceOption(LegacyPlatformApi);
  if (Option.isSome(direct)) return direct;

  const factoryOption = yield* Effect.serviceOption(LegacyPlatformApiFactory);
  if (Option.isNone(factoryOption)) return Option.none<ApiClient>();

  return yield* factoryOption.value.make.pipe(
    Effect.map(Option.some),
    Effect.catch(() => Effect.succeed(Option.none<ApiClient>())),
  );
});

// A branch-name lookup is pure decoration for any caller and must never
// dominate its latency. The generated client's own retry policy (60s
// attempts × 5 transport retries — `packages/api/src/internal/client.ts:208-229`)
// would otherwise let a single blackholed API stall a caller for ~6 minutes.
// Exported so other bounded-but-best-effort probes in this codebase (e.g.
// `push.branch-target.ts`'s live `getProject` target-detection probe) share
// the same duration + rationale instead of re-deriving it.
export const LEGACY_BRANCH_LOOKUP_TIMEOUT = Duration.seconds(5);

/**
 * Best-effort branch-name lookup against `parentRef`'s branches, returning
 * the matching branch's `name` (or `undefined` on no match/any failure — the
 * degradation point every caller relies on). Shows `options.spinnerLabel` in
 * text mode when supplied, but only once an API client is actually
 * available — an acquisition failure degrades silently, before ever touching
 * the spinner.
 *
 * The WHOLE acquisition-and-listing attempt is hard-bounded by
 * {@link LEGACY_BRANCH_LOOKUP_TIMEOUT}; a timeout degrades exactly like any
 * other failure. The spinner's cleanup runs via `Effect.ensuring` (not a
 * plain sequential `yield*`) so it's guaranteed to fire even when the timeout
 * interrupts the in-flight listing call, not just on its normal
 * success/failure completion.
 */
export const legacyFindBranchName = Effect.fnUntraced(function* (
  parentRef: string,
  linkedRef: string,
  options: { readonly spinnerLabel?: string } = {},
) {
  const output = yield* Output;

  const branchesOption: Option.Option<LegacyBranchLookupBranches> = yield* Effect.gen(function* () {
    const apiOption = yield* legacyAcquireBranchLookupApi();
    if (Option.isNone(apiOption)) return Option.none<LegacyBranchLookupBranches>();
    const api = apiOption.value;

    const task =
      output.format === "text" && options.spinnerLabel !== undefined
        ? yield* output.task(options.spinnerLabel)
        : undefined;
    return yield* api.v1
      .listAllBranches({ ref: parentRef })
      .pipe(Effect.map(Option.some), Effect.ensuring(task?.clear() ?? Effect.void));
  }).pipe(
    Effect.timeout(LEGACY_BRANCH_LOOKUP_TIMEOUT),
    // Best-effort: any transport/status/decode failure OR the timeout above
    // degrades below — this helper must never fail on a flaky/slow lookup.
    Effect.catch(() => Effect.succeed(Option.none<LegacyBranchLookupBranches>())),
  );

  return Option.isSome(branchesOption)
    ? branchesOption.value.find((branch) => branch.project_ref === linkedRef)?.name
    : undefined;
});
