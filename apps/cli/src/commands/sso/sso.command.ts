import { Command } from "effect/cli";
import { ssoAddCommand } from "./add/add.command.ts";
import { ssoInfoCommand } from "./info/info.command.ts";
import { ssoListCommand } from "./list/list.command.ts";
import { ssoRemoveCommand } from "./remove/remove.command.ts";
import { ssoShowCommand } from "./show/show.command.ts";
import { ssoUpdateCommand } from "./update/update.command.ts";

export const ssoCommand = Command.make("sso").pipe(
  Command.withDescription(
    "Let users sign in to your project through your organization's SAML 2.0 identity provider.",
  ),
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
