// oxlint-disable effecttsgo/async-function -- Vitest requires Promise-based global setup hooks.
import type { ProvidedContext } from "vitest";

import { makeApiClient } from "@supabase/api/effect";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import "./helpers/live-provided-context.ts";
import { cleanupLiveEnvironment, provisionLiveEnvironment } from "./helpers/live-project.ts";
import { liveAccessToken, liveApiUrl, validateLiveConfig } from "./helpers/live-env.ts";

type LiveSetupContext = {
  provide: <K extends keyof ProvidedContext>(key: K, value: ProvidedContext[K]) => void;
};

/** Provision one disposable project for the entire serial live Vitest run. */
export async function setup({ provide }: LiveSetupContext): Promise<() => Promise<void>> {
  validateLiveConfig();
  const { api, environment } = await Effect.runPromise(
    Effect.gen(function* () {
      const api = yield* makeApiClient({ baseUrl: liveApiUrl(), accessToken: liveAccessToken() });
      const environment = yield* provisionLiveEnvironment(api);
      return { api, environment };
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );
  provide("liveProject", environment.project);
  provide("liveProfilePath", environment.profilePath);
  return async () => {
    await Effect.runPromise(cleanupLiveEnvironment(api, environment));
  };
}

export default setup;
