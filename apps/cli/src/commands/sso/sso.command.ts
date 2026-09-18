import { Command } from "effect/unstable/cli";
import { ssoAddCommand } from "./add/add.command.ts";
import { ssoInfoCommand } from "./info/info.command.ts";
import { ssoListCommand } from "./list/list.command.ts";
import { ssoRemoveCommand } from "./remove/remove.command.ts";
import { ssoShowCommand } from "./show/show.command.ts";
import { ssoUpdateCommand } from "./update/update.command.ts";

export const ssoCommand = Command.make("sso").pipe(
  Command.withDescription("Manage Single Sign-On (SSO) authentication for projects."),
  Command.withShortDescription("Manage Single Sign-On (SSO) authentication"),
  Command.withSubcommands([
    ssoListCommand,
    ssoAddCommand,
    ssoRemoveCommand,
    ssoUpdateCommand,
    ssoShowCommand,
    ssoInfoCommand,
  ]),
);
