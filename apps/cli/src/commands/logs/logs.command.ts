import { Layer } from "effect";
import { identityStitchLayer } from "../../command-internal/identity-stitch.ts";
import { Argument, Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";
import { withPermissions } from "../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose } from "../../command-internal/command-permissions/model.ts";
import { projectRefPicker } from "../../config/project-ref.layer.ts";
import { linkedProjectCache } from "../../telemetry/linked-project-cache.layer.ts";
import { branchResolution } from "../../command-internal/target/branch-resolution.ts";
import { projectTargetFlags, targetFlags } from "../../command-internal/target/target-flags.ts";
import { withTargetPolicy } from "../../command-internal/target/target-policy.ts";
import { withCommandTelemetry } from "../../telemetry/command-telemetry.ts";
import { withJsonErrorHandling } from "../../shared/output/json-error-handling.ts";
import { linkedDbResolverRuntimeLayer } from "../../command-internal/management-api-runtime.layer.ts";
import { stdinLayer } from "../../shared/runtime/stdin.layer.ts";
import { stackTargetResolverLayer, stackApiLayer } from "../../command-internal/stack-target.ts";
import { logsQuery, logsTail, logsSources } from "./logs.handler.ts";

const sinceFlag = Flag.String("since").pipe(
  Flag.withDescription("Read from a duration ago or a UTC timestamp; defaults to 1h."),
  Flag.optional,
);
const stackFlags = {
  stack: Flag.String("stack").pipe(
    Flag.withDescription("Select an existing local stack by name."),
    Flag.optional,
  ),
  stackId: Flag.String("stack-id").pipe(
    Flag.withDescription("Select an existing local stack by ID or unique prefix."),
    Flag.optional,
  ),
};
const queryConfig = {
  ...projectTargetFlags(),
  local: targetFlags({ subject: "log source", dbUrl: false, visibleLocal: true }).local,
  sql: Argument.String("sql").pipe(
    Argument.withDescription("SQL for hosted logs, not Postgres."),
    Argument.optional,
  ),
  file: Flag.String("file").pipe(
    Flag.withAlias("f"),
    Flag.withDescription("Read SQL from a file."),
    Flag.optional,
  ),
  since: sinceFlag,
  from: Flag.String("from").pipe(
    Flag.withDescription("Start at a UTC timestamp ending in Z."),
    Flag.optional,
  ),
  to: Flag.String("to").pipe(
    Flag.withDescription("End at a UTC timestamp ending in Z."),
    Flag.optional,
  ),
};
const tailConfig = {
  ...targetFlags({ subject: "log source", dbUrl: false, visibleLocal: true }),
  ...stackFlags,
  service: Flag.String("service").pipe(
    Flag.withDescription("Service selector; repeat for multiple services. See logs sources."),
    Flag.atLeast(0),
  ),
  resource: Flag.String("resource").pipe(
    Flag.withDescription("Compute name or function ID remotely, or local service instance ID."),
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
    Flag.withDescription("Case-insensitive literal message substring (hosted only)."),
    Flag.optional,
  ),
  since: sinceFlag,
  tail: Flag.Int("tail").pipe(
    Flag.withDescription("History line count (default 100, maximum 1000); 0 skips history."),
    Flag.filter(
      (value) => value >= 0 && value <= 1000,
      () => "--tail must be between 0 and 1000.",
    ),
    Flag.withDefault(100),
  ),
  noFollow: Flag.Boolean("no-follow").pipe(
    Flag.withDescription("Print history and exit."),
    Flag.withDefault(false),
  ),
};
const sourcesConfig = {
  ...targetFlags({ subject: "log source", dbUrl: false, visibleLocal: true }),
  ...stackFlags,
  service: Flag.String("service").pipe(
    Flag.withDescription("Describe one service."),
    Flag.optional,
  ),
};
export type LogsQueryFlags = CliCommand.Command.Config.Infer<typeof queryConfig>;
export type LogsTailFlags = CliCommand.Command.Config.Infer<typeof tailConfig>;
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

export const logsCommandFor = (localEnabled: boolean, computeEnabled = false) =>
  Command.make("logs").pipe(
    Command.withDescription(
      "Query hosted logs, follow hosted or retained local logs, and discover supported sources.",
    ),
    Command.withSubcommands([
      Command.make("query", queryConfig).pipe(
        Command.withDescription(
          "Run hosted log SQL from one argument, --file, or stdin. Ranges are limited to 24 hours. Use -o table, json, or csv.",
        ),
        withPermissions(readPermissions(["local", "file", "since", "from", "to"])),
        Command.withHandler((flags) =>
          logsQuery(flags).pipe(
            withCommandTelemetry({ flags, config: queryConfig }),
            withJsonErrorHandling,
          ),
        ),
        Command.provide(stdinLayer),
        Command.provide(
          linkedDbResolverRuntimeLayer(["logs", "query"]).pipe(Layer.provide(identityStitchLayer)),
        ),
        withTargetPolicy({
          group: "hosted",
          consent: "none",
          consentExemptReason: "Runs read-only hosted log SQL through the analytics endpoint.",
        }),
      ),
      Command.make("tail", tailConfig).pipe(
        Command.withDescription(
          "Print recent logs and follow until interrupted. Defaults to local, the last hour, and 100 lines. Use --no-follow to exit after history, -o json for JSON Lines.",
        ),
        withPermissions(
          readPermissions([
            "stack",
            "stack-id",
            "service",
            "resource",
            "kind",
            "level",
            "search",
            "since",
            "tail",
            "no-follow",
          ]),
        ),
        Command.withHandler((flags) =>
          logsTail(flags, localEnabled, computeEnabled).pipe(
            withCommandTelemetry({ flags, config: tailConfig }),
            withJsonErrorHandling,
          ),
        ),
        Command.provide(stackTargetResolverLayer.pipe(Layer.provideMerge(stackApiLayer))),
        Command.provide(
          linkedDbResolverRuntimeLayer(["logs", "tail"]).pipe(Layer.provide(identityStitchLayer)),
        ),
        withTargetPolicy({
          group: "selectable",
          consent: "none",
          consentExemptReason: "Reads logs without mutating the selected target.",
        }),
      ),
      Command.make("sources", sourcesConfig).pipe(
        Command.withDescription(
          "List supported sources and filters. Hosted entries describe capabilities and do not imply that rows exist. Local entries list retained stack instances.",
        ),
        withPermissions(
          compose(
            { operations: [], noApiEffectFlags: ["stack", "stack-id", "service"] },
            projectRefPicker,
            branchResolution,
          ),
        ),
        Command.withHandler((flags) =>
          logsSources(flags, localEnabled, computeEnabled).pipe(
            withCommandTelemetry({ flags, config: sourcesConfig }),
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
