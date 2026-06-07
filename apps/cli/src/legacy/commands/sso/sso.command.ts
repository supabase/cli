import { Command } from "effect/unstable/cli";
import { legacySsoAddCommand } from "./add/add.command.ts";
import { legacySsoInfoCommand } from "./info/info.command.ts";
import { legacySsoListCommand } from "./list/list.command.ts";
import { legacySsoRemoveCommand } from "./remove/remove.command.ts";
import { legacySsoShowCommand } from "./show/show.command.ts";
import { legacySsoUpdateCommand } from "./update/update.command.ts";

export const legacySsoCommand = Command.make("sso").pipe(
  Command.withDescription("Manage Single Sign-On (SSO) authentication for projects."),
  Command.withShortDescription("Manage Single Sign-On (SSO) authentication"),
  Command.withSubcommands([
    legacySsoListCommand,
    legacySsoAddCommand,
    legacySsoRemoveCommand,
    legacySsoUpdateCommand,
    legacySsoShowCommand,
    legacySsoInfoCommand,
  ]),
);
