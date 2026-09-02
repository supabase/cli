import { Crypto, Effect, FileSystem, Option, Path } from "effect";
import {
  findStack,
  inspectStack,
  type FindStackOptions,
  type StackDescriptor,
  type StackDiscoveryError,
  type StackId,
  type StackInspection,
  type StackNotFoundError,
} from "@supabase/stack/effect";
import { CliProjectHome } from "../../config/cli-project-home.service.ts";
import { Output } from "../../../shared/output/output.service.ts";
import type { StatusFlags } from "./status.command.ts";

type StatusRuntime = FileSystem.FileSystem | Path.Path | Crypto.Crypto;
export interface StatusOperations {
  readonly findStack: (
    options: FindStackOptions,
  ) => Effect.Effect<Option.Option<StackDescriptor>, StackDiscoveryError, StatusRuntime>;
  readonly inspectStack: (
    id: StackId,
  ) => Effect.Effect<StackInspection, StackNotFoundError | StackDiscoveryError, StatusRuntime>;
}

const defaultOperations: StatusOperations = { findStack, inspectStack };

export const status = Effect.fnUntraced(function* (
  flags: StatusFlags,
  operations: StatusOperations = defaultOperations,
) {
  const output = yield* Output;
  const project = yield* CliProjectHome;
  yield* output.intro("Show local Supabase stack status");
  const descriptorOption = yield* operations.findStack({
    projectRoot: project.projectRoot,
    name: flags.stack,
  });
  if (Option.isNone(descriptorOption)) {
    const message = "No local Supabase stack is known for this project.";
    if (output.format === "text") return yield* output.outro(message);
    return yield* output.success(message, { running: false, stack: flags.stack });
  }
  const descriptor = descriptorOption.value;
  const inspection = yield* operations.inspectStack(descriptor.id);
  const observed = inspection.status;
  const lifecycle = observed?.lifecycle ?? descriptor.desiredLifecycle;
  const running = inspection.owner === "running" && lifecycle === "running";
  const crashed = inspection.owner === "absent" && descriptor.desiredLifecycle === "running";
  const unavailable =
    inspection.owner === "incompatible" || inspection.owner === "unreachable" || crashed;
  let message: string;
  if (inspection.owner === "incompatible")
    message = "Local Supabase stack has an incompatible owner; run supabase restart.";
  else if (inspection.owner === "unreachable")
    message = "Local Supabase stack owner is unreachable; run supabase restart.";
  else if (crashed) message = "Local Supabase stack owner is not running; run supabase start.";
  else message = `Local Supabase stack is ${lifecycle}.`;
  const data = {
    stack: descriptor.name,
    running,
    lifecycle: observed?.lifecycle ?? descriptor.desiredLifecycle,
    desired_lifecycle: descriptor.desiredLifecycle,
    runtime: descriptor.runtime,
    endpoints: observed?.endpoints ?? {},
    versions: observed?.versions ?? {},
    capabilities: observed?.capabilities ?? [],
    owner: inspection.owner,
  };
  if (output.format !== "text") return yield* output.success(message, data);
  if (unavailable) yield* output.warn(message);
  else yield* running ? output.success(message) : output.info(message);
  yield* output.info(`Stack: ${descriptor.name}`);
  yield* output.info(`Lifecycle: ${lifecycle}`);
  yield* output.info(`Runtime: ${descriptor.runtime.kind}`);
  for (const [name, endpoint] of Object.entries(data.endpoints)) {
    if (endpoint !== undefined) yield* output.info(`${name}: ${endpoint.url}`);
  }
  for (const capability of data.capabilities) {
    yield* output.info(`${capability.name}: ${capability.state}`);
  }
  yield* output.outro(
    `Local Supabase stack ${descriptor.name} is ${unavailable ? "unavailable" : lifecycle}.`,
  );
});
