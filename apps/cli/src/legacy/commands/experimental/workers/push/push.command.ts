import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../../../shared/output/json-error-handling.ts";
import { WORKER_EXPOSURES } from "../../../../../shared/workers/worker-runtimes.ts";
import { legacyManagementApiRuntimeLayer } from "../../../../shared/legacy-management-api-runtime.layer.ts";
import { withLegacyCommandInstrumentation } from "../../../../telemetry/legacy-command-instrumentation.ts";
import { legacyWorkersPush } from "./push.handler.ts";

const config = {
  names: Argument.string("name").pipe(
    Argument.withDescription("Workers to deploy. Deploys every worker in the project if omitted."),
    Argument.variadic(),
  ),
  instances: Flag.integer("instances").pipe(
    // Bounded at the parser, the same way `[workers.<name>] instances` is bounded
    // in the config schema. Left unchecked it reached the deploy endpoint — after
    // the build context had been packaged and uploaded — as a scaling request the
    // platform cannot honour.
    Flag.filter(
      (instances) => instances >= 0,
      (instances) => `--instances ${instances} is negative; pass zero or more.`,
    ),
    Flag.withDescription(
      "Number of instances to run, overriding `instances` in supabase/config.toml for this deploy. Falls back to the recorded value, then 1.",
    ),
    Flag.optional,
  ),
  exposure: Flag.choice("exposure", WORKER_EXPOSURES).pipe(
    // A closed set at the parser, the way `new --runtime` and `new --size` are:
    // the accepted values get listed in the refusal, and nothing unrecognized
    // reaches the deploy endpoint after a build context has been uploaded.
    // `[workers.<name>] exposure` stays a plain string, so a value the API
    // grows before this CLI does can still be recorded there.
    Flag.withDescription(
      "Whether the worker is reachable from the internet, overriding `exposure` in supabase/config.toml for this deploy. Falls back to the recorded value, then public.",
    ),
    Flag.optional,
  ),
  noWait: Flag.boolean("no-wait").pipe(
    // The deploy POST is answered once the platform has accepted the spec and
    // the uploaded context, and the server-side container build that follows
    // routinely runs for minutes. Waiting stays the default so a plain push
    // still reports the build's verdict, and `--no-wait` is the opt-out for the
    // callers — an inner-loop redeploy, a fire-and-forget CI step — that only
    // need the deploy accepted.
    Flag.withDescription(
      "Return once the deploy is accepted, without waiting for the server-side build to finish.",
    ),
    Flag.withDefault(false),
  ),
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
} as const;

export type LegacyWorkersPushFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyWorkersPushCommand = Command.make("push", config).pipe(
  Command.withAlias("deploy"),
  Command.withDescription(
    "Build and deploy workers into the linked Supabase project. Reads each worker's runtime, size, exposure and source directory from supabase/config.toml.",
  ),
  Command.withShortDescription("Build and deploy workers"),
  Command.withExamples([
    {
      command: "supabase experimental workers push",
      description: "Deploy every worker in the project",
    },
    {
      command: "supabase experimental workers push api",
      description: "Deploy a single worker",
    },
    {
      command: "supabase experimental workers push api web",
      description: "Deploy several workers by name",
    },
    {
      command: "supabase experimental workers push api --exposure private",
      description: "Deploy without an internet-facing URL",
    },
    {
      command: "supabase experimental workers push api --no-wait",
      description: "Deploy without blocking on the build",
    },
  ]),
  Command.withHandler((flags) =>
    legacyWorkersPush(flags).pipe(
      withLegacyCommandInstrumentation({ flags, config }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyManagementApiRuntimeLayer(["experimental", "workers", "push"])),
);
