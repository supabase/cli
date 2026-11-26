import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { toCliConfigJsonSchema } from "./base.ts";
import { CliConfigIoError, makeCliConfigPromiseIo } from "./promise-io.ts";

const io = makeCliConfigPromiseIo({ loadSchema: async () => toCliConfigJsonSchema() });

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "supabase-config-promise-io-"));
  await mkdir(join(root, "supabase"));
});

afterEach(() => rm(root, { recursive: true, force: true }));

const write = (name: string, text: string) => writeFile(join(root, "supabase", name), text);

describe("loadCliConfig", () => {
  test("loads config.toml and reports the format and raw text", async () => {
    await write("config.toml", "[api]\nport = 54321\n");

    const loaded = await io.loadCliConfig(root);

    expect(loaded).toMatchObject({
      format: "toml",
      config: { api: { port: 54321 } },
      rawText: "[api]\nport = 54321\n",
      ignoredPaths: [],
    });
  });

  test("loads config.jsonc with comments and reports the schema reference", async () => {
    await write(
      "config.jsonc",
      '{\n  // the API\n  "$schema": "https://supabase.com/schemas/config/v1.json",\n  "api": { "port": 54321 },\n}\n',
    );

    const loaded = await io.loadCliConfig(root);

    expect(loaded).toMatchObject({
      format: "json",
      schemaRef: "https://supabase.com/schemas/config/v1.json",
      config: { api: { port: 54321 } },
    });
  });

  test("prefers JSON over TOML and lists the shadowed file", async () => {
    await write("config.json", '{ "api": { "port": 1 } }');
    await write("config.toml", "[api]\nport = 2\n");

    const loaded = await io.loadCliConfig(root);

    expect(loaded?.format).toBe("json");
    expect(loaded?.ignoredPaths).toEqual([join(root, "supabase", "config.toml")]);
  });

  test("finds the project from a nested directory and returns null outside a project", async () => {
    await write("config.toml", "");
    const nested = join(root, "a", "b");
    await mkdir(nested, { recursive: true });

    expect(await io.findCliProjectRoot(nested)).toBe(root);
    expect(await io.findCliProjectRoot(nested, { search: false })).toBeNull();
    expect(await io.loadCliConfig(nested, { search: false })).toBeNull();
  });

  test("rejects config.json next to config.jsonc as a conflict", async () => {
    await write("config.json", "{}");
    await write("config.jsonc", "{}");

    await expect(io.loadCliConfig(root)).rejects.toMatchObject({ reason: "file_conflict" });
  });

  test("rejects a document that does not parse without quoting its text", async () => {
    await write("config.toml", "[api\nsecret_value = 1\n");

    const error = await io.loadCliConfig(root).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(CliConfigIoError);
    expect(error).toMatchObject({ reason: "parse_error" });
    expect((error as Error).message).not.toContain("secret_value");
  });

  test("rejects a schema-invalid document with a dotted issue path", async () => {
    await write("config.toml", '[api]\nport = "not-a-port"\n');

    const error = await io.loadCliConfig(root).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(CliConfigIoError);
    expect(error).toMatchObject({ reason: "invalid_config" });
    expect((error as CliConfigIoError).issues.map((issue) => issue.path)).toContain("api.port");
  });

  test("reports an unknown key by its full path", async () => {
    await write("config.toml", "[api]\nnot_a_setting = 1\n");

    const error = await io.loadCliConfig(root).catch((cause: unknown) => cause);

    expect((error as CliConfigIoError).issues).toContainEqual({
      path: "api.not_a_setting",
      message: "is not a known key",
    });
  });
});

describe("validateCliConfig", () => {
  test("returns no issues for a valid document and issues for an invalid one", async () => {
    expect(await io.validateCliConfig({ api: { port: 54321 } })).toEqual([]);
    expect(await io.validateCliConfig({ api: { port: "x" } })).not.toEqual([]);
  });

  test("retries loading the schema after a failed load", async () => {
    let attempts = 0;
    const flaky = makeCliConfigPromiseIo({
      loadSchema: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("schema unavailable");
        }
        return toCliConfigJsonSchema();
      },
    });

    await expect(flaky.validateCliConfig({})).rejects.toThrow("schema unavailable");
    expect(await flaky.validateCliConfig({})).toEqual([]);
  });
});

describe("saveCliConfig", () => {
  test("creates supabase/config.json and loads back what it saved", async () => {
    const saved = await io.saveCliConfig({ cwd: root, config: { api: { port: 54322 } } });

    expect(saved.path).toBe(join(root, "supabase", "config.json"));
    expect((await io.loadCliConfig(root))?.config).toEqual({ api: { port: 54322 } });
  });

  test("round-trips TOML and keeps the #:schema directive", async () => {
    await write(
      "config.toml",
      "#:schema https://supabase.com/schemas/config/v1.json\n[api]\nport = 1\n",
    );

    await io.saveCliConfig({ cwd: root, config: { api: { port: 54323 } } });

    const text = await readFile(join(root, "supabase", "config.toml"), "utf8");
    expect(text.startsWith("#:schema https://supabase.com/schemas/config/v1.json\n")).toBe(true);
    expect((await io.loadCliConfig(root))?.config).toEqual({ api: { port: 54323 } });
  });

  test("keeps comments in an existing JSONC file", async () => {
    await write("config.jsonc", '{\n  // the API\n  "api": { "port": 1 }\n}\n');

    await io.saveCliConfig({ cwd: root, config: { api: { port: 2 } } });

    const text = await readFile(join(root, "supabase", "config.jsonc"), "utf8");
    expect(text).toContain("// the API");
    expect((await io.loadCliConfig(root))?.config).toEqual({ api: { port: 2 } });
  });

  test("switching format removes the other config file", async () => {
    await write("config.toml", "[api]\nport = 1\n");

    await io.saveCliConfig({ cwd: root, config: { api: { port: 3 } }, format: "json" });

    expect((await io.loadCliConfig(root))?.format).toBe("json");
    await expect(readFile(join(root, "supabase", "config.toml"))).rejects.toThrow();
  });

  test("refuses to write a schema-invalid config and leaves the file untouched", async () => {
    await write("config.toml", "[api]\nport = 1\n");

    await expect(
      io.saveCliConfig({ cwd: root, config: { api: { port: "bad" } } }),
    ).rejects.toMatchObject({ reason: "invalid_config" });
    expect(await readFile(join(root, "supabase", "config.toml"), "utf8")).toBe("[api]\nport = 1\n");
  });
});
