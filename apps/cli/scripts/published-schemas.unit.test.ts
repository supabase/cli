import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import {
  CLI_CONFIG_SCHEMA_URL,
  PROJECT_CONFIG_SCHEMA_URL,
  toCliConfigJsonSchema,
  toProjectConfigJsonSchema,
} from "@supabase/config";
import { HOSTED_LOCK_SCHEMA_URL, LOCK_SCHEMA_URL } from "@supabase/stack/effect";
import { Effect, FileSystem, JsonSchema, Path, Schema } from "effect";
import { lockSchemaDocument, publishedSchemaPath } from "./published-schemas.ts";

type Document = Readonly<Record<string, unknown>>;

const REGENERATE =
  "run `pnpm --filter @supabase/config build && bun apps/cli/scripts/generate-docs.ts`";

const POST_DRAFT_07_KEYWORDS = new Set([
  "$defs",
  "prefixItems",
  "unevaluatedProperties",
  "unevaluatedItems",
  "dependentRequired",
  "dependentSchemas",
  "$dynamicRef",
  "$dynamicAnchor",
  "$recursiveRef",
  "$recursiveAnchor",
  "$anchor",
  "$vocabulary",
  "minContains",
  "maxContains",
]);
const DATA_KEYWORDS = new Set(["default", "examples", "enum", "const"]);
const SCHEMA_MAP_KEYWORDS = new Set(["properties", "patternProperties", "definitions"]);

const isNode = (value: unknown): value is Document =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const findPostDraft07Usage = (node: unknown, path: ReadonlyArray<string> = []): Array<string> => {
  if (Array.isArray(node)) {
    return node.flatMap((child, index) => findPostDraft07Usage(child, [...path, String(index)]));
  }
  if (!isNode(node)) return [];
  return Object.entries(node).flatMap(([keyword, value]) => {
    const here = [...path, keyword];
    if (POST_DRAFT_07_KEYWORDS.has(keyword)) return [here.join("/")];
    if (keyword === "$ref" && typeof value === "string" && value.startsWith("#/$defs/")) {
      return [here.join("/")];
    }
    if (DATA_KEYWORDS.has(keyword)) return [];
    if (SCHEMA_MAP_KEYWORDS.has(keyword) && isNode(value)) {
      return Object.entries(value).flatMap(([name, child]) =>
        findPostDraft07Usage(child, [...here, name]),
      );
    }
    return findPostDraft07Usage(value, here);
  });
};

const collectRefs = (node: unknown): Array<string> => {
  if (Array.isArray(node)) return node.flatMap(collectRefs);
  if (!isNode(node)) return [];
  return Object.entries(node).flatMap(([keyword, value]) =>
    keyword === "$ref" && typeof value === "string" ? [value] : collectRefs(value),
  );
};

const withoutMetadata = ({
  $id: _id,
  title: _title,
  description: _description,
  ...rest
}: Document): Document => rest;

const published = [
  {
    name: "config",
    file: "schemas/config/v1.json",
    url: CLI_CONFIG_SCHEMA_URL,
    build: (): Document => toCliConfigJsonSchema(),
    comparable: withoutMetadata,
  },
  {
    name: "project-config",
    file: "schemas/project-config/v1.json",
    url: PROJECT_CONFIG_SCHEMA_URL,
    build: (): Document => toProjectConfigJsonSchema(),
    comparable: withoutMetadata,
  },
  {
    name: "supabase-lock",
    file: "schemas/supabase-lock/v1.json",
    url: HOSTED_LOCK_SCHEMA_URL,
    build: (): Document => lockSchemaDocument(),
    comparable: (document: Document): Document => document,
  },
] as const;

const decodeDocument = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

const readCommitted = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const publicDir = path.resolve(import.meta.dirname, "../../docs/public");
    return yield* decodeDocument(yield* fs.readFileString(path.join(publicDir, file)));
  }).pipe(Effect.provide(BunServices.layer));

describe("findPostDraft07Usage", () => {
  it("flags post-draft-07 keywords and $defs refs in schema positions", () => {
    const document = {
      type: "object",
      $defs: { Name: { type: "string" } },
      properties: {
        tuple: { type: "array", prefixItems: [{ type: "string" }] },
        name: { $ref: "#/$defs/Name" },
      },
    };

    expect(findPostDraft07Usage(document)).toEqual([
      "$defs",
      "properties/tuple/prefixItems",
      "properties/name/$ref",
    ]);
  });

  it("treats property names and data keywords as data", () => {
    const document = {
      type: "object",
      properties: {
        prefixItems: { type: "string", default: "x" },
        $defs: { type: "object", default: { $defs: {} }, examples: [{ prefixItems: [] }] },
        mode: { enum: ["$defs", "prefixItems"], const: "$defs" },
      },
      definitions: { unevaluatedProperties: { type: "string" } },
    };

    expect(findPostDraft07Usage(document)).toEqual([]);
  });
});

describe.each(published)("published $name schema", (entry) => {
  it.effect("declares draft-07 and an $id that serves from its own path", () =>
    Effect.gen(function* () {
      const document = yield* readCommitted(entry.file);

      expect(document["$schema"]).toBe(JsonSchema.META_SCHEMA_URI_DRAFT_07);
      expect(document["$id"]).toBe(entry.url);
      expect(publishedSchemaPath(entry.url)).toBe(`/${entry.file}`);
    }),
  );

  it.effect("uses no keyword newer than draft-07", () =>
    Effect.gen(function* () {
      expect(findPostDraft07Usage(yield* readCommitted(entry.file))).toEqual([]);
    }),
  );

  it.effect("matches what the build renders", () =>
    Effect.gen(function* () {
      const document = yield* readCommitted(entry.file);

      expect(
        entry.comparable(document),
        `apps/docs/public/${entry.file} is stale: ${REGENERATE}`,
      ).toEqual(entry.comparable(entry.build()));
    }),
  );
});

describe("published supabase-lock schema definitions", () => {
  const readLockDefinitions = Effect.gen(function* () {
    const document = yield* readCommitted("schemas/supabase-lock/v1.json");
    const definitions = document["definitions"];
    return { document, definitions: isNode(definitions) ? definitions : {} };
  });

  it.effect("are pairwise distinct", () =>
    Effect.gen(function* () {
      const { definitions } = yield* readLockDefinitions;
      const bodies = Object.values(definitions).map((definition) => JSON.stringify(definition));

      expect(bodies.length).toBeGreaterThan(1);
      expect(new Set(bodies).size).toBe(bodies.length);
    }),
  );

  it.effect("cover every $ref in the document", () =>
    Effect.gen(function* () {
      const { document, definitions } = yield* readLockDefinitions;
      const refs = collectRefs(document);

      expect(refs).not.toEqual([]);
      expect(
        refs.filter((ref) => !Object.keys(definitions).includes(ref.replace("#/definitions/", ""))),
      ).toEqual([]);
    }),
  );

  it.effect("accept every $schema value readLock accepts", () =>
    Effect.gen(function* () {
      const document = yield* readCommitted("schemas/supabase-lock/v1.json");
      const properties = document["properties"];
      const schemaProperty = isNode(properties) ? properties["$schema"] : undefined;

      expect(isNode(schemaProperty) ? schemaProperty["enum"] : undefined).toEqual(
        expect.arrayContaining([LOCK_SCHEMA_URL, HOSTED_LOCK_SCHEMA_URL]),
      );
    }),
  );
});
