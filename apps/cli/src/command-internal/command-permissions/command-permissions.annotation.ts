import { Context, Option } from "effect";
import { Command } from "effect/unstable/cli";

import { mapped } from "./model.ts";
import type { CommandPermissions, PermissionFragment } from "./model.ts";

/** Context key under which a command's declared permissions are stored in `Command.annotations`. */
export class CommandPermissionsAnnotation extends Context.Service<
  CommandPermissionsAnnotation,
  CommandPermissions
>()("supabase/CommandPermissions") {}

/**
 * Declares the Management API operations a command may call. Takes a full `CommandPermissions`,
 * or a fragment (e.g. the result of `compose`) that is declared as mapped.
 */
export const withPermissions = (permissions: CommandPermissions | PermissionFragment) =>
  Command.annotate(
    CommandPermissionsAnnotation,
    "status" in permissions ? permissions : mapped(permissions),
  );

/** The permissions declared on `command` with {@link withPermissions}, or none if it has no declaration. */
export function readPermissions(command: Command.Command.Any): Option.Option<CommandPermissions> {
  return Context.getOption(command.annotations, CommandPermissionsAnnotation);
}
