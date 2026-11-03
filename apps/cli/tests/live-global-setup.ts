import type { ProvidedContext } from "vitest";

import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { makeApiClient } from "@supabase/api/effect";
import { Data, Effect, FileSystem, Layer, Path, Predicate } from "effect";
import { FetchHttpClient } from "effect/http";

import { cliConfigProviderLayer } from "../src/shared/config/cli-config-provider.layer.ts";
import "./helpers/live-provided-context.ts";
import { cleanupLiveEnvironment, provisionLiveEnvironment } from "./helpers/live-project.ts";
import { liveAccessToken, liveApiUrl, validateLiveConfig } from "./helpers/live-env.ts";

type LiveSetupContext = {
  provide: <K extends keyof ProvidedContext>(key: K, value: ProvidedContext[K]) => void;
};

/** Vitest rejected a provided value; setup rejects with its original error. */
class LiveProvideFailure extends Data.TaggedError("LiveProvideFailure")<{
  readonly cause: unknown;
}> {}

/*
 * What the live setup rejects with: a plain `Error` with the same message for a live configuration
 * or project failure, also inside a lifecycle `AggregateError`.
 */
function thrownLiveFailure(error: unknown): unknown {
  if (
    (Predicate.isTagged(error, "LiveProjectError") ||
      Predicate.isTagged(error, "LiveConfigError")) &&
    error instanceof Error
  ) {
    return new Error(error.message);
  }
  if (error instanceof AggregateError) {
    const errors: Array<unknown> = Array.from(error.errors, thrownLiveFailure);
    return errors.every((inner, index) => inner === error.errors[index])
      ? error
      : new AggregateError(errors, error.message);
  }
  return error;
}

/** Provision one disposable project for the entire serial live Vitest run. */
export function setup({ provide }: LiveSetupContext): Promise<() => Promise<void>> {
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* validateLiveConfig;
      const api = yield* makeApiClient({
        baseUrl: yield* liveApiUrl,
        accessToken: yield* liveAccessToken,
      });
      const environment = yield* provisionLiveEnvironment(api);
      yield* Effect.try({
        try: () => {
          provide("liveProject", environment.project);
          provide("liveProfilePath", environment.profilePath);
        },
        catch: (cause) => new LiveProvideFailure({ cause }),
      });
      const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
      return () =>
        Effect.runPromiseWith(services)(
          cleanupLiveEnvironment(api, environment).pipe(
            Effect.catch((failure) => Effect.die(thrownLiveFailure(failure))),
          ),
        );
    }).pipe(
      Effect.catchIf(Predicate.isTagged("LiveProvideFailure"), (failure) =>
        Effect.die(failure.cause),
      ),
      Effect.catch((failure) => Effect.die(thrownLiveFailure(failure))),
      Effect.provide(
        Layer.mergeAll(
          FetchHttpClient.layer,
          BunFileSystem.layer,
          BunPath.layer,
          cliConfigProviderLayer,
        ),
      ),
    ),
  );
}

export default setup;
