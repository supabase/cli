import { Context, Option } from "effect";
import { Command } from "effect/cli";

import type { ApiCommandBinding, ApiCommandEntry } from "./api-command.model.ts";

/** What a generated command declares about its API operation; tooling reads it from `Command.annotations`. */
export interface ApiCommandDescriptor {
  readonly operationId: string;
  readonly bindings: readonly ApiCommandBinding[];
  readonly response: ApiCommandEntry["response"];
}

/** Context key under which a generated command's descriptor is stored in `Command.annotations`. */
export class ApiCommandAnnotation extends Context.Service<
  ApiCommandAnnotation,
  ApiCommandDescriptor
>()("supabase/ApiCommandAnnotation") {}

/** Marks a command as generated from the Management API operation `descriptor` names. */
export const withApiCommand =
  (descriptor: ApiCommandDescriptor) =>
  <const Name extends string, Input, ContextInput, E, R>(
    self: Command.Command<Name, Input, ContextInput, E, R>,
  ) =>
    self.pipe(Command.annotate(ApiCommandAnnotation, descriptor));

/** The descriptor of a generated command, or `None` for a hand-written one. */
export const readApiCommand = (command: Command.Command.Any): Option.Option<ApiCommandDescriptor> =>
  Context.getOption(command.annotations, ApiCommandAnnotation);
