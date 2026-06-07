import { PostHog } from "posthog-node";
import { Effect, Layer, Option } from "effect";
import type { ProjectLinkStateValue } from "../../next/config/project-link-state.service.ts";
import { ProjectLinkState } from "../../next/config/project-link-state.service.ts";
import { CliConfig } from "../../next/config/cli-config.service.ts";
import { aiToolLayer } from "./ai-tool.layer.ts";
import { CurrentAnalyticsContext, type AnalyticsContext } from "./analytics-context.ts";
import { Analytics } from "./analytics.service.ts";
import { AiTool } from "./ai-tool.service.ts";
import { telemetryRuntimeLayer } from "./runtime.layer.ts";
import { TelemetryRuntime } from "./runtime.service.ts";

function stripUndefined(properties: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(properties).filter(([, value]) => value !== undefined));
}

function contextProperties(context: AnalyticsContext): Record<string, unknown> {
  return stripUndefined({
    command_run_id: context.command_run_id,
    command: context.command,
    flags_used: context.flags_used,
    flag_values: context.flag_values,
  });
}

function resolveGroups(
  context: AnalyticsContext,
  linkedProject: Option.Option<ProjectLinkStateValue>,
): { organization: string; project: string } | undefined {
  if (context.groups?.organization !== undefined && context.groups.project !== undefined) {
    return {
      organization: context.groups.organization,
      project: context.groups.project,
    };
  }

  return Option.match(linkedProject, {
    onNone: () => undefined,
    onSome: (state) => ({
      organization: state.project.organization_slug,
      project: state.project.ref,
    }),
  });
}

export const analyticsLayer = Layer.effect(
  Analytics,
  Effect.gen(function* () {
    const runtime = yield* TelemetryRuntime;
    const cliConfig = yield* CliConfig;
    const aiTool = yield* AiTool;

    if (runtime.consent !== "granted" || Option.isNone(cliConfig.telemetryPosthogKey)) {
      return Analytics.of({
        capture: () => Effect.void,
        identify: () => Effect.void,
        alias: () => Effect.void,
        groupIdentify: () => Effect.void,
      });
    }

    const client = new PostHog(cliConfig.telemetryPosthogKey.value, {
      host: cliConfig.telemetryPosthogHost,
      flushAt: 1,
      flushInterval: 0,
    });
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => client._shutdown(5_000)).pipe(Effect.ignore),
    );

    const baseProperties = stripUndefined({
      platform: "cli",
      schema_version: 1,
      device_id: runtime.deviceId,
      $session_id: runtime.sessionId,
      is_first_run: runtime.isFirstRun,
      is_tty: runtime.isTty,
      is_ci: runtime.isCi,
      ai_tool: Option.match(aiTool.name, {
        onNone: () => (runtime.isCi ? "ci" : runtime.isTty ? undefined : "unknown_non_interactive"),
        onSome: (name) => name,
      }),
      os: runtime.os,
      arch: runtime.arch,
      cli_version: runtime.cliVersion,
    });

    const capture = (event: string, properties: Record<string, unknown> = {}) =>
      Effect.gen(function* () {
        const context = yield* CurrentAnalyticsContext;
        const maybeProjectLinkState = yield* Effect.serviceOption(ProjectLinkState);
        const linkedProject = yield* Option.match(maybeProjectLinkState, {
          onNone: () => Effect.succeed(Option.none<ProjectLinkStateValue>()),
          onSome: (projectLinkState) =>
            projectLinkState.load.pipe(
              Effect.catch(() => Effect.succeed(Option.none<ProjectLinkStateValue>())),
            ),
        });
        const groups = resolveGroups(context, linkedProject);

        client.capture({
          event,
          distinctId: context.distinct_id ?? runtime.distinctId ?? runtime.deviceId,
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
          distinctId: context.distinct_id ?? runtime.distinctId ?? runtime.deviceId,
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
