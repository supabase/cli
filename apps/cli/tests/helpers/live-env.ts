/** Environment-only live-suite configuration. */

import { Config, Data, Effect, Option } from "effect";

export const LIVE_EXIT_TIMEOUT_MS = 240_000;

/**
 * The default shadow port (54320) is inside Linux's default ephemeral range, so an outbound socket
 * can hold it. Live files run serially, so one fixed port below that range is safe.
 */
export const LIVE_SHADOW_PORT = "24320";

class LiveConfigError extends Data.TaggedError("LiveConfigError")<{
  readonly message: string;
}> {}

const envValue = (name: string) =>
  Config.option(Config.String(name)).pipe(
    Effect.map(Option.getOrUndefined),
    Effect.mapError((error) => new LiveConfigError({ message: error.message })),
  );

export const liveApiUrl = Effect.gen(function* () {
  const value = (yield* envValue("SUPABASE_LIVE_API_URL"))?.trim();
  if (value === undefined || value.length === 0) {
    return yield* new LiveConfigError({
      message: "SUPABASE_LIVE_API_URL is required to run the live suite",
    });
  }
  const url = yield* Effect.try({
    try: () => new URL(value),
    catch: () =>
      new LiveConfigError({
        message: `SUPABASE_LIVE_API_URL must be an absolute HTTP(S) URL: ${value}`,
      }),
  });
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return yield* new LiveConfigError({
      message: `SUPABASE_LIVE_API_URL must use http:// or https://: ${value}`,
    });
  }
  return url.toString().replace(/\/+$/u, "");
});

export const liveAccessToken = Effect.gen(function* () {
  const token = (yield* envValue("SUPABASE_ACCESS_TOKEN"))?.trim();
  if (token === undefined || token.length === 0) {
    return yield* new LiveConfigError({
      message: "SUPABASE_ACCESS_TOKEN is required to run the live suite",
    });
  }
  return token;
});

export const validateLiveConfig = Effect.gen(function* () {
  const apiUrl = yield* liveApiUrl;
  const accessToken = yield* liveAccessToken;
  return { apiUrl, accessToken };
});

export const keepLiveProject = Effect.map(
  envValue("SUPABASE_LIVE_KEEP_PROJECT"),
  (value) => value === "1",
);

export const liveProjectName = Effect.map(
  envValue("SUPABASE_LIVE_PROJECT_NAME"),
  (value) => value?.trim() || "supabase-cli-live",
);

export const liveRegion = Effect.map(
  envValue("SUPABASE_LIVE_REGION"),
  (value) => value?.trim() || "us-east-1",
);

export const liveRunId = Effect.gen(function* () {
  return (yield* envValue("GITHUB_RUN_ID")) ?? (yield* envValue("CI_JOB_ID"));
});

export const liveOrgId = Effect.map(envValue("SUPABASE_LIVE_ORG_ID"), (value) => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
});

/** Resolve `<ref>.<host>` from a database host such as `db.<ref>.supabase.co`. */
export function deriveLiveProjectHost(databaseHost: string, projectRef: string): string {
  const prefix = `db.${projectRef}.`;
  if (!databaseHost.startsWith(prefix)) {
    throw new Error(
      `Cannot derive project host for ${projectRef} from database host ${databaseHost}; expected a ${prefix}<host> name`,
    );
  }
  const host = databaseHost.slice(prefix.length);
  if (host.length === 0 || host.includes("/")) {
    throw new Error(`Cannot derive a valid project host from database host ${databaseHost}`);
  }
  return host;
}
