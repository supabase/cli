import { BunServices } from "@effect/platform-bun";
import { describe, expect, test } from "vitest";
import { Effect, FileSystem, Path, type Scope } from "effect";
import {
  decodeMergedCliConfig,
  loadCliConfig,
  mergeParsedCliConfig,
  parseCliConfigDocumentFile,
  type ParseMergeCliConfigOptions,
} from "./io.ts";

const parseMerge = (
  cwd: string,
  options: ParseMergeCliConfigOptions & { readonly search?: boolean; readonly tomlOnly?: boolean },
) =>
  Effect.gen(function* () {
    const parsed = yield* parseCliConfigDocumentFile(cwd, options);
    return parsed === null ? null : yield* mergeParsedCliConfig(parsed, options);
  });

const makeProject = Effect.fn("ioStages.makeProject")(function* (toml: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-config-stages-" });
  yield* fs.makeDirectory(path.join(root, "supabase"), { recursive: true });
  yield* fs.writeFileString(path.join(root, "supabase", "config.toml"), toml);
  return root;
});

function run<A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(BunServices.layer)));
}

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
  test("parseMerge then decode matches loadCliConfig for the same remote", () =>
    run(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const cwd = yield* makeProject(toml);
        const merged = yield* parseMerge(cwd, {
          search: false,
          selectRemote: () => "staging",
        });
        const staged =
          merged === null ? null : yield* decodeMergedCliConfig(merged, { envValues: {} });
        const loaded = yield* loadCliConfig(cwd, {
          search: false,
          cliProjectEnv: {
            paths: {
              projectRoot: cwd,
              supabaseDir: path.join(cwd, "supabase"),
              configPath: path.join(cwd, "supabase", "config.toml"),
              envPath: path.join(cwd, "supabase", ".env"),
              envLocalPath: path.join(cwd, "supabase", ".env.local"),
            },
            values: {},
            loadedPaths: [],
            sources: {},
          },
          projectRef: "abcdefghijklmnopqrst",
        });

        expect(staged?.appliedRemote).toBe("staging");
        expect(staged?.config).toEqual(loaded?.config);
        expect(staged?.config.db.major_version).toBe(15);
        expect(staged?.config.db.seed.enabled).toBe(false);
      }),
    ));

  test("a selector that matches nothing leaves the base document", () =>
    run(
      Effect.gen(function* () {
        const cwd = yield* makeProject(toml);
        const merged = yield* parseMerge(cwd, { search: false, selectRemote: () => "missing" });

        expect(merged?.appliedRemote).toBeUndefined();
        expect(merged?.remoteLeafPaths).toEqual([]);
      }),
    ));

  test("decode takes the overlaid document instead of the merged one", () =>
    run(
      Effect.gen(function* () {
        const cwd = yield* makeProject(toml);
        const merged = yield* parseMerge(cwd, {
          search: false,
          selectRemote: () => undefined,
        });
        const decoded =
          merged === null || merged.document === null || typeof merged.document !== "object"
            ? null
            : yield* decodeMergedCliConfig(merged, {
                envValues: {},
                document: { ...merged.document, db: { port: 54400 } },
              });

        expect(decoded?.config.db.port).toBe(54400);
      }),
    ));

  test("env references resolve against the supplied env record", () =>
    run(
      Effect.gen(function* () {
        const cwd = yield* makeProject('project_id = "env(PROJECT_NAME)"\n');
        const merged = yield* parseMerge(cwd, {
          search: false,
          selectRemote: () => undefined,
        });
        const decoded =
          merged === null
            ? null
            : yield* decodeMergedCliConfig(merged, { envValues: { PROJECT_NAME: "from-env" } });

        expect(decoded?.config.project_id).toBe("from-env");
        expect(decoded?.valueOrigins).toContainEqual({
          path: ["project_id"],
          source: "environment",
          envVariables: ["PROJECT_NAME"],
        });
      }),
    ));

  test("a resolved path stays verbatim while an unlisted sibling still resolves", () =>
    run(
      Effect.gen(function* () {
        const cwd = yield* makeProject(
          'project_id = "env(PROJECT_NAME)"\n[auth]\nsite_url = "env(SITE)"\n',
        );
        const merged = yield* parseMerge(cwd, { search: false, selectRemote: () => undefined });
        const decoded =
          merged === null
            ? null
            : yield* decodeMergedCliConfig(merged, {
                envValues: { PROJECT_NAME: "from-env", SITE: "http://resolved.test" },
                resolvedPaths: [["auth", "site_url"]],
              });

        expect(decoded?.config.project_id).toBe("from-env");
        expect(decoded?.config.auth.site_url).toBe("env(SITE)");
      }),
    ));

  test("the parse stage rejects removed keys, including in a remote no stage selects", () =>
    run(
      Effect.gen(function* () {
        const cwd = yield* makeProject(
          `[remotes.staging]
project_id = "abcdefghijklmnopqrst"

[remotes.staging.inbucket]
enabled = true
`,
        );

        const failure = yield* Effect.flip(parseCliConfigDocumentFile(cwd, { search: false }));

        expect(failure).toMatchObject({
          _tag: "CliConfigRemovedKeyError",
          removedKeys: [
            { key: "[remotes.staging.inbucket]", replacement: "[remotes.staging.local_smtp]" },
          ],
        });
      }),
    ));
});

describe("remote validation", () => {
  const duplicateToml = `
[remotes.a]
project_id = "abcdefghijklmnopqrst"

[remotes.b]
project_id = "abcdefghijklmnopqrst"
`;

  test("parseMerge leaves remote validation to the caller unless asked", () =>
    run(
      Effect.gen(function* () {
        const cwd = yield* makeProject(duplicateToml);

        const unvalidated = yield* parseMerge(cwd, {
          search: false,
          selectRemote: () => undefined,
        });
        const failure = yield* Effect.flip(
          parseMerge(cwd, {
            search: false,
            selectRemote: () => undefined,
            validateRemotes: true,
          }),
        );

        expect(unvalidated?.appliedRemote).toBeUndefined();
        expect(failure._tag).toBe("DuplicateRemoteProjectIdError");
      }),
    ));

  test("a malformed remote project_id fails the explicit format check", () =>
    run(
      Effect.gen(function* () {
        const cwd = yield* makeProject('[remotes.a]\nproject_id = "short"\n');

        const failure = yield* Effect.flip(
          parseMerge(cwd, {
            search: false,
            selectRemote: () => undefined,
            validateRemotes: true,
          }),
        );

        expect(failure._tag).toBe("InvalidRemoteProjectIdError");
      }),
    ));

  test("the parse and merge halves compose to parseMerge", () =>
    run(
      Effect.gen(function* () {
        const cwd = yield* makeProject(toml);

        const parsed = yield* parseCliConfigDocumentFile(cwd, { search: false });
        const composed =
          parsed === null
            ? null
            : yield* mergeParsedCliConfig(parsed, { selectRemote: () => "staging" });
        const whole = yield* parseMerge(cwd, { search: false, selectRemote: () => "staging" });

        expect(composed).toEqual(whole);
        expect(composed?.appliedRemote).toBe("staging");
      }),
    ));
});
