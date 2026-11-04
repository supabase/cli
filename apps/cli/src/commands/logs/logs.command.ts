import { OptionalSubcommand } from "../../shared/output/optional-subcommand-usage.ts";
import { Layer } from "effect";
import { Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";
import { GLOBAL_OUTPUT_FORMATS } from "../../command-internal/global-flags.ts";
import { withPermissions } from "../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose } from "../../command-internal/command-permissions/model.ts";
import { identityStitchLayer } from "../../command-internal/identity-stitch.ts";
import { projectRefPicker } from "../../config/project-ref.layer.ts";
import { linkedProjectCache } from "../../telemetry/linked-project-cache.layer.ts";
import { branchResolution } from "../../command-internal/target/branch-resolution.ts";
import { targetFlags } from "../../command-internal/target/target-flags.ts";
import { withTargetPolicy } from "../../command-internal/target/target-policy.ts";
import { withCommandTelemetry } from "../../telemetry/command-telemetry.ts";
import { withJsonErrorHandling } from "../../shared/output/json-error-handling.ts";
import { linkedDbResolverRuntimeLayer } from "../../command-internal/management-api-runtime.layer.ts";
import { stdinLayer } from "../../shared/runtime/stdin.layer.ts";
import { stackTargetResolverLayer, stackApiLayer } from "../../command-internal/stack-target.ts";
import { logsTerminalLayer } from "./logs.browser.ts";
import { logsClipboardLayer } from "./logs.clipboard.ts";
import { logs, logsSources } from "./logs.handler.ts";

const stackFlags = {
  stack: Flag.String("stack").pipe(
    Flag.withDescription("Select a local stack by name."),
    Flag.optional,
  ),
  stackId: Flag.String("stack-id").pipe(
    Flag.withDescription("Select a local stack by ID."),
    Flag.optional,
  ),
};
const config = {
  ...targetFlags({ subject: "log source", dbUrl: false }),
  ...stackFlags,
  service: Flag.String("service").pipe(
    Flag.withDescription("Service selector; repeat for multiple services. See logs sources."),
    Flag.atLeast(0),
  ),
  resource: Flag.String("resource").pipe(
    Flag.withDescription("Compute name or function ID remotely, or a local instance ID."),
    Flag.optional,
  ),
  kind: Flag.Literals("kind", ["app", "requests", "builds"]).pipe(
    Flag.withDescription("Compute stream; requires --service compute."),
    Flag.optional,
  ),
  level: Flag.Literals("level", [
    "error",
    "warn",
    "warning",
    "info",
    "debug",
    "log",
    "notice",
  ]).pipe(Flag.withDescription("Severity filter; repeat for several levels."), Flag.atLeast(0)),
  search: Flag.String("search").pipe(
    Flag.withDescription("Case-insensitive message substring (hosted only)."),
    Flag.optional,
  ),
  since: Flag.String("since").pipe(
    Flag.withDescription(
      "Duration or UTC timestamp; defaults to 1h. Local stacks also accept start.",
    ),
    Flag.optional,
  ),
  from: Flag.String("from").pipe(
    Flag.withDescription("Start at a UTC timestamp ending in Z."),
    Flag.optional,
  ),
  to: Flag.String("to").pipe(
    Flag.withDescription("Initial end at a UTC timestamp ending in Z. L advances to now."),
    Flag.optional,
  ),
  limit: Flag.Int("limit").pipe(
    Flag.withDescription(
      "Initial filtered history count (default 100, maximum 1000). SQL controls its own LIMIT.",
    ),
    Flag.filter(
      (value) => value >= 1 && value <= 1000,
      () => "--limit must be between 1 and 1000.",
    ),
    Flag.withDefault(100),
  ),
  sql: Flag.String("sql").pipe(
    Flag.withDescription("Custom hosted log SQL; requires --remote. L reruns the query."),
    Flag.optional,
  ),
  file: Flag.String("file").pipe(
    Flag.withAlias("f"),
    Flag.withDescription("Read custom hosted log SQL from a file."),
    Flag.optional,
  ),
};
const sourcesConfig = {
  ...targetFlags({ subject: "log source", dbUrl: false }),
  ...stackFlags,
  service: Flag.String("service").pipe(
    Flag.withDescription("Describe one service."),
    Flag.optional,
  ),
};

export type LogsSourcesFlags = CliCommand.Command.Config.Infer<typeof sourcesConfig>;

const readPermissions = (flags: ReadonlyArray<string>) =>
  compose(
    {
      operations: [
        {
          operationId: "v1-get-project-logs",
          kind: "required",
          context: "the hosted target is selected",
        },
      ],
      noApiEffectFlags: [...flags],
    },
    projectRefPicker,
    linkedProjectCache,
    branchResolution,
  );

const logsReadFlags = [
  "stack",
  "stack-id",
  "service",
  "resource",
  "kind",
  "level",
  "search",
  "since",
  "from",
  "to",
  "limit",
  "sql",
  "file",
];

export const logsCommandFor = (localEnabled: boolean, computeEnabled = false) =>
  Command.make("logs", config).pipe(
    Command.annotate(OptionalSubcommand, true),
    Command.withDescription(
      "Browse local or hosted logs. Arrows select, Enter details, C copies, L loads more logs, and q quits. Custom SQL uses L to rerun. Pipes and machine output read once.",
    ),
    withPermissions(readPermissions(logsReadFlags)),
    Command.withHandler((flags) =>
      logs(flags, localEnabled, computeEnabled).pipe(
        withCommandTelemetry({ flags, config, outputFormats: GLOBAL_OUTPUT_FORMATS }),
        withJsonErrorHandling,
      ),
    ),
    Command.provide(logsTerminalLayer),
    Command.provide(logsClipboardLayer),
    Command.provide(stdinLayer),
    Command.provide(stackTargetResolverLayer.pipe(Layer.provideMerge(stackApiLayer))),
    Command.provide(
      linkedDbResolverRuntimeLayer(["logs"]).pipe(Layer.provide(identityStitchLayer)),
    ),
    withTargetPolicy({
      group: "selectable",
      consent: "none",
      consentExemptReason: "Reads logs without mutating the selected target.",
    }),
    Command.withSubcommands([
      Command.make("sources", sourcesConfig).pipe(
        Command.withDescription(
          "List supported sources and filters. Hosted entries describe capabilities and do not imply that rows exist. Local entries list retained stack instances.",
        ),
        withPermissions(
          compose(
            { operations: [], noApiEffectFlags: logsReadFlags },
            projectRefPicker,
            branchResolution,
          ),
        ),
        Command.withHandler((flags) =>
          logsSources(flags, localEnabled, computeEnabled).pipe(
            withCommandTelemetry({
              flags,
              config: sourcesConfig,
              outputFormats: GLOBAL_OUTPUT_FORMATS,
            }),
            withJsonErrorHandling,
          ),
        ),
        Command.provide(stackTargetResolverLayer.pipe(Layer.provideMerge(stackApiLayer))),
        Command.provide(
          linkedDbResolverRuntimeLayer(["logs", "sources"]).pipe(
            Layer.provide(identityStitchLayer),
          ),
        ),
        withTargetPolicy({
          group: "selectable",
          consent: "none",
          consentExemptReason: "Lists log capabilities without mutating the selected target.",
        }),
      ),
    ]),
  );
