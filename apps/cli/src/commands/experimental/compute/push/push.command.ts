import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { COMPUTE_EXPOSURES } from "../../../../shared/compute/compute-runtimes.ts";
import { managementApiRuntimeLayer } from "../../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../../telemetry/command-telemetry.ts";
import { computePush } from "./push.handler.ts";

const config = {
  names: Argument.string("name").pipe(
    Argument.withDescription("Compute to deploy. Deploys every compute in the project if omitted."),
    Argument.variadic(),
  ),
  instances: Flag.integer("instances").pipe(
    // Bounded at the parser: left unchecked, a negative value reached the deploy
    // endpoint after the build context was already packaged and uploaded.
    Flag.filter(
      (instances) => instances >= 0,
      (instances) => `--instances ${instances} is negative; pass zero or more.`,
    ),
    Flag.withDescription(
      "Number of instances to run, overriding `instances` in supabase/config.toml for this deploy. Falls back to the recorded value, then 1.",
    ),
    Flag.optional,
  ),
  exposure: Flag.choice("exposure", COMPUTE_EXPOSURES).pipe(
    // A closed set at the parser, the way `new --runtime` and `new --size` are:
    // the accepted values get listed in the refusal, and nothing unrecognized
    // reaches the deploy endpoint after a build context has been uploaded.
    // `[compute.<name>] exposure` stays a plain string, so a value the API
    // grows before this CLI does can still be recorded there.
    Flag.withDescription(
      "Whether the compute is reachable from the internet, overriding `exposure` in supabase/config.toml for this deploy. Falls back to the recorded value, then public.",
    ),
    Flag.optional,
  ),
  noWait: Flag.boolean("no-wait").pipe(
    // The deploy POST returns once the platform accepts the spec and context; the
    // server-side build that follows can run for minutes. Waiting stays the
    // default so a plain push reports the build's verdict; `--no-wait` opts out
    // for callers that only need the deploy accepted.
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

export type ComputePushFlags = CliCommand.Command.Config.Infer<typeof config>;

export const computePushCommand = Command.make("push", config).pipe(
  Command.withAlias("deploy"),
  Command.withDescription(
    "Build and deploy compute into the linked Supabase project. Reads each compute's runtime, size, exposure and source directory from supabase/config.toml.",
  ),
  Command.withShortDescription("Build and deploy compute"),
  Command.withExamples([
    {
      command: "supabase compute push",
      description: "Deploy every compute in the project",
    },
    {
      command: "supabase compute push api",
      description: "Deploy a single compute",
    },
    {
      command: "supabase compute push api web",
      description: "Deploy several compute by name",
    },
    {
      command: "supabase compute push api --exposure private",
      description: "Deploy without an internet-facing URL",
    },
    {
      command: "supabase compute push api --no-wait",
      description: "Deploy without blocking on the build",
    },
  ]),
  Command.withHandler((flags) =>
    computePush(flags).pipe(withCommandTelemetry({ flags, config }), withJsonErrorHandling),
  ),
  Command.provide(managementApiRuntimeLayer(["compute", "push"])),
);
