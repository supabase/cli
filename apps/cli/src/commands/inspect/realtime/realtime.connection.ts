import { Effect, Option, Redacted } from "effect";

import { CommandPlatformApiFactory } from "../../../auth/command-platform-api-factory.service.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { mapTenantApiKeysError } from "../../../command-internal/get-tenant-api-keys.ts";
import { loadLocalProjectContext } from "../../../command-internal/local-project-context.ts";
import { resolveLocalConfigValues } from "../../../command-internal/local-config-values.ts";
import { extractServiceKeys } from "../../../command-internal/tenant-keys.ts";
import { probeRealtimeEndpoint } from "./realtime.probe.ts";
import {
  RealtimeApiKeysNetworkError,
  RealtimeInvalidUrlError,
  RealtimeApiKeysStatusError,
  RealtimeConfigError,
  RealtimeMissingApiKeyError,
  RealtimeTargetNotResolvedError,
} from "./realtime.errors.ts";

type RealtimeTargetSource = "flag" | "env" | "local" | "linked";

export interface RealtimeTarget {
  readonly url: string;
  readonly apiKey: Redacted.Redacted<string>;
  readonly source: RealtimeTargetSource;
  readonly projectRef: string | undefined;
  readonly elevated: boolean;
}

export type RealtimeTargetChoice = "local" | "linked";

interface RealtimeTargetRequest {
  readonly url: Option.Option<string>;
  readonly apiKey: Option.Option<string>;
  readonly secretKey: Option.Option<string>;
  readonly serviceRole: boolean;
  readonly projectRef: Option.Option<string>;
  readonly choice: RealtimeTargetChoice | undefined;
}

const URL_ENV_KEY = "SUPABASE_URL";
const KEY_ENV_KEYS = ["SUPABASE_PUBLISHABLE_KEY", "SUPABASE_ANON_KEY"] as const;
const SECRET_KEY_ENV_KEYS = ["SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY"] as const;

const legacyValidateRealtimeUrl = (url: string) =>
  Effect.try({
    try: () => {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`expected an http:// or https:// URL, got "${parsed.protocol}"`);
      }
      return url;
    },
    catch: (cause) =>
      new RealtimeInvalidUrlError({
        message: `invalid Realtime URL "${url}": ${cause instanceof Error ? cause.message : String(cause)}. Pass the project URL, e.g. https://abc.supabase.co or http://127.0.0.1:54321.`,
      }),
  });

function legacyEnvValue(key: string): string | undefined {
  const value = process.env[key];
  return value !== undefined && value.length > 0 ? value : undefined;
}

export const resolveRealtimeTarget = Effect.fnUntraced(function* (request: RealtimeTargetRequest) {
  const flagUrl = Option.getOrUndefined(request.url);
  const flagSecret =
    Option.getOrUndefined(request.secretKey) ??
    (request.serviceRole
      ? SECRET_KEY_ENV_KEYS.map(legacyEnvValue).find((value) => value !== undefined)
      : undefined);
  const flagKey = flagSecret ?? Option.getOrUndefined(request.apiKey);
  const envUrl = legacyEnvValue(URL_ENV_KEY);
  const envKey = KEY_ENV_KEYS.map(legacyEnvValue).find((value) => value !== undefined);

  const url = flagUrl ?? envUrl;
  const apiKey = flagKey ?? envKey;
  const elevated = flagSecret !== undefined;

  if (url !== undefined && apiKey !== undefined) {
    yield* legacyValidateRealtimeUrl(url);
    return {
      url,
      apiKey: Redacted.make(apiKey),
      source: flagUrl !== undefined && flagKey !== undefined ? "flag" : "env",
      projectRef: undefined,
      elevated,
    } satisfies RealtimeTarget;
  }

  const resolved = yield* resolveRealtimeProject(request);
  const effectiveUrl = url ?? resolved.url;
  yield* legacyValidateRealtimeUrl(effectiveUrl);

  return {
    url: effectiveUrl,
    apiKey: apiKey === undefined ? resolved.apiKey : Redacted.make(apiKey),
    source: resolved.source,
    projectRef: resolved.projectRef,
    elevated: elevated || resolved.elevated,
  } satisfies RealtimeTarget;
});

const resolveRealtimeProject = Effect.fnUntraced(function* (request: RealtimeTargetRequest) {
  if (request.choice === "local") return yield* legacyLocalRealtimeTarget(request.serviceRole);
  if (request.choice === "linked" || Option.isSome(request.projectRef)) {
    return yield* legacyLinkedRealtimeTarget(request.projectRef, request.serviceRole);
  }

  const local = yield* legacyLocalRealtimeTarget(request.serviceRole).pipe(
    Effect.catchTags({
      RealtimeConfigError: () => Effect.succeed(undefined),
      RealtimeTargetNotResolvedError: () => Effect.succeed(undefined),
    }),
  );

  if (local !== undefined) {
    const probe = yield* probeRealtimeEndpoint(local);
    if (probe.kind === "reachable") return local;

    return yield* legacyLinkedRealtimeTarget(request.projectRef, request.serviceRole).pipe(
      Effect.catch((cause) =>
        Effect.fail(
          new RealtimeTargetNotResolvedError({
            message: [
              `the local stack at ${local.url} is not serving Realtime (${probe.detail})`,
              `and no linked project could be used (${cause.message})`,
              "start the stack with `supabase start`, or pass --url and --api-key",
            ].join("; "),
          }),
        ),
      ),
    );
  }

  return yield* legacyLinkedRealtimeTarget(request.projectRef, request.serviceRole);
});

const legacyLocalRealtimeTarget = Effect.fnUntraced(function* (serviceRole: boolean) {
  const cliSettings = yield* CommandSettings;
  const context = yield* loadLocalProjectContext(
    cliSettings.workdir,
    (message) => new RealtimeConfigError({ message }),
  );

  if (context.loaded === null) {
    return yield* new RealtimeTargetNotResolvedError({
      message: `no supabase/config.toml under ${cliSettings.workdir}, so there is no local stack to inspect`,
    });
  }

  const values = yield* Effect.try({
    try: () =>
      resolveLocalConfigValues(
        context.config,
        context.hostname,
        cliSettings.workdir,
        context.projectEnvValues,
        context.loaded?.document,
      ),
    catch: (cause) =>
      new RealtimeConfigError({
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });

  const publishable = values.publishableKey.length > 0 ? values.publishableKey : values.anonKey;
  const secret = values.secretKey.length > 0 ? values.secretKey : values.serviceRoleKey;
  const key = serviceRole ? secret : publishable;

  if (key.length === 0) {
    return yield* new RealtimeMissingApiKeyError({
      message: serviceRole
        ? "the local config produced neither a secret key nor a service-role key"
        : "the local config produced neither a publishable key nor an anon key",
    });
  }

  return {
    url: values.apiUrl,
    apiKey: Redacted.make(key),
    source: "local",
    projectRef: undefined,
    elevated: serviceRole,
  } satisfies RealtimeTarget;
});

const legacyLinkedRealtimeTarget = Effect.fnUntraced(function* (
  projectRef: Option.Option<string>,
  serviceRole: boolean,
) {
  const cliSettings = yield* CommandSettings;
  const resolver = yield* ProjectRefResolver;
  const ref = yield* resolver.resolve(projectRef);

  const api = yield* (yield* CommandPlatformApiFactory).make;
  const keys = extractServiceKeys(
    yield* api.v1.getProjectApiKeys(serviceRole ? { ref, reveal: true } : { ref }).pipe(
      Effect.catch(
        mapTenantApiKeysError({
          networkError: RealtimeApiKeysNetworkError,
          statusError: RealtimeApiKeysStatusError,
        }),
      ),
    ),
  );

  const key = serviceRole ? keys.serviceRole : keys.anon;
  if (key.length === 0) {
    return yield* new RealtimeMissingApiKeyError({
      message: serviceRole
        ? `project ${ref} exposes no secret or service-role key to connect with`
        : `project ${ref} exposes no publishable or anon key to connect with`,
    });
  }

  return {
    url: `https://${ref}.${cliSettings.projectHost}`,
    apiKey: Redacted.make(key),
    source: "linked",
    projectRef: ref,
    elevated: serviceRole,
  } satisfies RealtimeTarget;
});

export function describeRealtimeTarget(target: RealtimeTarget): string {
  switch (target.source) {
    case "local":
      return `local stack at ${target.url}`;
    case "linked":
      return `project ${target.projectRef ?? "?"} at ${target.url}`;
    case "env":
      return `${target.url} (from the environment)`;
    default:
      return target.url;
  }
}
