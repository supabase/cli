import { BunServices } from "@effect/platform-bun";
import { Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { credentialsLayer } from "../../../auth/credentials.layer.ts";
import { platformApiLayer } from "../../../auth/platform-api.layer.ts";
import { projectLinkStateLayer } from "../../../config/project-link-state.layer.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import { withCommandInstrumentation } from "../../../../shared/telemetry/command-instrumentation.ts";
import { workersPush } from "./push.handler.ts";

const config = {
  name: Argument.string("name").pipe(
    Argument.withDescription("Worker to deploy. Inferred when run from inside its directory."),
    Argument.optional,
  ),
  instances: Flag.integer("instances").pipe(
    Flag.withDescription("Number of instances to run."),
    Flag.withDefault(1),
  ),
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
} as const;

export type WorkersPushFlags = CliCommand.Command.Config.Infer<typeof config>;

/**
 * The build context is PUT straight at a presigned URL, so this command needs a
 * plain HTTP client of its own alongside the authenticated Management API
 * client — the bytes never pass through `api.supabase.com`.
 */
const workersPushRuntimeLayer = (commandPath: ReadonlyArray<string>) =>
  Layer.mergeAll(
    platformApiLayer.pipe(Layer.provide(credentialsLayer)),
    projectLinkStateLayer,
    FetchHttpClient.layer,
    commandRuntimeLayer(commandPath),
  );

const description =
  "Build and deploy a worker into the linked Supabase project. Reads its runtime, size and source directory from supabase/config.toml.";

const examples = [
  {
    command: "supabase workers push api",
    description: "Deploy supabase/workers/api to the linked project",
  },
  {
    command: "supabase workers push",
    description: "Deploy the worker whose directory you are inside",
  },
  {
    command: "supabase workers push api --instances 3",
    description: "Deploy with three instances",
  },
] as const;

export const workersPushCommand = Command.make("push", config).pipe(
  Command.withAlias("deploy"),
  Command.withDescription(description),
  Command.withShortDescription("Build and deploy a worker"),
  Command.withExamples([...examples]),
  Command.withHandler((flags) =>
    workersPush(flags).pipe(withCommandInstrumentation(), withJsonErrorHandling),
  ),
  Command.provide(workersPushRuntimeLayer(["workers", "push"])),
  Command.provide(BunServices.layer),
);
