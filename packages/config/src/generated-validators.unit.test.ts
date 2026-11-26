import { describe, expect, test } from "vitest";
import { compileCliConfigValidators } from "../scripts/compile-validators.ts";
import { CliConfigSchema } from "./base.ts";
import { schemaIndex } from "./generated/cli-config-validators.js";
import { descendIndex, type SchemaIndexNode } from "./schema-index-core.ts";
import { getDefaultCliConfig } from "./sparse.ts";
import {
  descendAst,
  interpolateEnvReferencesAgainstSchema,
  isDeferredEnvField,
  leafExpectedType,
} from "./lib/env.ts";
import { interpolateCliConfigDocument } from "./plain-config.ts";

describe("the generated config validators", () => {
  test("match what the schema compiles to now (regenerate with `pnpm --filter @supabase/config generate:validators`)", () =>
    expect(
      Bun.file(new URL("./generated/cli-config-validators.js", import.meta.url)).text(),
    ).resolves.toBe(compileCliConfigValidators()));
});

function visit(
  value: unknown,
  ast: Parameters<typeof descendAst>[0] | null,
  index: SchemaIndexNode | null,
  path: ReadonlyArray<string>,
  mismatches: Array<string>,
): void {
  if ((ast === null) !== (index === null)) {
    mismatches.push(`${path.join(".")}: only one navigator descends`);
    return;
  }
  if (ast === null || index === null) {
    return;
  }
  if (leafExpectedType(ast) !== (index.t ?? "unknown")) {
    mismatches.push(`${path.join(".")}: expected type`);
  }
  if (isDeferredEnvField(ast) !== (index.d === true)) {
    mismatches.push(`${path.join(".")}: deferred flag`);
  }
  if (typeof value !== "object" || value === null) {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    visit(child, descendAst(ast, key), descendIndex(index, key), [...path, key], mismatches);
  }
}

describe("the schema index navigator", () => {
  test("agrees with the schema AST on every path of a fully populated config", () => {
    const populated = {
      ...getDefaultCliConfig(),
      functions: { hello: { verify_jwt: false, entrypoint: "x" } },
      storage: { buckets: { avatars: { public: true, allowed_mime_types: ["image/png"] } } },
      auth: {
        ...getDefaultCliConfig().auth,
        external: { github: { enabled: true, client_id: "a", secret: "b" } },
      },
      edge_runtime: { secrets: { FOO: "bar" } },
      local: { services: { auth: { version: "linked", container: { memory: "1GiB", cpus: 1 } } } },
      db: { ...getDefaultCliConfig().db, seed: { enabled: true, sql_paths: ["./a.sql"] } },
    };
    const mismatches: Array<string> = [];

    visit(populated, CliConfigSchema.ast, schemaIndex, [], mismatches);

    expect(mismatches).toEqual([]);
  });

  test("interpolates env references the way the schema-driven walker does", () => {
    const document = {
      project_id: "env(A)",
      api: { port: "env(PORT)", schemas: ["env(S)", "public"] },
      studio: { enabled: "env(FLAG)" },
      db: { seed: { sql_paths: ["env(SQL)"] } },
      auth: {
        external: { github: { enabled: true, client_id: "env(ID)", secret: "env(SECRET)" } },
      },
      edge_runtime: { secrets: { FOO: "env(FOO)" } },
      storage: { buckets: { b: { public: "env(FLAG)", file_size_limit: "env(LIMIT)" } } },
    };
    const env = {
      A: "a",
      PORT: "54321",
      S: "extra",
      FLAG: "false",
      SQL: "./x.sql",
      ID: "id",
      FOO: "foo",
      LIMIT: "5MiB",
    };

    expect(interpolateCliConfigDocument(document, env)).toEqual(
      interpolateEnvReferencesAgainstSchema(document, env, CliConfigSchema),
    );
  });
});
