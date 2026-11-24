import { Layer } from "effect";
import { Command, Flag } from "effect/cli";

import { debugLoggerLayer } from "../../../command-internal/debug-logger.layer.ts";
import { identityStitchLayer } from "../../../command-internal/identity-stitch.ts";
import { linkedDbResolverRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { parseSchemaFlags } from "../../../command-internal/schema-flags.ts";
import {
  type TargetFlagValues,
  targetFlags,
} from "../../../command-internal/target/target-flags.ts";
import { TargetHelpAnnotation } from "../../../shared/output/target-help.ts";
import { sparkShadowLayer } from "./spark-shadow.ts";

/**
 * `--remote` and its hidden `--linked` and `--project-ref` aliases select the linked project; with
 * none of them a command targets the dev instance.
 */
export const sparkTargetFlags = () => {
  const { remote, linked, projectRef } = targetFlags({ subject: "database", dbUrl: false });
  return { remote, linked, projectRef };
};

/** The decoded {@link sparkTargetFlags}. */
export type SparkTargetFlagValues = Omit<TargetFlagValues, "local">;

/**
 * The TARGET help and `--remote` description of a Spark command whose default target is the dev
 * instance: one that takes {@link sparkTargetFlags}, or a mainline hosted command mounted with
 * the dev instance as its default project.
 */
export const withSparkTargetHelp = Command.annotate(TargetHelpAnnotation, {
  scope: "dev instance or remote",
  summary: (hint) =>
    `The dev instance by default. Pass --remote for the linked project, or --remote=${hint}.`,
  remoteDescription: (hint) =>
    `Target the linked project, or --remote=${hint}, instead of the dev instance.`,
});

export const schema = Flag.String("schema").pipe(
  Flag.withAlias("s"),
  Flag.withDescription("Comma separated list of schema to include."),
  Flag.atLeast(0),
  Flag.mapTryCatch(
    (rawValues) => parseSchemaFlags(rawValues),
    (err) => (err instanceof Error ? err.message : String(err)),
  ),
);

/** The runtime of a Spark command: a Management API client whose access token resolves on first use. */
export const sparkRuntimeLayer = (subcommand: ReadonlyArray<string>) =>
  Layer.mergeAll(
    linkedDbResolverRuntimeLayer(subcommand).pipe(
      Layer.provide(identityStitchLayer),
      Layer.provide(debugLoggerLayer),
    ),
    identityStitchLayer,
    debugLoggerLayer,
  );

/** Spark's `db diff` and `db pull` also run a shadow Postgres from the project's config. */
export const shadowRuntimeLayer = (subcommand: ReadonlyArray<string>) =>
  Layer.mergeAll(sparkRuntimeLayer(subcommand), sparkShadowLayer);
