import { Argument, Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";
import { withDocs } from "../../../docs/command-docs.ts";
import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import {
  compose,
  withCondition,
  withContext,
  type EntryCondition,
} from "../../../command-internal/command-permissions/model.ts";
import {
  dbConfigLinked,
  dbConfigPoolerFallbackLinked,
} from "../../../command-internal/db-config.layer.ts";
import { projectRefPicker } from "../../../config/project-ref.layer.ts";
import { branchResolution } from "../../../command-internal/target/branch-resolution.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { parseSchemaFlags } from "../../../command-internal/schema-flags.ts";
import { GLOBAL_FLAGS } from "../../../command-internal/global-flags.ts";
import {
  PERSISTENT_VALUE_FLAG_NAMES,
  PERSISTENT_VALUE_FLAG_SHORTHANDS,
} from "../../../shared/cli/flag-groups.ts";
import { genTypes } from "./types.handler.ts";
import {
  GEN_TYPES_LANGUAGES,
  GEN_TYPES_LANGUAGE_FLAG_NAMES,
  genTypesLanguageFlags,
} from "./types.languages.ts";
import { genTypesRuntimeLayer } from "./types.layers.ts";
import { cliConfigValuesLayer } from "../../../config/cli-config-values.layer.ts";
import { withCliConfigFlags } from "../../../config/cli-config-flags.ts";
import {
  deprecatedProjectIdFlag,
  targetFlags,
} from "../../../command-internal/target/target-flags.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { cliArgument, cliFlag, makeCommand, repeated } from "../../../shared/cli/cli-params.ts";

const config = {
  ...targetFlags({ subject: "database", dbUrl: true }),
  projectId: deprecatedProjectIdFlag,
  lang: cliFlag("lang", (name) => Flag.Literals(name, GEN_TYPES_LANGUAGES), {
    description: "Output language of the generated types.",
    default: "typescript",
  }),
  schema: cliFlag("schema", repeated(Flag.String, { min: 0 }), {
    description: "Comma-separated list of schemas to include.",
    alias: "s",
    parse: Flag.mapTryCatch(
      (rawValues) => parseSchemaFlags(rawValues),
      (err) => (err instanceof Error ? err.message : String(err)),
    ),
  }),
  // Hidden: Effect V4 has no `Flag.withDeprecated`; the handler prints the deprecation line.
  postgrestV9Compat: cliFlag("postgrest-v9-compat", Flag.Boolean, {
    description: "Generate types compatible with PostgREST v9 and below.",
    default: false,
    hidden: true,
  }),
  queryTimeout: cliFlag("query-timeout", Flag.String, {
    description: "Maximum time allowed for the database query.",
    default: "15s",
  }),
} as const;

/** Every flag name `gen types` already answers to: its own, the globals, and Effect's built-ins. */
const GEN_TYPES_RESERVED_FLAG_NAMES: ReadonlyArray<string> = [
  "remote",
  "local",
  "linked",
  "db-url",
  "project-ref",
  "project-id",
  "lang",
  "schema",
  "s",
  "postgrest-v9-compat",
  "query-timeout",
  ...GLOBAL_FLAGS.map((flag) => flag.id),
  ...PERSISTENT_VALUE_FLAG_NAMES,
  ...PERSISTENT_VALUE_FLAG_SHORTHANDS.keys(),
  "help",
  "h",
  "version",
  "v",
  "wizard",
  "completions",
  "log-level",
];

const flagsConfig = { ...config, ...genTypesLanguageFlags(GEN_TYPES_RESERVED_FLAG_NAMES) };

const commandConfig = {
  ...flagsConfig,
  language: cliArgument("language", Argument.String, { optional: true, hidden: true }),
} as const;

/** The registry's language flags are only known at runtime; read them through `languageOptionValues`. */
export type GenTypesFlags = CliCommand.Command.Config.Infer<typeof flagsConfig> &
  Readonly<Record<string, unknown>>;

const NON_TYPESCRIPT = GEN_TYPES_LANGUAGES.filter((lang) => lang !== "typescript");
const nonTypescript = { flag: "lang", oneOf: NON_TYPESCRIPT } as const;
const notBranch = "the ref names a project, not a preview branch";
// A run without a linked target uses a local or `--remote=<url>` database, or fails before the API.
const remoteTarget: ReadonlyArray<EntryCondition> = [
  { dbTarget: ["linked"] },
  { flag: "postgrest-v9-compat", is: false },
];

const genTypesHandler = (flags: CliCommand.Command.Config.Infer<typeof commandConfig>) =>
  genTypes(flags).pipe(
    withCommandTelemetry({
      flags,
      config: flagsConfig,
    }),
    withJsonErrorHandling,
  );

export const genTypesCommand = makeCommand("types", commandConfig).pipe(
    Command.withDescription(
    "Generate typed definitions for the tables, views and functions in your Postgres schema, so your code gets type safety and autocompletion.",
  ),
  Command.withShortDescription("Generate types from Postgres schema"),
  withDocs({ category: "generate-types" }),
  Command.withExamples([
    {
      command: "supabase gen types",
      description: "Generate types from the local dev database",
    },
    {
      command: "supabase gen types --lang=go --remote",
      description: "Generate Go types from the linked project",
    },
    {
      command: "supabase gen types --schema public --schema private --remote=abcdefghijklmnopqrst",
      description: "Generate types from a project ref with specific schemas",
    },
    {
      command: "supabase gen types --schema public --schema auth --remote='postgresql://...'",
      description: "Generate types from a database URL",
    },
  ]),
  withPermissions(
    remoteTarget.reduce(
      (fragment, condition) => withCondition(fragment, condition),
      compose(
        {
          operations: [
            {
              operationId: "v1-generate-typescript-types",
              kind: "required",
              when: [{ flag: "lang", oneOf: ["typescript"] }],
            },
            { operationId: "v1-get-project", kind: "required", when: [nonTypescript] },
            {
              operationId: "v1-get-a-branch-config",
              kind: "required",
              when: [nonTypescript],
              context: "the project lookup returns 404, so the ref names a preview branch",
            },
            {
              operationId: "v1-get-pooler-config",
              kind: "required",
              when: [nonTypescript],
              context: `${notBranch}, the direct database host is unreachable (IPv4-only network) and there is no usable saved supabase/.temp/pooler-url (--remote=<ref>, --project-ref and --project-id ignore the saved file)`,
            },
            {
              operationId: "v1-get-pooler-config",
              kind: "required",
              when: [nonTypescript],
              context:
                "the ref names a preview branch and generating against its direct host fails with an IPv6 connectivity error",
            },
          ],
          noApiEffectFlags: ["schema", "query-timeout", ...GEN_TYPES_LANGUAGE_FLAG_NAMES],
        },
        withCondition(withContext(dbConfigLinked, notBranch), nonTypescript),
        withCondition(withContext(dbConfigPoolerFallbackLinked, notBranch), nonTypescript),
        projectRefPicker,
        linkedProjectCache,
        branchResolution,
      ),
    ),
  ),
  Command.withHandler(genTypesHandler),
  Command.provide(genTypesRuntimeLayer),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(commandConfig),
  withTargetPolicy({ group: "selectable", consent: "none", consentExemptReason: "read-only" }),
);
