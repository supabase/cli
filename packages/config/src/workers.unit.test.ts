import { Schema } from "effect";
import { describe, expect, test } from "vitest";
import { workers } from "./workers.ts";

const decode = Schema.decodeUnknownSync(workers);

const workerNamePattern = "^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$";

describe("workers schema", () => {
  test("decodes a worker table with every dial set", () => {
    expect(
      decode({ api: { runtime: "node", size: "4gb", instances: 3, source: "packages/api" } }),
    ).toEqual({ api: { runtime: "node", size: "4gb", instances: 3, source: "packages/api" } });
  });

  test("defaults to an empty section when the key is absent", () => {
    expect(Schema.decodeUnknownSync(Schema.Struct({ workers }))({})).toEqual({ workers: {} });
  });

  // Keys outside the DNS-label pattern fall outside the record's index
  // signature and are dropped, the same way `[functions.<slug>]` treats a slug
  // its own pattern does not match. `supabase experimental workers new` validates the name
  // up front so the CLI never writes one that would vanish here.
  test("drops worker names that are not DNS labels", () => {
    expect(decode({ Not_A_Label: {}, api: { runtime: "node" } })).toEqual({
      api: { runtime: "node" },
    });
  });

  // Every dial is optional: a worker scaffolded by `supabase experimental workers new` records
  // only what it prompted for, and `push` resolves the rest from its own defaults.
  test("decodes a worker table with no dials set", () => {
    expect(decode({ api: {} })).toEqual({ api: {} });
  });

  test("rejects a non-numeric instance count", () => {
    expect(() => decode({ api: { instances: "three" } })).toThrow();
  });

  // `spec.instances` is an integer in the Management API's input schema, and a
  // value that slips through here is dropped downstream and silently rescales
  // the worker to 1 rather than failing. Named at load time instead.
  test.each([
    ["a fraction", 1.5],
    ["a negative count", -1],
  ])("rejects %s as an instance count", (_label, instances) => {
    expect(() => decode({ api: { instances } })).toThrow();
  });

  test("accepts zero instances", () => {
    expect(decode({ api: { instances: 0 } })).toEqual({ api: { instances: 0 } });
  });

  test("rejects a bare value where a worker table belongs", () => {
    expect(() => decode({ api: "node" })).toThrow();
  });

  // The published asset at `PROJECT_CONFIG_SCHEMA_URL` is what editors read, so
  // the worker dials have to stay described and completable — and a worker value
  // has to be a plain table, or an editor would accept a bare scalar the CLI
  // refuses to load.
  test("includes worker properties in the generated JSON schema", () => {
    const json = JSON.parse(JSON.stringify(Schema.toJsonSchemaDocument(workers).schema));
    const objectSchema = json.anyOf?.find((entry: { type?: string }) => entry?.type === "object");
    const workerSchema = objectSchema?.patternProperties?.[workerNamePattern];

    expect(workerSchema?.properties?.runtime).toBeDefined();
    expect(workerSchema?.properties?.size).toBeDefined();
    expect(workerSchema?.properties?.instances).toBeDefined();
    expect(workerSchema?.properties?.source).toBeDefined();
  });

  // An integer bound the published schema carries, so an editor flags `1.5`
  // before the CLI ever reads it.
  test("bounds instances as a non-negative integer in the generated JSON schema", () => {
    const json = JSON.parse(JSON.stringify(Schema.toJsonSchemaDocument(workers).schema));
    const objectSchema = json.anyOf?.find((entry: { type?: string }) => entry?.type === "object");
    const workerSchema = objectSchema?.patternProperties?.[workerNamePattern];

    expect(workerSchema?.properties?.instances?.type).toBe("integer");
    expect(JSON.stringify(workerSchema?.properties?.instances)).toContain('"minimum":0');
  });
});
