import { Schema } from "effect";

import { CliConfigFlagBindings } from "../../config/cli-config-flags.ts";
import { OptionalSubcommand } from "../../shared/output/optional-subcommand-usage.ts";
import { CommandPermissionsAnnotation } from "../command-permissions/command-permissions.annotation.ts";
import type * as Permissions from "../command-permissions/model.ts";
import { CommandFlagsAnnotation } from "../command-permissions/permission-flags.ts";
import { TargetPolicyAnnotation } from "../target/target-policy.ts";
import type { TargetPolicyShape } from "../target/target-policy.ts";
import { registerFact } from "./command-fact.ts";

type AllKeys<T> = T extends unknown ? keyof T : never;
type SameKeys<A, B> = [AllKeys<A>] extends [AllKeys<B>]
  ? [AllKeys<B>] extends [AllKeys<A>]
    ? true
    : false
  : false;

/**
 * Ties a fact schema to the model type it serializes: a field added to or removed from `Model`
 * without the matching schema change fails to compile, so the catalog can't drop it unnoticed.
 */
const covering =
  <Model>() =>
  <S extends Schema.Top>(
    schema: S,
    ..._mismatch: SameKeys<Model, S["Type"]> extends true
      ? []
      : ["the schema's keys differ from the model's"]
  ): S =>
    schema;

const EntryCondition = covering<Permissions.EntryCondition>()(
  Schema.Union([
    Schema.Struct({
      flag: Schema.String,
      present: Schema.optional(Schema.Boolean),
      is: Schema.optional(Schema.Boolean),
      oneOf: Schema.optional(Schema.Array(Schema.String)),
      source: Schema.optional(Schema.String),
    }),
    Schema.Struct({
      dbTarget: Schema.Array(Schema.Literals(["local", "db-url", "linked"])),
      source: Schema.optional(Schema.String),
    }),
    Schema.Struct({
      selector: Schema.Array(Schema.Literals(["none", "bare", "ref", "branch", "uuid", "url"])),
      source: Schema.optional(Schema.String),
    }),
  ]),
);

const RequestDetails = covering<Permissions.RequestDetails>()(
  Schema.Struct({
    query: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    body: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  }),
);

const OperationEntry = covering<Permissions.OperationEntry>()(
  Schema.Struct({
    operationId: Schema.String,
    kind: Schema.Literals(["required", "best-effort"]),
    when: Schema.optional(Schema.Array(EntryCondition)),
    context: Schema.optional(Schema.String),
    request: Schema.optional(RequestDetails),
    source: Schema.optional(Schema.String),
  }),
);

const CommandPermissions = covering<Permissions.CommandPermissions>()(
  Schema.Union([
    Schema.Struct({
      status: Schema.Literal("mapped"),
      operations: Schema.Array(OperationEntry),
      noApiEffectFlags: Schema.Array(Schema.String),
    }),
    Schema.Struct({ status: Schema.Literal("unmapped"), reason: Schema.Literal("go-delegated") }),
  ]),
);

const TargetPolicy = covering<TargetPolicyShape>()(
  Schema.Struct({
    group: Schema.Literals(["local-only", "account", "hosted", "selectable", "removed"]),
    consent: Schema.Literals(["none", "no", "yes"]),
    consentExemptReason: Schema.optional(Schema.String),
  }),
);

/** Every fact the catalog reads. */
export const COMMAND_FACTS = [
  registerFact(CommandPermissionsAnnotation, { schema: CommandPermissions, checked: ["none"] }),
  registerFact(TargetPolicyAnnotation, { schema: TargetPolicy, checked: ["runtime", "compiler"] }),
] as const;

/**
 * Annotation keys that carry help-time plumbing rather than command facts, so the registry test
 * doesn't require them to be registered.
 */
export const NON_FACT_ANNOTATIONS: ReadonlySet<string> = new Set([
  CommandFlagsAnnotation.key,
  OptionalSubcommand.key,
  CliConfigFlagBindings.key,
]);
