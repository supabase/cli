import { Schema } from "effect";

import { CliConfigFlagBindings } from "../../config/cli-config-flags.ts";
import { OptionalSubcommand } from "../../shared/output/optional-subcommand-usage.ts";
import { CommandPermissionsAnnotation } from "../command-permissions/command-permissions.annotation.ts";
import { CommandFlagsAnnotation } from "../command-permissions/permission-flags.ts";
import { TargetPolicyAnnotation } from "../target/target-policy.ts";
import { registerDerivedFact, registerFact } from "./command-fact.ts";
import { OutputSchemaAnnotation } from "./command-output.ts";
import { GlobalFlagsReadAnnotation } from "./with-global-flags-read.ts";
import { CommandStageAnnotation } from "./with-stage.ts";

const OperationEntry = Schema.Struct({
  operationId: Schema.String,
  kind: Schema.Literals(["required", "best-effort"]),
  when: Schema.optional(Schema.Array(Schema.Unknown)),
  context: Schema.optional(Schema.String),
  source: Schema.optional(Schema.String),
});

const CommandPermissions = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("mapped"),
    operations: Schema.Array(OperationEntry),
    noApiEffectFlags: Schema.Array(Schema.String),
  }),
  Schema.Struct({ status: Schema.Literal("unmapped"), reason: Schema.Literal("go-delegated") }),
]);

const TargetPolicy = Schema.Struct({
  group: Schema.Literals(["local-only", "account", "hosted", "selectable", "removed"]),
  consent: Schema.Literals(["none", "no", "yes"]),
  consentExemptReason: Schema.optional(Schema.String),
});

/** Every fact the catalog reads, keyed by annotation id. */
export const COMMAND_FACTS = [
  registerFact(CommandPermissionsAnnotation, { schema: CommandPermissions, checked: ["none"] }),
  registerFact(TargetPolicyAnnotation, { schema: TargetPolicy, checked: ["runtime", "compiler"] }),
  registerDerivedFact(OutputSchemaAnnotation, {
    serialize: (schema) => Schema.toJsonSchemaDocument(schema),
    checked: ["compiler", "runtime"],
  }),
  registerFact(GlobalFlagsReadAnnotation, {
    schema: Schema.Array(Schema.String),
    checked: ["compiler"],
  }),
  registerFact(CommandStageAnnotation, {
    schema: Schema.Struct({ stage: Schema.Literal("experimental") }),
    checked: ["runtime"],
  }),
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
