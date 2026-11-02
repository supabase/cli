import { describe, expect, test } from "vitest";
import { withSchemaMetadata } from "./json-schema-postprocess.ts";

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

  test("caller-supplied metadata wins over a conflicting $id/title/description already on the document", () => {
    const document = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://stale.example.com/old-schema.json",
      title: "Stale title",
      description: "Stale description.",
      type: "object",
    };

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
