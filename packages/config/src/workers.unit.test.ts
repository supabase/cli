import { Schema } from "effect";
import { describe, expect, test } from "vitest";
import { workers } from "./workers.ts";

const decode = Schema.decodeUnknownSync(workers);

const workerNamePattern = "^(?!root$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$";

describe("workers schema", () => {
  test("decodes the project-wide root alongside per-worker tables", () => {
    expect(
      decode({
        root: "services",
        api: { runtime: "node", size: "4gb", source: "packages/api" },
      }),
    ).toEqual({
      root: "services",
      api: { runtime: "node", size: "4gb", source: "packages/api" },
    });
  });

  test("defaults to an empty section when the key is absent", () => {
    expect(Schema.decodeUnknownSync(Schema.Struct({ workers }))({})).toEqual({ workers: {} });
  });

  // Keys outside the DNS-label pattern fall outside the record's index
  // signature and are dropped, the same way `[functions.<slug>]` treats a slug
  // its own pattern does not match. `supabase workers new` validates the name
  // up front so the CLI never writes one that would vanish here.
  test("drops worker names that are not DNS labels", () => {
    expect(decode({ Not_A_Label: {}, api: { runtime: "node" } })).toEqual({
      api: { runtime: "node" },
    });
  });

  test("includes worker properties in the generated JSON schema", () => {
    const json = JSON.parse(JSON.stringify(Schema.toJsonSchemaDocument(workers).schema));
    const objectSchema = json.anyOf?.find((entry: { type?: string }) => entry?.type === "object");
    const workerSchema = objectSchema?.patternProperties?.[workerNamePattern];

    expect(objectSchema?.properties?.root).toBeDefined();
    expect(workerSchema?.properties?.runtime).toBeDefined();
    expect(workerSchema?.properties?.size).toBeDefined();
    expect(workerSchema?.properties?.source).toBeDefined();
  });
});
