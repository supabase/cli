import { BunServices } from "@effect/platform-bun";
import { afterEach, describe, expect, test } from "vitest";
import { Effect, FileSystem, Path } from "effect";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeMergedCliConfig, loadCliConfig, parseMergeCliConfig } from "./io.ts";

const roots: Array<string> = [];

async function makeProject(toml: string): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "supabase-config-stages-"));
  roots.push(root);
  await mkdir(join(root, "supabase"), { recursive: true });
  await writeFile(join(root, "supabase", "config.toml"), toml);
  return root;
}

function run<A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)));
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const toml = `
project_id = "local"

[db]
port = 54399

[remotes.staging]
project_id = "abcdefghijklmnopqrst"

[remotes.staging.db]
major_version = 15
`;

describe("config pipeline stages", () => {
  test("parseMerge then decode matches loadCliConfig for the same remote", async () => {
    const cwd = await makeProject(toml);
    const staged = await run(
      Effect.gen(function* () {
        const merged = yield* parseMergeCliConfig(cwd, {
          search: false,
          selectRemote: () => "staging",
        });
        if (merged === null) return null;
        return yield* decodeMergedCliConfig(merged, { envValues: {} });
      }),
    );
    const loaded = await run(
      loadCliConfig(cwd, {
        search: false,
        cliProjectEnv: {
          paths: {
            projectRoot: cwd,
            supabaseDir: join(cwd, "supabase"),
            configPath: join(cwd, "supabase", "config.toml"),
            envPath: join(cwd, "supabase", ".env"),
            envLocalPath: join(cwd, "supabase", ".env.local"),
          },
          values: {},
          loadedPaths: [],
          sources: {},
        },
        projectRef: "abcdefghijklmnopqrst",
      }),
    );

    expect(staged?.appliedRemote).toBe("staging");
    expect(staged?.config).toEqual(loaded?.config);
    expect(staged?.config.db.major_version).toBe(15);
    expect(staged?.config.db.seed.enabled).toBe(false);
  });

  test("a selector that matches nothing leaves the base document", async () => {
    const cwd = await makeProject(toml);
    const merged = await run(
      parseMergeCliConfig(cwd, { search: false, selectRemote: () => "missing" }),
    );

    expect(merged?.appliedRemote).toBeUndefined();
    expect(merged?.remoteLeafPaths).toEqual([]);
  });

  test("decode takes the overlaid document instead of the merged one", async () => {
    const cwd = await makeProject(toml);
    const decoded = await run(
      Effect.gen(function* () {
        const merged = yield* parseMergeCliConfig(cwd, {
          search: false,
          selectRemote: () => undefined,
        });
        if (merged === null || merged.document === null || typeof merged.document !== "object") {
          return null;
        }
        return yield* decodeMergedCliConfig(merged, {
          envValues: {},
          document: { ...merged.document, db: { port: 54400 } },
        });
      }),
    );

    expect(decoded?.config.db.port).toBe(54400);
  });

  test("env references resolve against the supplied env record", async () => {
    const cwd = await makeProject('project_id = "env(PROJECT_NAME)"\n');
    const decoded = await run(
      Effect.gen(function* () {
        const merged = yield* parseMergeCliConfig(cwd, {
          search: false,
          selectRemote: () => undefined,
        });
        if (merged === null) return null;
        return yield* decodeMergedCliConfig(merged, { envValues: { PROJECT_NAME: "from-env" } });
      }),
    );

    expect(decoded?.config.project_id).toBe("from-env");
    expect(decoded?.valueOrigins).toContainEqual({
      path: ["project_id"],
      source: "environment",
      envVariables: ["PROJECT_NAME"],
    });
  });
});
