import { Config, Effect, FileSystem, Layer, Option, Path, Schema } from "effect";
import { aiToolLayer } from "../../shared/telemetry/ai-tool.layer.ts";
import { AiTool } from "../../shared/telemetry/ai-tool.service.ts";
import {
  CurrentAnalyticsContext,
  type AnalyticsContext,
} from "../../shared/telemetry/analytics-context.ts";
import { Analytics } from "../../shared/telemetry/analytics.service.ts";
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
} from "../../shared/telemetry/event-catalog.ts";
import { scopedPosthogClient } from "../../shared/telemetry/posthog-client.ts";
import { resolvePosthogConfig } from "../../shared/telemetry/posthog-config.ts";
import { telemetryRuntimeLayer } from "../../shared/telemetry/runtime.layer.ts";
import { TelemetryRuntime } from "../../shared/telemetry/runtime.service.ts";

interface LinkedProjectCacheValue {
  readonly ref: string;
  readonly name: string;
  readonly organization_id: string;
  readonly organization_slug: string;
}

const LinkedProjectCacheSchema = Schema.Struct({
  ref: Schema.String,
  name: Schema.optional(Schema.String),
  organization_id: Schema.optional(Schema.String),
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

// Builds the PostHog `groups` map for a captured event, or `undefined` when no
// group attribution applies. Go keys the organization group by the org ID (not
// the slug) for BOTH the GroupIdentify and the event groups
// (`linkedProjectGroups`, apps/cli-go/internal/telemetry/project.go:99-103); the
// slug is only a GroupIdentify property value. Keying events by slug would
// attach cli_command_executed to a different group than the identify published.
// Go also omits the org group when the ID is empty (project.go:99-100
// `if linked.OrganizationID != ""`).
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

// Mirrors apps/cli-go/cmd/root_analytics.go:149-165 envSignals().
export function collectEnvSignals(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, true | string> | undefined {
  const signals: Record<string, true | string> = {};

  for (const key of EnvSignalPresenceKeys) {
    const raw = env[key];
    if (raw === undefined) continue;
    if (raw.trim().length === 0) continue;
    signals[key] = true;
  }

  for (const key of EnvSignalValueKeys) {
    const raw = env[key];
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

// Mirrors apps/cli-go/internal/telemetry/project.go:40 LoadLinkedProject(fsys).
// Best-effort: any error returns None. Resolves workdir from `SUPABASE_WORKDIR`
// env or `process.cwd()`. The `--workdir` flag value is not accessible at
// root scope where the analytics layer is constructed (Effect CLI's global
// flag services are only available inside Command.runWith). When `--workdir` is
// set but the user invokes from outside that directory, the linked-project
// cache lookup misses and the event loses group attribution — matches Go's
// behaviour when the user runs without first `cd`-ing into the project.
function makeLoadLinkedProject(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
): Effect.Effect<Option.Option<LinkedProjectCacheValue>> {
  const cachePath = path.join(workdir, "supabase", ".temp", "linked-project.json");
  return Effect.gen(function* () {
    const exists = yield* fs.exists(cachePath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) return Option.none<LinkedProjectCacheValue>();

    const content = yield* fs.readFileString(cachePath).pipe(Effect.option);
    if (Option.isNone(content)) return Option.none<LinkedProjectCacheValue>();

    return yield* Schema.decodeEffect(Schema.fromJsonString(LinkedProjectCacheSchema))(
      content.value,
    ).pipe(
      Effect.map(({ ref, name, organization_id, organization_slug }) =>
        Option.some<LinkedProjectCacheValue>({
          ref,
          name: name ?? "",
          organization_id: organization_id ?? "",
          organization_slug,
        }),
      ),
      Effect.orElseSucceed(() => Option.none<LinkedProjectCacheValue>()),
    );
  });
}

export const legacyAnalyticsLayer = Layer.effect(
  Analytics,
  Effect.gen(function* () {
    const runtime = yield* TelemetryRuntime;
    const aiTool = yield* AiTool;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const envKeys = [
      ...EnvSignalPresenceKeys,
      ...EnvSignalValueKeys,
      "SUPABASE_WORKDIR",
      "SUPABASE_TELEMETRY_POSTHOG_HOST",
      "SUPABASE_TELEMETRY_POSTHOG_KEY",
      "SUPABASE_CLI_POSTHOG_HOST",
      "SUPABASE_CLI_POSTHOG_KEY",
    ];
    const envEntries = yield* Effect.all(
      [...new Set(envKeys)].map((key) =>
        Config.option(Config.string(key)).pipe(
          Effect.map((value) => [key, Option.getOrUndefined(value)] as const),
        ),
      ),
    );
    const env = Object.fromEntries(envEntries);
    const posthogConfig = resolvePosthogConfig(env);

    if (runtime.consent !== "granted" || Option.isNone(posthogConfig.key)) {
      return Analytics.of({
        capture: () => Effect.void,
        identify: () => Effect.void,
        alias: () => Effect.void,
        groupIdentify: () => Effect.void,
      });
    }

    const client = yield* scopedPosthogClient(posthogConfig.key.value, posthogConfig.host);

    const loadLinkedProject = makeLoadLinkedProject(
      fs,
      path,
      env.SUPABASE_WORKDIR ?? process.cwd(),
    );

    const isAgent = Option.isSome(aiTool.name);
    const envSignals = collectEnvSignals(env);

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
