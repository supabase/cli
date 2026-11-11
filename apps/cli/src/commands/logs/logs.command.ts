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
import { cliFlag, makeCommand, repeated } from "../../shared/cli/cli-params.ts";

const stackFlags = {
  stack: cliFlag("stack", Flag.String, {
    description: "Select a local stack by name.",
    optional: true,
  }),
  stackId: cliFlag("stack-id", Flag.String, {
    description: "Select a local stack by ID.",
    optional: true,
  }),
};
const config = {
  ...targetFlags({ subject: "log source", dbUrl: false }),
  ...stackFlags,
  service: cliFlag("service", repeated(Flag.String, { min: 0 }), {
    description: "Service selector; repeat for multiple services. See logs sources.",
  }),
  resource: cliFlag("resource", Flag.String, {
    description: "Compute name or function ID remotely, or a local instance ID.",
    optional: true,
  }),
  kind: cliFlag("kind", (name) => Flag.Literals(name, ["app", "requests", "builds"]), {
    description: "Compute stream; requires --service compute.",
    optional: true,
  }),
  level: cliFlag(
    "level",
    repeated(
      (name) => Flag.Literals(name, ["error", "warn", "warning", "info", "debug", "log", "notice"]),
      { min: 0 },
    ),
    { description: "Severity filter; repeat for several levels." },
  ),
  search: cliFlag("search", Flag.String, {
    description: "Case-insensitive message substring (hosted only).",
    optional: true,
  }),
  since: cliFlag("since", Flag.String, {
    description: "Duration or UTC timestamp; defaults to 1h. Local stacks also accept start.",
    optional: true,
  }),
  from: cliFlag("from", Flag.String, {
    description: "Start at a UTC timestamp ending in Z.",
    optional: true,
  }),
  to: cliFlag("to", Flag.String, {
    description: "Initial end at a UTC timestamp ending in Z. L advances to now.",
    optional: true,
  }),
  limit: cliFlag("limit", Flag.Int, {
    description:
      "Initial filtered history count (default 100, maximum 1000). SQL controls its own LIMIT.",
    parse: Flag.filter(
      (value) => value >= 1 && value <= 1000,
      () => "--limit must be between 1 and 1000.",
    ),
    default: 100,
  }),
  sql: cliFlag("sql", Flag.String, {
    description: "Custom hosted log SQL; requires --remote. L reruns the query.",
    optional: true,
  }),
  file: cliFlag("file", Flag.String, {
    description: "Read custom hosted log SQL from a file; use - to read stdin.",
    optional: true,
  }),
};
const sourcesConfig = {
  ...targetFlags({ subject: "log source", dbUrl: false }),
  ...stackFlags,
  service: cliFlag("service", Flag.String, {
    description: "Describe one service.",
    optional: true,
  }),
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

export const logsCommandFor = () =>
  makeCommand("logs", config).pipe(
    Command.annotate(OptionalSubcommand, true),
    Command.withDescription(
      "Browse local or hosted logs. Arrows select, Enter details, C copies, L loads more logs, and q quits. Custom SQL uses L to rerun. Pipes and machine output read once. Explicit --output-format text disables the viewer. Use --output-format json|stream-json for structured output; -o/--output is unsupported.",
    ),
    Command.withExamples([
      {
        command: "supabase logs --remote --service postgres --level error --since 30m",
        description: "Browse hosted Postgres errors",
      },
      {
        command:
          'supabase logs --remote --service auth --search "invalid token" --output-format text',
        description: "Read plain text once",
      },
      {
        command: "supabase logs --remote --service postgres --output-format json",
        description: "Export full records as JSON",
      },
      {
        command: "cat errors.sql | supabase logs --remote --file - --output-format json",
        description: "Query hosted logs with SQL from stdin",
      },
    ]),
    withPermissions(readPermissions(logsReadFlags)),
    Command.withHandler((flags) =>
      logs(flags).pipe(
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
      makeCommand("sources", sourcesConfig).pipe(
        Command.withDescription(
          "List supported sources and filters. Hosted entries describe capabilities and do not imply that rows exist. Local entries list retained stack instances. Use --output-format json|stream-json for structured output; -o/--output is unsupported.",
        ),
        withPermissions(
          compose(
            { operations: [], noApiEffectFlags: logsReadFlags },
            projectRefPicker,
            branchResolution,
          ),
        ),
        Command.withHandler((flags) =>
          logsSources(flags).pipe(
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
