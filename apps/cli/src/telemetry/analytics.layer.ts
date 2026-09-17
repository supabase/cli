import { Config, ConfigProvider, Effect, FileSystem, Layer, Option, Path, Schema } from "effect";
import { aiToolLayer } from "../shared/telemetry/ai-tool.layer.ts";
import { AiTool } from "../shared/telemetry/ai-tool.service.ts";
import {
  CurrentAnalyticsContext,
  type AnalyticsContext,
} from "../shared/telemetry/analytics-context.ts";
import { Analytics } from "../shared/telemetry/analytics.service.ts";
import {
  EnvSignalPresenceKeys,
  EnvSignalValueKeys,
  GroupOrganization,
  GroupProject,
  MaxEnvSignalValueLength,
  PropArch,
  PropCliVersion,
  PropDeviceId,
  PropEnvSignals,
  PropIsAgent,
  PropIsCi,
  PropIsFirstRun,
  PropIsTty,
  PropOs,
  PropPlatform,
  PropSchemaVersion,
  PropSessionId,
} from "../shared/telemetry/event-catalog.ts";
import { scopedPosthogClient } from "../shared/telemetry/posthog-client.ts";
import { RuntimeInfo } from "../shared/runtime/runtime-info.service.ts";
import { resolvePosthogConfig } from "../shared/telemetry/posthog-config.ts";
import { telemetryRuntimeLayer } from "../shared/telemetry/runtime.layer.ts";
import { TelemetryRuntime } from "../shared/telemetry/runtime.service.ts";

interface LinkedProjectCacheValue {
  readonly ref: string;
  readonly name: string;
  readonly organization_id: string;
  readonly organization_slug: string;
}

const LinkedProjectCacheSchema = Schema.Struct({
  ref: Schema.String,
  name: Schema.optionalKey(Schema.Unknown),
  organization_id: Schema.optionalKey(Schema.Unknown),
  organization_slug: Schema.String,
});

function stripUndefined(properties: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(properties).filter(([, value]) => value !== undefined));
}

function contextProperties(context: AnalyticsContext): Record<string, unknown> {
  return stripUndefined({
    command_run_id: context.command_run_id,
    command: context.command,
    flags: context.flags,
  });
}

/**
 * Builds the PostHog `groups` map for a captured event, or `undefined` when no group attribution
 * applies. Keys the organization group by ID, not slug, so `cli_command_executed` attaches to
 * the same group `groupIdentify` published; omits the org group entirely when the ID is empty.
 */
export function resolveGroups(
  context: AnalyticsContext,
  linkedProject: Option.Option<LinkedProjectCacheValue>,
): Record<string, string> | undefined {
  const resolved =
    context.groups?.organization !== undefined && context.groups.project !== undefined
      ? { organization: context.groups.organization, project: context.groups.project }
      : Option.match(linkedProject, {
          onNone: () => undefined,
          onSome: (linked) => ({ organization: linked.organization_id, project: linked.ref }),
        });

  if (resolved === undefined) return undefined;

  return {
    ...(resolved.organization === "" ? {} : { [GroupOrganization]: resolved.organization }),
    [GroupProject]: resolved.project,
  };
}

export const collectEnvSignals = Effect.gen(function* () {
  const signals: Record<string, true | string> = {};

  for (const key of EnvSignalPresenceKeys) {
    const raw = yield* Config.option(Config.string(key));
    if (Option.isNone(raw)) continue;
    const value = raw.value;
    if (value.trim().length === 0) continue;
    signals[key] = true;
  }

  for (const key of EnvSignalValueKeys) {
    const raw = yield* Config.option(Config.string(key));
    if (Option.isNone(raw)) continue;
    const trimmed = raw.value.trim();
    if (trimmed.length === 0) continue;
    signals[key] =
      trimmed.length > MaxEnvSignalValueLength
        ? trimmed.slice(0, MaxEnvSignalValueLength)
        : trimmed;
  }

  return Object.keys(signals).length === 0
    ? Option.none<Record<string, true | string>>()
    : Option.some(signals);
});

function makeLoadLinkedProject(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  runtimeInfo: { readonly cwd: string },
): Effect.Effect<Option.Option<LinkedProjectCacheValue>> {
  return Effect.gen(function* () {
    const configuredWorkdir = yield* Config.option(Config.string("SUPABASE_WORKDIR"));
    const workdir = Option.getOrElse(configuredWorkdir, () => runtimeInfo.cwd);
    const cachePath = path.join(workdir, "supabase", ".temp", "linked-project.json");
    const exists = yield* fs.exists(cachePath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) return Option.none<LinkedProjectCacheValue>();

    const content = yield* fs.readFileString(cachePath).pipe(Effect.option);
    if (Option.isNone(content)) return Option.none<LinkedProjectCacheValue>();

    const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(LinkedProjectCacheSchema))(
      content.value,
    ).pipe(Effect.option);
    return Option.map(decoded, (parsed) => ({
      ref: parsed.ref,
      name: typeof parsed.name === "string" ? parsed.name : "",
      organization_id: typeof parsed.organization_id === "string" ? parsed.organization_id : "",
      organization_slug: parsed.organization_slug,
    }));
  }).pipe(Effect.orElseSucceed(() => Option.none<LinkedProjectCacheValue>()));
}

export const analyticsLayer = Layer.effect(
  Analytics,
  Effect.gen(function* () {
    const runtime = yield* TelemetryRuntime;
    const configProvider = yield* ConfigProvider.ConfigProvider;
    const aiTool = yield* AiTool;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runtimeInfo = yield* RuntimeInfo;
    const posthogConfig = yield* resolvePosthogConfig(configProvider);

    if (runtime.consent !== "granted" || Option.isNone(posthogConfig.key)) {
      return Analytics.of({
        capture: () => Effect.void,
        identify: () => Effect.void,
        alias: () => Effect.void,
        groupIdentify: () => Effect.void,
      });
    }

    const client = yield* scopedPosthogClient(posthogConfig.key.value, posthogConfig.host);

    const loadLinkedProject = makeLoadLinkedProject(fs, path, runtimeInfo);

    const isAgent = Option.isSome(aiTool.name);
    const envSignals = yield* collectEnvSignals;

    const baseProperties = stripUndefined({
      [PropPlatform]: "cli",
      [PropSchemaVersion]: 1,
      [PropDeviceId]: runtime.deviceId,
      [PropSessionId]: runtime.sessionId,
      [PropIsFirstRun]: runtime.isFirstRun,
      [PropIsTty]: runtime.isTty,
      [PropIsCi]: runtime.isCi,
      [PropIsAgent]: isAgent,
      [PropOs]: runtime.os,
      [PropArch]: runtime.arch,
      [PropCliVersion]: runtime.cliVersion,
      [PropEnvSignals]: Option.isSome(envSignals) ? envSignals.value : undefined,
    });

    const capture = (event: string, properties: Record<string, unknown> = {}) =>
      Effect.gen(function* () {
        const context = yield* CurrentAnalyticsContext;
        const linkedProject = yield* loadLinkedProject;
        const groups = resolveGroups(context, linkedProject);

        client.capture({
          event,
          distinctId: context.distinct_id ?? runtime.identity.current() ?? runtime.deviceId,
          ...(groups === undefined ? {} : { groups }),
          properties: {
            ...baseProperties,
            ...contextProperties(context),
            ...stripUndefined(properties),
          },
        });
      });

    const identify = (distinctId: string, properties: Record<string, unknown> = {}) =>
      Effect.sync(() => {
        client.identify({
          distinctId,
          properties: stripUndefined({
            cli_version: runtime.cliVersion,
            os: runtime.os,
            arch: runtime.arch,
            ...properties,
          }),
        });
      });

    const alias = (distinctId: string, aliasValue: string) =>
      Effect.sync(() => {
        client.alias({ distinctId, alias: aliasValue });
      });

    const groupIdentify = (
      groupType: string,
      groupKey: string,
      properties: Record<string, unknown> = {},
    ) =>
      Effect.gen(function* () {
        const context = yield* CurrentAnalyticsContext;
        client.groupIdentify({
          groupType,
          groupKey,
          distinctId: context.distinct_id ?? runtime.identity.current() ?? runtime.deviceId,
          properties: stripUndefined(properties),
        });
      });

    return Analytics.of({
      capture,
      identify,
      alias,
      groupIdentify,
    });
  }),
).pipe(Layer.provide(telemetryRuntimeLayer), Layer.provide(aiToolLayer));
