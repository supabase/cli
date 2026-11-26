import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import * as promiseIo from "./io-promises.ts";

const roots: Array<string> = [];

afterAll(() => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));
afterEach(() => vi.unstubAllEnvs());

async function project(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "supabase-config-promises-"));
  roots.push(root);
  await mkdir(join(root, "supabase"), { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    await writeFile(join(root, "supabase", name), text);
  }
  return root;
}

async function rejection(run: () => Promise<unknown>): Promise<Error & { issues?: unknown }> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the call to reject");
}

describe("diagnostics never include a resolved env() value", () => {
  const SECRET = "sk_live_9f8e7d6c5b4a!";

  test.each([
    [
      "a migration-check severity",
      `[db.migrations.checks]\nrls_disabled_in_public = "env(LEAK)"\n`,
    ],
    [
      "a migration-check exclusion",
      `[db.migrations.checks.exclude]\nrls_disabled_in_public = ["env(LEAK)"]\n`,
    ],
    ["a service version", `[local.services.auth]\nversion = "env(LEAK)"\n`],
    ["the default service version", `[local.services.default]\nversion = "env(LEAK)"\n`],
  ])("%s", async (_name, text) => {
    vi.stubEnv("LEAK", SECRET);
    const root = await project({ "config.toml": text });

    const error = await rejection(() => promiseIo.loadCliConfig(root));

    expect(error).toBeInstanceOf(promiseIo.CliConfigParseError);
    expect(error.message).not.toContain(SECRET);
    expect(JSON.stringify(error.issues)).not.toContain(SECRET);
    expect((error.issues as ReadonlyArray<unknown>).length).toBeGreaterThan(0);
  });

  test("saving a rejected value omits it too", async () => {
    const root = await project({});

    const error = await rejection(() =>
      promiseIo.saveCliConfig({
        cwd: root,
        config: { db: { migrations: { checks: { rls_disabled_in_public: SECRET } } } },
      }),
    );

    expect(error.message).toContain("rls_disabled_in_public");
    expect(error.message).not.toContain(SECRET);
    expect(JSON.stringify(error.issues)).not.toContain(SECRET);
  });
});

describe("saveCliConfig with values structuredClone cannot copy", () => {
  test("a function at a known path is a CliConfigParseError", async () => {
    const root = await project({});

    const error = await rejection(() =>
      promiseIo.saveCliConfig({ cwd: root, config: { project_id: () => "x" } }),
    );

    expect(error).toBeInstanceOf(promiseIo.CliConfigParseError);
    expect(error.issues).toEqual([expect.objectContaining({ path: "project_id" })]);
  });

  test("a function at an unknown path is stripped", async () => {
    const root = await project({});

    await promiseIo.saveCliConfig({
      cwd: root,
      config: { project_id: "kept", not_a_key: () => "x", api: { port: 54399, nope: () => 1 } },
      format: "toml",
    });

    const text = await readFile(join(root, "supabase", "config.toml"), "utf8");
    expect(text).toContain('project_id = "kept"');
    expect(text).toContain("54399");
    expect(text).not.toContain("not_a_key");
  });
});

describe("saveCliConfig and the TOML #:schema directive", () => {
  const OLD = "https://example.test/old.json";
  const NEW = "https://example.test/new.json";
  const existing = `#:schema ${OLD}\nproject_id = "old"\n`;

  test("a different schemaRef replaces the existing directive", async () => {
    const root = await project({ "config.toml": existing });

    const saved = await promiseIo.saveCliConfig({
      cwd: root,
      config: { project_id: "new" },
      format: "toml",
      schemaRef: NEW,
    });

    const text = await readFile(join(root, "supabase", "config.toml"), "utf8");
    expect(text).not.toContain(OLD);
    expect(text.startsWith(`#:schema ${NEW}\n`)).toBe(true);
    expect(saved.schemaRef).toBe(NEW);
    expect((await promiseIo.loadCliConfigFile(saved.path)).schemaRef).toBe(NEW);
  });

  test("an omitted schemaRef keeps the existing directive", async () => {
    const root = await project({ "config.toml": existing });

    await promiseIo.saveCliConfig({ cwd: root, config: { project_id: "new" }, format: "toml" });

    const text = await readFile(join(root, "supabase", "config.toml"), "utf8");
    expect(text.startsWith(`#:schema ${OLD}\n`)).toBe(true);
  });
});
