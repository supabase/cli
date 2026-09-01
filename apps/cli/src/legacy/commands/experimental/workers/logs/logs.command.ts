import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../../../shared/output/json-error-handling.ts";
import { legacyManagementApiRuntimeLayer } from "../../../../shared/legacy-management-api-runtime.layer.ts";
import { WORKER_LOG_POLL_SECONDS } from "../../../../../shared/workers/worker-logs.sql.ts";
import { withLegacyCommandInstrumentation } from "../../../../telemetry/legacy-command-instrumentation.ts";
import { legacyWorkersLogs } from "./logs.handler.ts";

/** The `--kind` words, mapped to stream names in `worker-logs.sql.ts`. */
const KIND_VALUES = ["app", "requests", "builds"] as const;

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
  kind: Flag.choice("kind", KIND_VALUES).pipe(
    Flag.withDescription(
      "Limit to one log stream: app (the worker's own output), requests (HTTP access), " +
        "builds (deploy lifecycle). Defaults to all three.",
    ),
    Flag.optional,
  ),
  follow: Flag.boolean("follow").pipe(
    Flag.withAlias("f"),
    Flag.withDescription(
      `Keep printing new lines until interrupted, polling every ${WORKER_LOG_POLL_SECONDS} seconds.`,
    ),
    // Required: `Flag.boolean` alone builds a *required* param, which breaks
    // invocations that omit the flag. `legacy-boolean-flag-defaults.unit.test.ts`
    // walks the command tree and fails any bare boolean.
    Flag.withDefault(false),
  ),
  tail: Flag.integer("tail").pipe(
    Flag.filter(
      (tail) => tail >= 0 && tail <= MAX_TAIL,
      (tail) => `Expected --tail between 0 and ${MAX_TAIL}, got ${tail}`,
    ),
    Flag.withDescription(
      "Number of log lines to print. Use 0 with --follow to skip history and print only new lines.",
    ),
    Flag.withDefault(100),
  ),
} as const;

export type LegacyWorkersLogsFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyWorkersLogsCommand = Command.make("logs", config).pipe(
  Command.withDescription(
    "Print a worker's recent logs: its own output, the HTTP requests it served, and its " +
      "deploy lifecycle events.\n\n" +
      "Covers the last 24 hours, which is the longest window the logs API will answer in one " +
      "query. Lines are printed oldest first.\n\n" +
      `Use --follow to keep printing new lines as they arrive. The logs API is rate limited, so ` +
      `following polls every ${WORKER_LOG_POLL_SECONDS} seconds rather than continuously; new ` +
      "lines can take that long to appear.",
  ),
  Command.withShortDescription("Show a worker's logs"),
  Command.withExamples([
    {
      command: "supabase experimental workers logs api",
      description: "Print the last 100 log lines across all streams",
    },
    {
      command: "supabase experimental workers logs api --kind requests --tail 20",
      description: "Print the 20 most recent HTTP requests the worker served",
    },
    {
      command: "supabase experimental workers logs api --follow",
      description: "Print recent logs, then keep printing new lines until interrupted",
    },
    {
      command: "supabase experimental workers logs api --tail 0 --follow",
      description: "Skip the backlog and print only lines that arrive from now on",
    },
  ]),
  Command.withHandler((flags) =>
    legacyWorkersLogs(flags).pipe(
      // `config` as well as `flags`: `--kind` is a choice flag, and the wrapper
      // treats a command's own declared choices as safe to log verbatim.
      withLegacyCommandInstrumentation({ flags, config }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyManagementApiRuntimeLayer(["experimental", "workers", "logs"])),
);
