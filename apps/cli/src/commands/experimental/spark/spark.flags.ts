import { Layer } from "effect";
import { Flag } from "effect/cli";

import { debugLoggerLayer } from "../../../command-internal/debug-logger.layer.ts";
import { identityStitchLayer } from "../../../command-internal/identity-stitch.ts";
import { linkedDbResolverRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { parseSchemaFlags } from "../../../command-internal/schema-flags.ts";
import { stackApiLayer } from "../../../command-internal/stack-api.ts";
import { sparkShadowLayer } from "./spark-shadow.ts";

/** `link`'s ref; the other commands select a linked project with the target flags. */
export const projectRef = Flag.String("project-ref").pipe(
  Flag.withDescription("Project ref of the Spark project; defaults to the linked project."),
  Flag.optional,
);

export const schema = Flag.String("schema").pipe(
  Flag.withAlias("s"),
  Flag.withDescription("Comma separated list of schema to include."),
  Flag.atLeast(0),
  Flag.mapTryCatch(
    (rawValues) => parseSchemaFlags(rawValues),
    (err) => (err instanceof Error ? err.message : String(err)),
  ),
);

/**
 * The runtime of a command that takes the target flags: the stack for the local target, and a
 * Management API client whose access token resolves only when a linked target needs it.
 */
export const sparkRuntimeLayer = (subcommand: ReadonlyArray<string>) =>
  Layer.mergeAll(
    linkedDbResolverRuntimeLayer(subcommand).pipe(
      Layer.provide(identityStitchLayer),
      Layer.provide(debugLoggerLayer),
    ),
    identityStitchLayer,
    debugLoggerLayer,
    stackApiLayer,
  );

/** Spark's `db diff` and `db pull` also run a shadow Postgres from the project's config. */
export const shadowRuntimeLayer = (subcommand: ReadonlyArray<string>) =>
  Layer.mergeAll(sparkRuntimeLayer(subcommand), sparkShadowLayer);
