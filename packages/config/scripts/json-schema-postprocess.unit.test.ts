import { describe, expect, test } from "vitest";
import { Schema } from "effect";
import { collapseNonFiniteNumberUnions, withSchemaMetadata } from "./json-schema-postprocess.ts";

describe("collapseNonFiniteNumberUnions", () => {
  test("collapses a top-level anyOf-with-non-finite-enum node to a plain number", () => {
    const schema = Schema.Struct({ port: Schema.Number });
    const document = {
      properties: {
        port: {
          anyOf: [{ type: "number" }, { type: "string", enum: ["Infinity", "-Infinity", "NaN"] }],
        },
      },
    };

    const result = collapseNonFiniteNumberUnions(document, schema.ast);

    expect(result).toEqual({ properties: { port: { type: "number" } } });
  });

  test("re-attaches description/default from the source AST when missing on the union node", () => {
    const schema = Schema.Struct({
      max_rows: Schema.Number.annotate({ description: "Row limit.", default: 1000 }),
    });
    const document = {
      properties: {
        max_rows: {
          anyOf: [{ type: "number" }, { type: "string", enum: ["Infinity", "-Infinity", "NaN"] }],
        },
      },
    };

    const result = collapseNonFiniteNumberUnions(document, schema.ast) as {
      properties: { max_rows: Record<string, unknown> };
    };

    expect(result.properties.max_rows).toEqual({
      type: "number",
      description: "Row limit.",
      default: 1000,
    });
  });

  test("does not override description/default already present on the union node", () => {
    const schema = Schema.Struct({
      max_rows: Schema.Number.annotate({ description: "Row limit.", default: 1000 }),
    });
    const document = {
      properties: {
        max_rows: {
          anyOf: [{ type: "number" }, { type: "string", enum: ["Infinity", "-Infinity", "NaN"] }],
          description: "Overridden description.",
        },
      },
    };

    const result = collapseNonFiniteNumberUnions(document, schema.ast) as {
      properties: { max_rows: Record<string, unknown> };
    };

    expect(result.properties.max_rows["description"]).toBe("Overridden description.");
    expect(result.properties.max_rows["default"]).toBe(1000);
  });

  test("leaves an unrelated anyOf (e.g. object-or-null) untouched", () => {
    const schema = Schema.Struct({ workers: Schema.Unknown });
    const document = {
      properties: {
        workers: { anyOf: [{ type: "object" }, { type: "null" }] },
      },
    };

    const result = collapseNonFiniteNumberUnions(document, schema.ast);

    expect(result).toEqual(document);
  });

  test("descends through properties, patternProperties, items, and additionalProperties", () => {
    const schema = Schema.Struct({
      list: Schema.Array(Schema.Number),
      table: Schema.Record(Schema.String, Schema.Number),
    });
    const nonFiniteNumberNode = {
      anyOf: [{ type: "number" }, { type: "string", enum: ["Infinity", "-Infinity", "NaN"] }],
    };
    const document = {
      properties: {
        list: { type: "array", items: nonFiniteNumberNode },
        table: { type: "object", patternProperties: { ".*": nonFiniteNumberNode } },
      },
    };

    const result = collapseNonFiniteNumberUnions(document, schema.ast);

    expect(result).toEqual({
      properties: {
        list: { type: "array", items: { type: "number" } },
        table: { type: "object", patternProperties: { ".*": { type: "number" } } },
      },
    });
  });

  test("leaves a plain non-object document untouched", () => {
    expect(collapseNonFiniteNumberUnions("not-a-schema-doc", Schema.String.ast)).toBe(
      "not-a-schema-doc",
    );
  });
});

describe("withSchemaMetadata", () => {
  test("inserts $id/title/description right after $schema, ahead of the rest of the document", () => {
    const document = { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" };

    const result = withSchemaMetadata(document, {
      id: "https://example.com/schema.json",
      title: "Example",
      description: "An example schema.",
    });

    expect(Object.keys(result)).toEqual(["$schema", "$id", "title", "description", "type"]);
    expect(result).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://example.com/schema.json",
      title: "Example",
      description: "An example schema.",
      type: "object",
    });
  });
});
