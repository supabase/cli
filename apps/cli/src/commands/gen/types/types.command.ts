import { Option } from "effect";
import { Argument, Command, Flag, Param } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";
import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import {
  compose,
  withCondition,
  withContext,
  withDbTarget,
  type EntryCondition,
} from "../../../command-internal/command-permissions/model.ts";
import {
  dbConfigLinked,
  dbConfigPoolerFallbackLinked,
} from "../../../command-internal/db-config.layer.ts";
import { projectRefPicker } from "../../../config/project-ref.layer.ts";
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
import { PROJECT_REF_PATTERN } from "../../../config/project-ref.service.ts";

const config = {
  ...targetFlags({ subject: "database", dbUrl: true }),
  projectId: deprecatedProjectIdFlag,
  lang: Flag.Literals("lang", GEN_TYPES_LANGUAGES).pipe(
    Flag.withDescription("Output language of the generated types. (default typescript)"),
    Flag.withDefault("typescript"),
  ),
  schema: Flag.String("schema").pipe(
    Flag.withAlias("s"),
    Flag.withDescription("Comma separated list of schema to include."),
    Flag.atLeast(0),
    Flag.mapTryCatch(
      (rawValues) => parseSchemaFlags(rawValues),
      (err) => (err instanceof Error ? err.message : String(err)),
    ),
  ),
  // Hidden: Effect V4 has no `Flag.withDeprecated`; the handler prints the deprecation line.
  postgrestV9Compat: Flag.Boolean("postgrest-v9-compat").pipe(
    Flag.withDescription("Generate types compatible with PostgREST v9 and below."),
    Flag.withHidden,
    Flag.withDefault(false),
  ),
  queryTimeout: Flag.String("query-timeout").pipe(
    Flag.withDescription("Maximum timeout allowed for the database query. (default 15s)"),
    Flag.withDefault("15s"),
  ),
} as const;

/** Every flag name `gen types` already answers to: its own, the globals, and Effect's built-ins. */
const GEN_TYPES_RESERVED_FLAG_NAMES: ReadonlyArray<string> = [
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
  language: Argument.String("language").pipe(Argument.optional, Param.withHidden),
} as const;

/** The registry's language flags are only known at runtime; read them through `languageOptionValues`. */
export type GenTypesFlags = CliCommand.Command.Config.Infer<typeof flagsConfig> &
  Readonly<Record<string, unknown>>;

const NON_TYPESCRIPT = GEN_TYPES_LANGUAGES.filter((lang) => lang !== "typescript");
const nonTypescript = { flag: "lang", oneOf: NON_TYPESCRIPT } as const;
const notBranch = "the ref names a project, not a preview branch";
// Without a linked target the run uses a local or `--db-url` database, or fails before calling the API.
const remoteTarget: ReadonlyArray<EntryCondition> = [
  { dbTarget: ["linked"] },
  { flag: "postgrest-v9-compat", is: false },
];

export const genTypesCommand = Command.make("types", commandConfig).pipe(
  Command.withDescription("Generate types from Postgres schema."),
  Command.withShortDescription("Generate types from Postgres schema"),
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
    withDbTarget(
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
                context: `${notBranch}, the direct database host is unreachable (IPv4-only network) and there is no usable saved supabase/.temp/pooler-url (--project-ref and --project-id ignore the saved file)`,
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
          withCondition(projectRefPicker, { flag: "project-id", present: false }),
          linkedProjectCache,
        ),
      ),
      { default: "local" },
    ),
  ),
  Command.withHandler((flags) =>
    genTypes(flags).pipe(
      withCommandTelemetry({
        flags,
        safeFlags: [
          "project-id",
          ...(Option.isSome(flags.projectRef) && PROJECT_REF_PATTERN.test(flags.projectRef.value)
            ? ["project-ref"]
            : []),
        ],
        config: flagsConfig,
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(genTypesRuntimeLayer),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(commandConfig),
  withTargetPolicy({ group: "selectable", consent: "none", consentExemptReason: "read-only" }),
);
