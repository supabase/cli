import { Effect, FileSystem, Layer, Option, Path } from "effect";
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
import { resolvePosthogConfig } from "../shared/telemetry/posthog-config.ts";
import { telemetryRuntimeLayer } from "../shared/telemetry/runtime.layer.ts";
import { TelemetryRuntime } from "../shared/telemetry/runtime.service.ts";

interface LinkedProjectCacheValue {
  readonly ref: string;
  readonly name: string;
  readonly organization_id: string;
  readonly organization_slug: string;
}

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

export function collectEnvSignals(): Record<string, true | string> | undefined {
  const signals: Record<string, true | string> = {};

  for (const key of EnvSignalPresenceKeys) {
    const raw = process.env[key];
    if (raw === undefined) continue;
    if (raw.trim().length === 0) continue;
    signals[key] = true;
  }

  for (const key of EnvSignalValueKeys) {
    const raw = process.env[key];
    if (raw === undefined) continue;
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    signals[key] =
      trimmed.length > MaxEnvSignalValueLength
        ? trimmed.slice(0, MaxEnvSignalValueLength)
        : trimmed;
  }

  return Object.keys(signals).length === 0 ? undefined : signals;
}

// Best-effort: any error returns None. Resolves workdir from `SUPABASE_WORKDIR` or
// `process.cwd()` since global flag services (`--workdir`) aren't accessible at this
// construction scope — so a lookup can miss group attribution when the user invokes from outside
// that directory.
function makeLoadLinkedProject(
  fs: FileSystem.FileSystem,
  path: Path.Path,
): Effect.Effect<Option.Option<LinkedProjectCacheValue>> {
  const workdir = process.env.SUPABASE_WORKDIR ?? process.cwd();
  const cachePath = path.join(workdir, "supabase", ".temp", "linked-project.json");
  return Effect.gen(function* () {
    const exists = yield* fs.exists(cachePath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) return Option.none<LinkedProjectCacheValue>();

    const content = yield* fs.readFileString(cachePath).pipe(Effect.option);
    if (Option.isNone(content)) return Option.none<LinkedProjectCacheValue>();

    try {
      const parsed = JSON.parse(content.value) as Partial<LinkedProjectCacheValue>;
      if (typeof parsed.ref !== "string" || typeof parsed.organization_slug !== "string") {
        return Option.none<LinkedProjectCacheValue>();
      }
      return Option.some<LinkedProjectCacheValue>({
        ref: parsed.ref,
        name: typeof parsed.name === "string" ? parsed.name : "",
        organization_id: typeof parsed.organization_id === "string" ? parsed.organization_id : "",
        organization_slug: parsed.organization_slug,
      });
    } catch {
      return Option.none<LinkedProjectCacheValue>();
    }
  }).pipe(Effect.catch(() => Effect.succeed(Option.none<LinkedProjectCacheValue>())));
}

export const analyticsLayer = Layer.effect(
  Analytics,
  Effect.gen(function* () {
    const runtime = yield* TelemetryRuntime;
    const aiTool = yield* AiTool;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const posthogConfig = resolvePosthogConfig(process.env);

    if (runtime.consent !== "granted" || Option.isNone(posthogConfig.key)) {
      return Analytics.of({
        capture: () => Effect.void,
        identify: () => Effect.void,
        alias: () => Effect.void,
        groupIdentify: () => Effect.void,
      });
    }

    const client = yield* scopedPosthogClient(posthogConfig.key.value, posthogConfig.host);

    const loadLinkedProject = makeLoadLinkedProject(fs, path);

    const isAgent = Option.isSome(aiTool.name);
    const envSignals = collectEnvSignals();

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
      [PropEnvSignals]: envSignals,
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
