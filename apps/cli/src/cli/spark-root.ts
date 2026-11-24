import { Command } from "effect/cli";
import {
  sparkCommands,
  withSparkDevInstanceDefault,
  withSparkDevInstanceProject,
} from "../commands/experimental/spark/spark.command.ts";
import { functionsDeleteCommand } from "../commands/functions/delete/delete.command.ts";
import { functionsDeployCommand } from "../commands/functions/deploy/deploy.command.ts";
import { functionsListCommand } from "../commands/functions/list/list.command.ts";
import { functionsNewCommand } from "../commands/functions/new/new.command.ts";
import { initCommand } from "../commands/init/init.command.ts";
import { linkCommand } from "../commands/link/link.command.ts";
import { loginCommand } from "../commands/login/login.command.ts";
import { logoutCommand } from "../commands/logout/logout.command.ts";
import { orgsListCommand } from "../commands/orgs/list/list.command.ts";
import { projectsApiKeysCommand } from "../commands/projects/api-keys/api-keys.command.ts";
import { projectsCreateCommand } from "../commands/projects/create/create.command.ts";
import { projectsDeleteCommand } from "../commands/projects/delete/delete.command.ts";
import { projectsListCommand } from "../commands/projects/list/list.command.ts";
import { secretsListCommand } from "../commands/secrets/list/list.command.ts";
import { secretsSetCommand } from "../commands/secrets/set/set.command.ts";
import { secretsUnsetCommand } from "../commands/secrets/unset/unset.command.ts";

/** `orgs` in the Spark tree, which only reads the organizations `start` picks from. */
const sparkOrgsCommand = Command.make("orgs").pipe(
  Command.withDescription("Manage Supabase organizations"),
  Command.withShortDescription("Manage Supabase organizations"),
  Command.withSubcommands([orgsListCommand]),
);

/** `functions` in the Spark tree: no `serve` or `download`, and the dev instance by default. */
const sparkFunctionsCommand = Command.make("functions").pipe(
  Command.withDescription("Manage Supabase Edge functions."),
  Command.withShortDescription("Manage Supabase Edge functions"),
  Command.withSubcommands([
    withSparkDevInstanceProject(functionsListCommand, {
      description:
        "List all Functions in the dev instance. Pass --project-ref to list another project's.",
      examples: [
        {
          command: "supabase functions list",
          description: "List all deployed functions in the dev instance",
        },
        {
          command: "supabase functions list --project-ref abcdefghijklmnopqrst",
          description: "List all deployed functions in a specific project",
        },
      ],
    }),
    withSparkDevInstanceProject(functionsDeleteCommand, {
      description:
        "Delete a Function from the dev instance. Pass --project-ref to delete from another project. This does NOT remove the Function locally.",
      examples: [
        {
          command: "supabase functions delete hello-world",
          description: "Delete a deployed function from the dev instance",
        },
        {
          command: "supabase functions delete hello-world --project-ref abcdefghijklmnopqrst",
          description: "Delete a deployed function from a specific project",
        },
      ],
    }),
    withSparkDevInstanceProject(functionsDeployCommand, {
      description:
        "Deploy a Function to the dev instance. Pass --project-ref to deploy to another project.",
      examples: [
        {
          command: "supabase functions deploy hello-world",
          description: "Deploy a single function to the dev instance",
        },
        {
          command: "supabase functions deploy --project-ref abcdefghijklmnopqrst",
          description: "Deploy all local functions to a specific project",
        },
      ],
    }),
    functionsNewCommand,
  ]),
);

/** `secrets` in the Spark tree, on the dev instance by default. */
const sparkSecretsCommand = Command.make("secrets").pipe(
  Command.withDescription("Manage Supabase secrets."),
  Command.withShortDescription("Manage Supabase secrets"),
  Command.withSubcommands([
    withSparkDevInstanceProject(secretsListCommand, {
      description:
        "List all secrets in the dev instance. Pass --project-ref to list another project's.",
      examples: [
        {
          command: "supabase secrets list",
          description: "List all secrets for the dev instance",
        },
        {
          command: "supabase secrets list --project-ref abcdefghijklmnopqrst",
          description: "List secrets for a specific project",
        },
      ],
    }),
    withSparkDevInstanceProject(secretsSetCommand, {
      description:
        "Set a secret(s) on the dev instance. Pass --project-ref to set them on another project.",
    }),
    withSparkDevInstanceProject(secretsUnsetCommand, {
      description:
        "Unset a secret(s) from the dev instance. Pass --project-ref to unset them from another project.",
    }),
  ]),
);

/** `projects` in the Spark tree: `list` marks the dev instance and `api-keys` defaults to it. */
const sparkProjectsCommand = Command.make("projects").pipe(
  Command.withDescription("Manage Supabase projects."),
  Command.withShortDescription("Manage projects"),
  Command.withSubcommands([
    withSparkDevInstanceDefault(projectsListCommand),
    projectsCreateCommand,
    withSparkDevInstanceProject(projectsApiKeysCommand, {
      description:
        "List all API keys for the dev instance. Pass --project-ref to list another project's.",
      examples: [
        {
          command: "supabase projects api-keys",
          description: "List all API keys for the dev instance",
        },
        {
          command: "supabase projects api-keys --reveal --output json",
          description: "List the dev instance's API keys with the secret keys revealed in full",
        },
      ],
    }),
    projectsDeleteCommand,
  ]),
);

/** The mainline commands the Spark tree mounts beside its own. */
const sparkAccountCommands = [
  loginCommand,
  logoutCommand,
  linkCommand,
  sparkOrgsCommand,
  sparkProjectsCommand,
  sparkFunctionsCommand,
  sparkSecretsCommand,
] as const;

/** A Spark project's command tree, which replaces the mainline one. */
const sparkRootSubcommands = [initCommand, ...sparkAccountCommands, ...sparkCommands] as const;

/** The root's subcommands: `mainline`, or the Spark tree when the project opted into Spark. */
export const withRootSubcommands = <
  const Mainline extends ReadonlyArray<Command.Command.SubcommandEntry>,
>(
  features: { readonly sparkEnabled?: boolean },
  mainline: Mainline,
) => Command.withSubcommands(features.sparkEnabled === true ? sparkRootSubcommands : mainline);
