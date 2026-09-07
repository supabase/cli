import { describe, expect, test } from "vitest";
import { CliConfigSchema, toCliConfigJsonSchema } from "../src/base.ts";
import {
  ProjectConfigSchema,
  toProjectConfigJsonSchema,
} from "../src/project-config/project-schema.ts";
import { CLI_CONFIG_SCHEMA_URL, PROJECT_CONFIG_SCHEMA_URL } from "../src/schema-metadata.ts";
import { collapseNonFiniteNumberUnions, withSchemaMetadata } from "./json-schema-postprocess.ts";

// CLI-2234 group 6c: regression coverage for the exact post-processing
// `scripts/build.ts` applies to both `dist/schema.json` and
// `dist/project-schema.json` — generated in-memory here (no real build), via
// the same pure functions the build script itself calls, against the real
// `CliConfigSchema`/`ProjectConfigSchema`.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function findAnyOfWithNonFiniteEnum(node: unknown, into: Array<unknown>): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      findAnyOfWithNonFiniteEnum(item, into);
    }
    return;
  }
  if (!isRecord(node)) {
    return;
  }
  const anyOf = node["anyOf"];
  if (Array.isArray(anyOf) && anyOf.length === 2) {
    const hasNumber = anyOf.some((branch) => isRecord(branch) && branch["type"] === "number");
    const hasNonFiniteEnum = anyOf.some(
      (branch) =>
        isRecord(branch) &&
        branch["type"] === "string" &&
        Array.isArray(branch["enum"]) &&
        branch["enum"].every(
          (value) => typeof value === "string" && ["Infinity", "-Infinity", "NaN"].includes(value),
        ),
    );
    if (hasNumber && hasNonFiniteEnum) {
      into.push(node);
    }
  }
  for (const value of Object.values(node)) {
    findAnyOfWithNonFiniteEnum(value, into);
  }
}

const cliDocument = withSchemaMetadata(
  collapseNonFiniteNumberUnions(toCliConfigJsonSchema(), CliConfigSchema.ast) as Record<
    string,
    unknown
  >,
  {
    id: CLI_CONFIG_SCHEMA_URL,
    title: "Supabase CLI config (CliConfig)",
    description: "test",
  },
);

const projectDocument = withSchemaMetadata(
  collapseNonFiniteNumberUnions(toProjectConfigJsonSchema(), ProjectConfigSchema.ast) as Record<
    string,
    unknown
  >,
  {
    id: PROJECT_CONFIG_SCHEMA_URL,
    title: "Supabase hosted project config (ProjectConfig)",
    description: "test",
  },
);

describe("generated JSON Schema artifacts, post-processed", () => {
  test.each([
    ["schema.json", cliDocument],
    ["project-schema.json", projectDocument],
  ])("%s carries no anyOf-with-non-finite-enum pattern anywhere", (_name, document) => {
    const matches: Array<unknown> = [];
    findAnyOfWithNonFiniteEnum(document, matches);
    expect(matches).toEqual([]);
  });

  test("schema.json's api.max_rows carries both description and default", () => {
    const properties = cliDocument["properties"];
    if (!isRecord(properties) || !isRecord(properties["api"])) {
      throw new Error("expected properties.api to be an object");
    }
    const apiProperties = properties["api"]["properties"];
    if (!isRecord(apiProperties) || !isRecord(apiProperties["max_rows"])) {
      throw new Error("expected properties.api.properties.max_rows to be an object");
    }
    const maxRows = apiProperties["max_rows"];
    expect(maxRows["type"]).toBe("number");
    expect(typeof maxRows["description"]).toBe("string");
    expect(maxRows["default"]).toBe(1000);
  });

  test.each([
    ["schema.json", cliDocument, CLI_CONFIG_SCHEMA_URL, "Supabase CLI config (CliConfig)"],
    [
      "project-schema.json",
      projectDocument,
      PROJECT_CONFIG_SCHEMA_URL,
      "Supabase hosted project config (ProjectConfig)",
    ],
  ])("%s carries $schema, $id, and title", (_name, document, id, title) => {
    expect(document["$schema"]).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(document["$id"]).toBe(id);
    expect(document["title"]).toBe(title);
  });
});
