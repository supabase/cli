import { Effect, Option } from "effect";
import { findStack, inspectStack, openStack } from "@supabase/stack/effect";
import { CliProjectHome } from "../../config/cli-project-home.service.ts";
import { Output } from "../../../shared/output/output.service.ts";
import type { StatusFlags } from "./status.command.ts";

export const status = Effect.fnUntraced(function* (flags: StatusFlags) {
  const output = yield* Output;
  const project = yield* CliProjectHome;
  yield* output.intro("Show local Supabase stack status");
  const descriptorOption = yield* findStack({
    projectRoot: project.projectRoot,
    name: flags.stack,
  });
  if (Option.isNone(descriptorOption)) {
    const message = "No local Supabase stack is known for this project.";
    if (output.format === "text") return yield* output.outro(message);
    return yield* output.success(message, { running: false, stack: flags.stack });
  }
  const descriptor = descriptorOption.value;
  const inspection = yield* inspectStack(descriptor.id);
  let observed = inspection.status;
  if (inspection.owner === "running") {
    observed = yield* Effect.scoped(
      Effect.gen(function* () {
        const stack = yield* openStack(descriptor.id);
        return yield* stack.status();
      }),
    );
  }
  const running = observed?.lifecycle === "running";
  const message = running ? "Local Supabase stack is running." : "Local Supabase stack is stopped.";
  const data = {
    stack: descriptor.name,
    running,
    lifecycle: observed?.lifecycle ?? descriptor.desiredLifecycle,
    desired_lifecycle: descriptor.desiredLifecycle,
    runtime: descriptor.runtime,
    endpoints: observed?.endpoints ?? {},
    versions: observed?.versions ?? {},
    capabilities: observed?.capabilities ?? [],
  };
  if (output.format !== "text") return yield* output.success(message, data);
  yield* running ? output.success(message) : output.info(message);
  yield* output.info(`Stack: ${descriptor.name}`);
  yield* output.info(`Lifecycle: ${data.lifecycle}`);
  yield* output.info(`Runtime: ${descriptor.runtime.kind}`);
  for (const [name, endpoint] of Object.entries(data.endpoints)) {
    if (endpoint !== undefined) yield* output.info(`${name}: ${endpoint.url}`);
  }
  for (const capability of data.capabilities) {
    yield* output.info(`${capability.name}: ${capability.state}`);
  }
  yield* output.outro(
    `Local Supabase stack ${descriptor.name} is ${running ? "running" : "stopped"}.`,
  );
});
