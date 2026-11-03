import { Argument, Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";
import { withPermissions } from "../../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose, withContext } from "../../../../command-internal/command-permissions/model.ts";
import { projectRefPicker } from "../../../../config/project-ref.layer.ts";
import { linkedProjectCache } from "../../../../telemetry/linked-project-cache.layer.ts";
import { computeRead } from "../../../../shared/compute/compute-api.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../../command-internal/management-api-runtime.layer.ts";
import {
  COMPUTE_LOG_KINDS,
  COMPUTE_LOG_POLL_SECONDS,
} from "../../../../shared/compute/compute-logs.sql.ts";
import { withCommandTelemetry } from "../../../../telemetry/command-telemetry.ts";
import { computeLogs } from "./logs.handler.ts";
import { withTargetPolicy } from "../../../../command-internal/target/target-policy.ts";
import { branchResolution } from "../../../../command-internal/target/branch-resolution.ts";
import { projectTargetFlags } from "../../../../command-internal/target/target-flags.ts";

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
  name: Argument.String("name").pipe(Argument.withDescription("Compute to read logs for.")),
  ...projectTargetFlags(),
  kind: Flag.Literals("kind", COMPUTE_LOG_KINDS).pipe(
    Flag.withDescription(
      "Limit to one log stream: app (the compute's own output), requests (HTTP access), " +
        "builds (deploy lifecycle). Defaults to all three.",
    ),
    Flag.optional,
  ),
  follow: Flag.Boolean("follow").pipe(
    Flag.withAlias("f"),
    Flag.withDescription(
      `Keep printing new lines until interrupted, polling every ${COMPUTE_LOG_POLL_SECONDS} seconds.`,
    ),
    // Required: `Flag.Boolean` alone builds a *required* param, which breaks
    // invocations that omit the flag. `boolean-flag-defaults.unit.test.ts`
    // walks the command tree and fails any bare boolean.
    Flag.withDefault(false),
  ),
  tail: Flag.Int("tail").pipe(
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

export type ComputeLogsFlags = CliCommand.Command.Config.Infer<typeof config>;

export const computeLogsCommand = Command.make("logs", config).pipe(
  Command.withDescription(
    "Print a compute's recent logs: its own output, the HTTP requests it served, and its " +
      "deploy lifecycle events.\n\n" +
      "Covers the last 24 hours, which is the longest window the logs API will answer in one " +
      "query. Lines are printed oldest first.\n\n" +
      `Use --follow to keep printing new lines as they arrive. The logs API is rate limited, so ` +
      `following polls every ${COMPUTE_LOG_POLL_SECONDS} seconds rather than continuously; new ` +
      "lines can take that long to appear.",
  ),
  Command.withShortDescription("Show a compute's logs"),
  Command.withExamples([
    {
      command: "supabase compute logs api",
      description: "Print the last 100 log lines across all streams",
    },
    {
      command: "supabase compute logs api --kind requests --tail 20",
      description: "Print the 20 most recent HTTP requests the compute served",
    },
    {
      command: "supabase compute logs api --follow",
      description: "Print recent logs, then keep printing new lines until interrupted",
    },
    {
      command: "supabase compute logs api --tail 0 --follow",
      description: "Skip the backlog and print only lines that arrive from now on",
    },
  ]),
  withPermissions(
    compose(
      {
        operations: [
          {
            operationId: "v1-get-project-logs",
            kind: "required",
            context: "--tail isn't 0",
          },
          {
            operationId: "v1-get-project-logs",
            kind: "required",
            when: [{ flag: "follow", is: true }],
          },
        ],
        noApiEffectFlags: ["kind", "tail"],
      },
      withContext(computeRead, "the log query returned no rows, or --tail 0 with --follow"),
      projectRefPicker,
      linkedProjectCache,
      branchResolution,
    ),
  ),
  Command.withHandler((flags) =>
    computeLogs(flags).pipe(
      // `config` as well as `flags`: `--kind` is a choice flag, and the wrapper
      // treats a command's own declared choices as safe to log verbatim.
      withCommandTelemetry({ flags, config, aliases: { f: "follow" } }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(managementApiRuntimeLayer(["compute", "logs"])),
  withTargetPolicy({ group: "hosted", consent: "none" }),
);
