import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../../../shared/output/json-error-handling.ts";
import { legacyManagementApiRuntimeLayer } from "../../../../shared/legacy-management-api-runtime.layer.ts";
import { withLegacyCommandInstrumentation } from "../../../../telemetry/legacy-command-instrumentation.ts";
import { legacyWorkersLogs } from "./logs.handler.ts";

/** The `--source` words, mapped to stream names in `worker-logs.sql.ts`. */
const SOURCE_VALUES = ["app", "requests", "builds"] as const;

/**
 * The endpoint's own ceiling is the SQL `LIMIT`, so this bound is the CLI's
 * choice. 1000 is high enough to be a non-issue in practice and low enough that a
 * typo cannot ask for a payload nobody wants.
 *
 * 0 is allowed and means "no history", which only becomes useful alongside
 * `--follow`; on its own it prints nothing and makes no request.
 */
const MAX_TAIL = 1000;

const config = {
  name: Argument.string("name").pipe(Argument.withDescription("Worker to read logs for.")),
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  source: Flag.choice("source", SOURCE_VALUES).pipe(
    Flag.withDescription(
      "Limit to one log stream: app (the worker's own output), requests (HTTP access), " +
        "builds (deploy lifecycle). Defaults to all three.",
    ),
    Flag.optional,
  ),
  tail: Flag.integer("tail").pipe(
    Flag.filter(
      (tail) => tail >= 0 && tail <= MAX_TAIL,
      (tail) => `Expected --tail between 0 and ${MAX_TAIL}, got ${tail}`,
    ),
    Flag.withDescription("Number of log lines to print."),
    Flag.withDefault(100),
  ),
} as const;

export type LegacyWorkersLogsFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyWorkersLogsCommand = Command.make("logs", config).pipe(
  Command.withDescription(
    "Print a worker's recent logs: its own output, the HTTP requests it served, and its " +
      "deploy lifecycle events.\n\n" +
      "Covers the last 24 hours, which is the longest window the logs API will answer in one " +
      "query. Lines are printed oldest first.",
  ),
  Command.withShortDescription("Show a worker's logs"),
  Command.withExamples([
    {
      command: "supabase experimental workers logs api",
      description: "Print the last 100 log lines across all streams",
    },
    {
      command: "supabase experimental workers logs api --source requests --tail 20",
      description: "Print the 20 most recent HTTP requests the worker served",
    },
  ]),
  Command.withHandler((flags) =>
    legacyWorkersLogs(flags).pipe(
      // `config` as well as `flags`: `--source` is a choice flag, and the wrapper
      // treats a command's own declared choices as safe to log verbatim.
      withLegacyCommandInstrumentation({ flags, config }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyManagementApiRuntimeLayer(["experimental", "workers", "logs"])),
);
