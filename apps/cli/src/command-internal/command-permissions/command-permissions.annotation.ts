import { Context, Option } from "effect";
import { Command } from "effect/cli";

import { commandInternals, userGlobalFlagParams } from "../../docs/docs-introspection.ts";
import { mapped } from "./model.ts";
import type { CommandPermissions, PermissionFragment } from "./model.ts";
import { CommandFlagsAnnotation, permissionFlagsOf } from "./permission-flags.ts";

/** Context key under which a command's declared permissions are stored in `Command.annotations`. */
export class CommandPermissionsAnnotation extends Context.Service<
  CommandPermissionsAnnotation,
  CommandPermissions
>()("supabase/CommandPermissions") {}

/**
 * Declares the Management API operations a command may call. Takes a full `CommandPermissions`,
 * or a fragment (e.g. the result of `compose`) that is declared as mapped. Also records the
 * command's own flags, so help can tell a flag the command lacks from one it hides; apply it after
 * the command's flags are defined.
 */
export const withPermissions =
  (permissions: CommandPermissions | PermissionFragment) =>
  <Name extends string, Input, ContextInput, E, R>(
    self: Command.Command<Name, Input, ContextInput, E, R>,
  ): Command.Command<Name, Input, ContextInput, E, R> => {
    const internals = commandInternals(self);
    const ownFlags = permissionFlagsOf([
      ...internals.config.flags,
      ...internals.contextConfig.flags,
      ...userGlobalFlagParams(self),
    ]);
    return self.pipe(
      Command.annotate(
        CommandPermissionsAnnotation,
        "status" in permissions ? permissions : mapped(permissions),
      ),
      Command.annotate(CommandFlagsAnnotation, ownFlags),
    );
  };

/** The permissions declared on `command` with {@link withPermissions}, or none if it has no declaration. */
export function readPermissions(command: Command.Command.Any): Option.Option<CommandPermissions> {
  return Context.getOption(command.annotations, CommandPermissionsAnnotation);
}
