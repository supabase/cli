import { BunServices } from "@effect/platform-bun";
import { describe, expect, layer } from "@effect/vitest";
import type { CliProjectEnvironment } from "@supabase/config";
import { Cause, ConfigProvider, Effect, Exit, FileSystem, Option, Path, Tracer } from "effect";

import { withConfigEnv, withEnvVar } from "../../tests/helpers/command-mocks.ts";
import { ProjectEnvironmentError, resolveProjectEnvironmentValues } from "./project-environment.ts";

const project = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-project-env-" });
  const supabaseDir = path.join(root, "supabase");
  yield* fs.makeDirectory(supabaseDir, { recursive: true });
  return { fs, path, root, supabaseDir };
});

function fakeProjectEnv(
  { path, root, supabaseDir }: Effect.Success<typeof project>,
  values: Record<string, string> = {},
  sources: Record<string, "ambient" | ".env" | ".env.local"> = {},
): CliProjectEnvironment {
  return {
    paths: {
      projectRoot: root,
      supabaseDir,
      configPath: path.join(supabaseDir, "config.toml"),
      envPath: path.join(supabaseDir, ".env"),
      envLocalPath: path.join(supabaseDir, ".env.local"),
    },
    values,
    loadedPaths: [],
    // Defaults each value's source to "ambient" so callers don't need to spell it out.
    sources: Object.fromEntries(Object.keys(values).map((key) => [key, sources[key] ?? "ambient"])),
  };
}

layer(BunServices.layer)("resolveProjectEnvironmentValues", (it) => {
  it.effect("returns just the already-loaded values when no extra dotenv files exist", () =>
    Effect.gen(function* () {
      const dirs = yield* project;
      const projectEnv = fakeProjectEnv(dirs, { SUPABASE_PROJECT_ID: "from-loader" });
      expect(yield* resolveProjectEnvironmentValues(projectEnv, dirs.root)).toEqual({
        SUPABASE_PROJECT_ID: "from-loader",
      });
    }),
  );

  it.effect("fills in a value from a project-root .env file Go's loadNestedEnv would load", () =>
    Effect.gen(function* () {
      const dirs = yield* project;
      const { fs, path, root } = dirs;
      yield* fs.writeFileString(path.join(root, ".env"), "SUPABASE_PROJECT_ID=root-env-project\n");
      const merged = yield* resolveProjectEnvironmentValues(fakeProjectEnv(dirs), root);
      expect(merged["SUPABASE_PROJECT_ID"]).toBe("root-env-project");
    }),
  );

  it.effect("prefers a supabase/-dir dotenv file over the same key in a project-root file", () =>
    Effect.gen(function* () {
      const dirs = yield* project;
      const { fs, path, root, supabaseDir } = dirs;
      yield* fs.writeFileString(
        path.join(supabaseDir, ".env"),
        "SUPABASE_PROJECT_ID=supabase-dir-project\n",
      );
      yield* fs.writeFileString(path.join(root, ".env"), "SUPABASE_PROJECT_ID=root-dir-project\n");
      const merged = yield* resolveProjectEnvironmentValues(fakeProjectEnv(dirs), root);
      expect(merged["SUPABASE_PROJECT_ID"]).toBe("supabase-dir-project");
    }),
  );

  it.effect("lets already-resolved projectEnv.values win over anything discovered locally", () =>
    Effect.gen(function* () {
      const dirs = yield* project;
      const { fs, path, root } = dirs;
      yield* fs.writeFileString(path.join(root, ".env"), "SUPABASE_PROJECT_ID=root-env-project\n");
      const projectEnv = fakeProjectEnv(dirs, { SUPABASE_PROJECT_ID: "ambient-project" });
      const merged = yield* resolveProjectEnvironmentValues(projectEnv, root);
      expect(merged["SUPABASE_PROJECT_ID"]).toBe("ambient-project");
    }),
  );

  it.effect("defaults SUPABASE_ENV to development when unset", () =>
    Effect.gen(function* () {
      const dirs = yield* project;
      const { fs, path, root } = dirs;
      yield* fs.writeFileString(
        path.join(root, ".env.development"),
        "SUPABASE_PROJECT_ID=dev-project\n",
      );
      const merged = yield* resolveProjectEnvironmentValues(fakeProjectEnv(dirs), root);
      expect(merged["SUPABASE_PROJECT_ID"]).toBe("dev-project");
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({})))),
  );

  it.effect("selects the SUPABASE_ENV-named file over the bare .env file", () =>
    Effect.gen(function* () {
      const dirs = yield* project;
      const { fs, path, root } = dirs;
      yield* fs.writeFileString(path.join(root, ".env"), "SUPABASE_PROJECT_ID=bare-env-project\n");
      yield* fs.writeFileString(
        path.join(root, ".env.production"),
        "SUPABASE_PROJECT_ID=prod-project\n",
      );
      const merged = yield* resolveProjectEnvironmentValues(fakeProjectEnv(dirs), root);
      expect(merged["SUPABASE_PROJECT_ID"]).toBe("prod-project");
    }).pipe((body) => withConfigEnv({ SUPABASE_ENV: "production" }, body)),
  );

  it.effect("prefers the .local variant of the SUPABASE_ENV file over the non-local one", () =>
    Effect.gen(function* () {
      const dirs = yield* project;
      const { fs, path, root } = dirs;
      yield* fs.writeFileString(
        path.join(root, ".env.production"),
        "SUPABASE_PROJECT_ID=prod-project\n",
      );
      yield* fs.writeFileString(
        path.join(root, ".env.production.local"),
        "SUPABASE_PROJECT_ID=prod-local-project\n",
      );
      const merged = yield* resolveProjectEnvironmentValues(fakeProjectEnv(dirs), root);
      expect(merged["SUPABASE_PROJECT_ID"]).toBe("prod-local-project");
    }).pipe((body) => withConfigEnv({ SUPABASE_ENV: "production" }, body)),
  );

  it.effect("skips .env.local when SUPABASE_ENV=test, matching Go's loadDefaultEnv", () =>
    Effect.gen(function* () {
      const dirs = yield* project;
      const { fs, path, root } = dirs;
      yield* fs.writeFileString(
        path.join(root, ".env.local"),
        "SUPABASE_PROJECT_ID=local-project\n",
      );
      yield* fs.writeFileString(path.join(root, ".env.test"), "SUPABASE_PROJECT_ID=test-project\n");
      const merged = yield* resolveProjectEnvironmentValues(fakeProjectEnv(dirs), root);
      expect(merged["SUPABASE_PROJECT_ID"]).toBe("test-project");
    }).pipe((body) => withConfigEnv({ SUPABASE_ENV: "test" }, body)),
  );

  it.effect("prefers an explicit supabaseEnv argument over the configured SUPABASE_ENV", () =>
    Effect.gen(function* () {
      const dirs = yield* project;
      const { fs, path, root } = dirs;
      yield* fs.writeFileString(path.join(root, ".env"), "SUPABASE_PROJECT_ID=bare-env-project\n");
      yield* fs.writeFileString(
        path.join(root, ".env.local"),
        "SUPABASE_PROJECT_ID=local-project\n",
      );
      const merged = yield* resolveProjectEnvironmentValues(fakeProjectEnv(dirs), root, "test");
      expect(merged["SUPABASE_PROJECT_ID"]).toBe("bare-env-project");
    }).pipe((body) => withConfigEnv({ SUPABASE_ENV: "production" }, body)),
  );

  it.effect("falls back to the configured SUPABASE_ENV when no supabaseEnv argument is given", () =>
    Effect.gen(function* () {
      const dirs = yield* project;
      const { fs, path, root } = dirs;
      yield* fs.writeFileString(path.join(root, ".env"), "SUPABASE_PROJECT_ID=bare-env-project\n");
      yield* fs.writeFileString(
        path.join(root, ".env.production"),
        "SUPABASE_PROJECT_ID=prod-project\n",
      );
      const merged = yield* resolveProjectEnvironmentValues(fakeProjectEnv(dirs), root);
      expect(merged["SUPABASE_PROJECT_ID"]).toBe("prod-project");
    }).pipe((body) => withConfigEnv({ SUPABASE_ENV: "production" }, body)),
  );

  it.effect("strips quotes the same way the shared dotenv parser does", () =>
    Effect.gen(function* () {
      const dirs = yield* project;
      const { fs, path, root } = dirs;
      yield* fs.writeFileString(
        path.join(root, ".env"),
        'SUPABASE_AUTH_JWT_SECRET="a quoted value"\n',
      );
      const merged = yield* resolveProjectEnvironmentValues(fakeProjectEnv(dirs), root);
      expect(merged["SUPABASE_AUTH_JWT_SECRET"]).toBe("a quoted value");
    }),
  );

  it.effect("ignores blank lines and comments", () =>
    Effect.gen(function* () {
      const dirs = yield* project;
      const { fs, root } = dirs;
      yield* fs.writeFileString(
        root + "/.env",
        "\n# a comment\nSUPABASE_PROJECT_ID=commented-project\n",
      );
      const merged = yield* resolveProjectEnvironmentValues(fakeProjectEnv(dirs), root);
      expect(merged["SUPABASE_PROJECT_ID"]).toBe("commented-project");
    }),
  );

  it.effect(
    "preserves a literal # in an unquoted value with no leading whitespace, matching godotenv",
    () =>
      Effect.gen(function* () {
        const dirs = yield* project;
        const { fs, root } = dirs;
        yield* fs.writeFileString(root + "/.env", "SUPABASE_AUTH_JWT_SECRET=long#secret\n");
        const merged = yield* resolveProjectEnvironmentValues(fakeProjectEnv(dirs), root);
        expect(merged["SUPABASE_AUTH_JWT_SECRET"]).toBe("long#secret");
      }),
  );

  it.effect("still truncates an unquoted value at a whitespace-preceded inline comment", () =>
    Effect.gen(function* () {
      const dirs = yield* project;
      const { fs, root } = dirs;
      yield* fs.writeFileString(root + "/.env", "SUPABASE_PROJECT_ID=54323 # local\n");
      const merged = yield* resolveProjectEnvironmentValues(fakeProjectEnv(dirs), root);
      expect(merged["SUPABASE_PROJECT_ID"]).toBe("54323");
    }),
  );

  it.effect("strips a trailing comment after a quoted value, matching godotenv", () =>
    Effect.gen(function* () {
      const dirs = yield* project;
      const { fs, root } = dirs;
      yield* fs.writeFileString(root + "/.env", 'SUPABASE_PROJECT_ID="demo" # local\n');
      const merged = yield* resolveProjectEnvironmentValues(fakeProjectEnv(dirs), root);
      expect(merged["SUPABASE_PROJECT_ID"]).toBe("demo");
    }),
  );

  it.effect(
    "accepts a colon-separated assignment, matching godotenv's YAML-style key/value form",
    () =>
      Effect.gen(function* () {
        const dirs = yield* project;
        const { fs, root } = dirs;
        yield* fs.writeFileString(root + "/.env", "SUPABASE_PROJECT_ID: colon-project\n");
        const merged = yield* resolveProjectEnvironmentValues(fakeProjectEnv(dirs), root);
        expect(merged["SUPABASE_PROJECT_ID"]).toBe("colon-project");
      }),
  );

  it.effect(
    "prefers an env-specific file over a same-key value projectEnv.values sourced from a bare .env file",
    () =>
      Effect.gen(function* () {
        // Only an "ambient" source outranks the file precedence computed locally.
        const dirs = yield* project;
        const { fs, path, root, supabaseDir } = dirs;
        yield* fs.writeFileString(
          path.join(supabaseDir, ".env.development.local"),
          "SUPABASE_PROJECT_ID=env-specific-project\n",
        );
        const projectEnv = fakeProjectEnv(
          dirs,
          { SUPABASE_PROJECT_ID: "bare-dotenv-project" },
          { SUPABASE_PROJECT_ID: ".env" },
        );
        const merged = yield* resolveProjectEnvironmentValues(projectEnv, root);
        expect(merged["SUPABASE_PROJECT_ID"]).toBe("env-specific-project");
      }).pipe((body) => withConfigEnv({ SUPABASE_ENV: "development" }, body)),
  );

  it.effect("still lets a truly ambient-sourced value win over any file", () =>
    Effect.gen(function* () {
      const dirs = yield* project;
      const { fs, path, root, supabaseDir } = dirs;
      yield* fs.writeFileString(
        path.join(supabaseDir, ".env.development.local"),
        "SUPABASE_PROJECT_ID=env-specific-project\n",
      );
      const projectEnv = fakeProjectEnv(
        dirs,
        { SUPABASE_PROJECT_ID: "ambient-project" },
        { SUPABASE_PROJECT_ID: "ambient" },
      );
      const merged = yield* resolveProjectEnvironmentValues(projectEnv, root);
      expect(merged["SUPABASE_PROJECT_ID"]).toBe("ambient-project");
    }).pipe((body) => withConfigEnv({ SUPABASE_ENV: "development" }, body)),
  );

  it.effect(
    "fails on a malformed line, matching Go's loadEnvIfExists propagating godotenv's parse error",
    () =>
      Effect.gen(function* () {
        const dirs = yield* project;
        const { fs, path, root } = dirs;
        yield* fs.writeFileString(path.join(root, ".env"), "not a valid line\n");
        const exit = yield* resolveProjectEnvironmentValues(fakeProjectEnv(dirs), root).pipe(
          Effect.exit,
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toBeInstanceOf(
            ProjectEnvironmentError,
          );
          expect(Cause.pretty(exit.cause)).toMatch(/^Error: failed to parse environment file: /);
        }
      }),
  );

  it.effect("keeps a leading BOM, so a BOM-prefixed .env fails to parse", () =>
    Effect.gen(function* () {
      const dirs = yield* project;
      const { fs, path, root } = dirs;
      yield* fs.writeFileString(path.join(root, ".env"), "\uFEFFSUPABASE_PROJECT_ID=bom-project\n");
      const exit = yield* resolveProjectEnvironmentValues(fakeProjectEnv(dirs), root).pipe(
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toMatch(/^Error: failed to parse environment file: /);
      }
    }),
  );

  it.effect("fails with the native read error when a dotenv path is a directory", () =>
    Effect.gen(function* () {
      const dirs = yield* project;
      const { fs, path, root } = dirs;
      yield* fs.makeDirectory(path.join(root, ".env"));
      const exit = yield* resolveProjectEnvironmentValues(fakeProjectEnv(dirs), root).pipe(
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toMatch(/^Error: EISDIR/);
      }
    }),
  );

  it.effect("fails with a typed error when SUPABASE_ENV cannot be resolved", () =>
    Effect.gen(function* () {
      const dirs = yield* project;
      const error = yield* resolveProjectEnvironmentValues(fakeProjectEnv(dirs), dirs.root).pipe(
        Effect.flip,
      );
      expect(error).toBeInstanceOf(ProjectEnvironmentError);
      expect(error.message).toBe("failed to resolve environment variable: SUPABASE_ENV");
    }).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.make(() =>
            Effect.fail(new ConfigProvider.SourceError({ message: "injected" })),
          ),
        ),
      ),
    ),
  );

  it.effect("skips a dotenv path that is a symlink loop, like a missing file", () =>
    Effect.gen(function* () {
      const dirs = yield* project;
      const { fs, path, root } = dirs;
      yield* fs.symlink(path.join(root, ".env"), path.join(root, ".env"));
      const merged = yield* resolveProjectEnvironmentValues(fakeProjectEnv(dirs), root);
      expect(merged).toEqual({});
    }),
  );

  it.effect("expands an unquoted $VAR reference to an earlier value in the same file", () =>
    Effect.gen(function* () {
      const dirs = yield* project;
      const { fs, path, root } = dirs;
      yield* fs.writeFileString(path.join(root, ".env"), "BASE=demo\nSUPABASE_PROJECT_ID=$BASE\n");
      const merged = yield* resolveProjectEnvironmentValues(fakeProjectEnv(dirs), root);
      expect(merged["SUPABASE_PROJECT_ID"]).toBe("demo");
    }),
  );

  it.effect("expands a braced ${VAR} reference in a double-quoted value", () =>
    Effect.gen(function* () {
      const dirs = yield* project;
      const { fs, path, root } = dirs;
      yield* fs.writeFileString(
        path.join(root, ".env"),
        'SECRET=shh\nSUPABASE_AUTH_JWT_SECRET="${SECRET}"\n',
      );
      const merged = yield* resolveProjectEnvironmentValues(fakeProjectEnv(dirs), root);
      expect(merged["SUPABASE_AUTH_JWT_SECRET"]).toBe("shh");
    }),
  );

  it.effect("does not expand variable references inside single-quoted values", () =>
    Effect.gen(function* () {
      const dirs = yield* project;
      const { fs, path, root } = dirs;
      yield* fs.writeFileString(
        path.join(root, ".env"),
        "BASE=demo\nSUPABASE_PROJECT_ID='$BASE'\n",
      );
      const merged = yield* resolveProjectEnvironmentValues(fakeProjectEnv(dirs), root);
      expect(merged["SUPABASE_PROJECT_ID"]).toBe("$BASE");
    }),
  );

  it.effect(
    "expands an unresolved bare reference to an empty string, matching Go's map zero-value",
    () =>
      Effect.gen(function* () {
        const dirs = yield* project;
        const { fs, path, root } = dirs;
        yield* fs.writeFileString(path.join(root, ".env"), "SUPABASE_PROJECT_ID=$NOPE\n");
        const merged = yield* resolveProjectEnvironmentValues(fakeProjectEnv(dirs), root);
        expect(merged["SUPABASE_PROJECT_ID"]).toBe("");
      }),
  );

  it.effect(
    "expands an unresolved braced reference to an empty string, matching Go's map zero-value",
    () =>
      Effect.gen(function* () {
        const dirs = yield* project;
        const { fs, path, root } = dirs;
        yield* fs.writeFileString(path.join(root, ".env"), 'SUPABASE_AUTH_JWT_SECRET="${NOPE}"\n');
        const merged = yield* resolveProjectEnvironmentValues(fakeProjectEnv(dirs), root);
        expect(merged["SUPABASE_AUTH_JWT_SECRET"]).toBe("");
      }),
  );

  it.effect(
    "preserves a backslash-escaped $VAR reference as a literal, matching godotenv's escape rule",
    () =>
      Effect.gen(function* () {
        const dirs = yield* project;
        const { fs, path, root } = dirs;
        yield* fs.writeFileString(
          path.join(root, ".env"),
          "BASE=demo\nSUPABASE_PROJECT_ID=demo\\$BASE\n",
        );
        const merged = yield* resolveProjectEnvironmentValues(fakeProjectEnv(dirs), root);
        expect(merged["SUPABASE_PROJECT_ID"]).toBe("demo$BASE");
      }),
  );

  it.effect("preserves a backslash-escaped ${VAR} reference in a double-quoted value", () =>
    Effect.gen(function* () {
      const dirs = yield* project;
      const { fs, path, root } = dirs;
      yield* fs.writeFileString(
        path.join(root, ".env"),
        'BASE=demo\nSUPABASE_PROJECT_ID="demo\\${BASE}"\n',
      );
      const merged = yield* resolveProjectEnvironmentValues(fakeProjectEnv(dirs), root);
      expect(merged["SUPABASE_PROJECT_ID"]).toBe("demo${BASE}");
    }),
  );

  it.effect("treats a bare trailing $ with no variable name as a literal", () =>
    Effect.gen(function* () {
      const dirs = yield* project;
      const { fs, path, root } = dirs;
      yield* fs.writeFileString(path.join(root, ".env"), "SUPABASE_PROJECT_ID=demo$\n");
      const merged = yield* resolveProjectEnvironmentValues(fakeProjectEnv(dirs), root);
      expect(merged["SUPABASE_PROJECT_ID"]).toBe("demo$");
    }),
  );

  it.effect(
    "preserves a multiline quoted value alongside an unrelated SUPABASE_* key (godotenv parity)",
    () =>
      Effect.gen(function* () {
        // A quoted value spanning physical lines (e.g. a pasted PEM key) must not break
        // parsing of the rest of the file.
        const pem = "-----BEGIN PRIVATE KEY-----\nMIIBogIBAAJ\n-----END PRIVATE KEY-----";
        const dirs = yield* project;
        const { fs, path, root } = dirs;
        yield* fs.writeFileString(
          path.join(root, ".env"),
          `PRIVATE_KEY="${pem}"\nSUPABASE_PROJECT_ID=multiline-safe-project\n`,
        );
        const merged = yield* resolveProjectEnvironmentValues(fakeProjectEnv(dirs), root);
        expect(merged["SUPABASE_PROJECT_ID"]).toBe("multiline-safe-project");
      }),
  );

  it.effect(
    "records the parsed dotenv file count on one resolve span, and no span when tracing is off",
    () =>
      Effect.gen(function* () {
        const spans: Array<Tracer.NativeSpan> = [];
        const tracer = Tracer.make({
          span(options) {
            const span = new Tracer.NativeSpan(options);
            spans.push(span);
            return span;
          },
        });
        const dirs = yield* project;
        const { fs, path, root, supabaseDir } = dirs;
        yield* fs.writeFileString(
          path.join(supabaseDir, ".env"),
          "SUPABASE_PROJECT_ID=supabase-dir-project\n",
        );
        yield* fs.writeFileString(
          path.join(root, ".env.development"),
          "SUPABASE_AUTH_JWT_SECRET=dev-secret\n",
        );
        const resolve = resolveProjectEnvironmentValues(fakeProjectEnv(dirs), root).pipe(
          Effect.withTracer(tracer),
        );
        const expected = {
          SUPABASE_PROJECT_ID: "supabase-dir-project",
          SUPABASE_AUTH_JWT_SECRET: "dev-secret",
        };

        expect(yield* resolve.pipe(Effect.withTracerEnabled(false))).toEqual(expected);
        expect(spans).toEqual([]);

        expect(yield* resolve.pipe(Effect.withTracerEnabled(true))).toEqual(expected);
        expect(spans.map((span) => span.name)).toEqual(["ProjectEnvironment.resolve"]);
        expect(spans[0]?.attributes.get("file.count")).toBe(2);
      }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({})))),
  );

  it.effect("counts a .env.local file once when SUPABASE_ENV is local", () =>
    Effect.gen(function* () {
      const spans: Array<Tracer.NativeSpan> = [];
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      const dirs = yield* project;
      const { fs, path, root, supabaseDir } = dirs;
      yield* fs.writeFileString(
        path.join(supabaseDir, ".env.local"),
        "SUPABASE_PROJECT_ID=local-project\n",
      );
      const merged = yield* resolveProjectEnvironmentValues(
        fakeProjectEnv(dirs),
        root,
        "local",
      ).pipe(Effect.withTracer(tracer), Effect.withTracerEnabled(true));
      expect(merged["SUPABASE_PROJECT_ID"]).toBe("local-project");
      expect(spans[0]?.attributes.get("file.count")).toBe(1);
    }),
  );

  describe("when no project was found (projectEnv is null)", () => {
    // A missing config.toml must not skip dotenv loading; these cover the fallback
    // that derives `<workdir>/supabase` directly.

    it.effect("still reads a supabase/-dir dotenv file directly under workdir", () =>
      Effect.gen(function* () {
        const { fs, path, root, supabaseDir } = yield* project;
        yield* fs.writeFileString(
          path.join(supabaseDir, ".env"),
          "SUPABASE_PROJECT_ID=fallback-project\n",
        );
        const merged = yield* resolveProjectEnvironmentValues(null, root);
        expect(merged["SUPABASE_PROJECT_ID"]).toBe("fallback-project");
      }).pipe((body) => withEnvVar("SUPABASE_PROJECT_ID", undefined, body)),
    );

    it.effect("still reads a project-root dotenv file directly under workdir", () =>
      Effect.gen(function* () {
        const { fs, path, root } = yield* project;
        yield* fs.writeFileString(
          path.join(root, ".env"),
          "SUPABASE_PROJECT_ID=root-fallback-project\n",
        );
        const merged = yield* resolveProjectEnvironmentValues(null, root);
        expect(merged["SUPABASE_PROJECT_ID"]).toBe("root-fallback-project");
      }).pipe((body) => withEnvVar("SUPABASE_PROJECT_ID", undefined, body)),
    );

    it.effect(
      "prefers the supabase/-dir file over the project-root file, same as the non-null case",
      () =>
        Effect.gen(function* () {
          const { fs, path, root, supabaseDir } = yield* project;
          yield* fs.writeFileString(
            path.join(supabaseDir, ".env"),
            "SUPABASE_PROJECT_ID=supabase-dir-project\n",
          );
          yield* fs.writeFileString(
            path.join(root, ".env"),
            "SUPABASE_PROJECT_ID=root-dir-project\n",
          );
          const merged = yield* resolveProjectEnvironmentValues(null, root);
          expect(merged["SUPABASE_PROJECT_ID"]).toBe("supabase-dir-project");
        }).pipe((body) => withEnvVar("SUPABASE_PROJECT_ID", undefined, body)),
    );

    it.effect("lets an ambient shell var win over a dotenv value, using process.env directly", () =>
      Effect.gen(function* () {
        const { fs, path, root, supabaseDir } = yield* project;
        yield* fs.writeFileString(
          path.join(supabaseDir, ".env"),
          "SUPABASE_PROJECT_ID=dotenv-fallback-project\n",
        );
        const merged = yield* resolveProjectEnvironmentValues(null, root);
        expect(merged["SUPABASE_PROJECT_ID"]).toBe("ambient-fallback-project");
      }).pipe((body) => withEnvVar("SUPABASE_PROJECT_ID", "ambient-fallback-project", body)),
    );

    it.effect("returns an empty object when workdir has no dotenv files and no ambient value", () =>
      Effect.gen(function* () {
        const { root } = yield* project;
        const merged = yield* resolveProjectEnvironmentValues(null, root);
        expect(merged["SUPABASE_PROJECT_ID"]).toBeUndefined();
      }).pipe((body) => withEnvVar("SUPABASE_PROJECT_ID", undefined, body)),
    );
  });
});
