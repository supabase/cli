import { Layer } from "effect";
import { Flag } from "effect/cli";

import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { parseSchemaFlags } from "../../../command-internal/schema-flags.ts";
import { sparkShadowLayer } from "./spark-shadow.ts";

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

/** Spark's `db diff` and `db pull` also run a shadow Postgres from the project's config. */
export const shadowRuntimeLayer = (subcommand: ReadonlyArray<string>) =>
  Layer.mergeAll(managementApiRuntimeLayer(subcommand), sparkShadowLayer);
