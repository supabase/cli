import { BunServices } from "@effect/platform-bun";
import type { ProjectEnvironment } from "@supabase/config";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Option, Path } from "effect";

import {
  LegacyProjectEnvironmentError,
  legacyResolveProjectEnvironmentValues,
} from "./legacy-project-environment.ts";

const EMPTY_ENV: Readonly<Record<string, string>> = {};
type ProjectSource = "ambient" | ".env" | ".env.local";

interface Fixture {
  readonly root: string;
  readonly supabaseDir: string;
  readonly join: (...parts: ReadonlyArray<string>) => string;
  readonly write: (
    filePath: string,
    contents: string,
  ) => Effect.Effect<void, LegacyProjectEnvironmentError>;
  readonly project: (
    values?: Record<string, string>,
    sources?: Record<string, ProjectSource>,
  ) => ProjectEnvironment;
}

type FixtureUse<A> = (
  fixture: Fixture,
) => Effect.Effect<A, LegacyProjectEnvironmentError, FileSystem.FileSystem | Path.Path>;

const withFixture = <A>(use: FixtureUse<A>): Effect.Effect<A, LegacyProjectEnvironmentError> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectory({ prefix: "supabase-legacy-project-env-" }).pipe(
      Effect.mapError(
        (cause) =>
          new LegacyProjectEnvironmentError({
            message: "failed to create project environment fixture",
            cause,
          }),
      ),
    );
    const supabaseDir = path.join(root, "supabase");
    yield* fs.makeDirectory(supabaseDir, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new LegacyProjectEnvironmentError({
            message: "failed to create project environment fixture directory",
            cause,
          }),
      ),
    );

    const fixture: Fixture = {
      root,
      supabaseDir,
      join: (...parts) => path.join(...parts),
      write: (filePath, contents) =>
        fs.writeFileString(filePath, contents).pipe(
          Effect.mapError(
            (cause) =>
              new LegacyProjectEnvironmentError({
                message: `failed to write project environment fixture: ${filePath}`,
                cause,
              }),
          ),
        ),
      project: (values = {}, sources = {}) => {
        const resolvedSources: Record<string, ProjectSource> = {};
        for (const key of Object.keys(values)) {
          resolvedSources[key] = sources[key] ?? "ambient";
        }
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
          sources: resolvedSources,
        };
      },
    };

    return yield* Effect.acquireUseRelease(
      Effect.succeed(root),
      () => use(fixture),
      (directory) => fs.remove(directory, { recursive: true, force: true }).pipe(Effect.ignore),
    );
  }).pipe(Effect.provide(BunServices.layer));

describe("legacyResolveProjectEnvironmentValues", () => {
  it.effect("returns just the already-loaded values when no extra dotenv files exist", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const merged = yield* legacyResolveProjectEnvironmentValues(
          fixture.project({ SUPABASE_PROJECT_ID: "from-loader" }),
          fixture.root,
          EMPTY_ENV,
        );
        expect(merged).toEqual({ SUPABASE_PROJECT_ID: "from-loader" });
      }),
    ),
  );

  it.effect("fills in a value from a project-root .env file Go's loadNestedEnv would load", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        yield* fixture.write(
          fixture.join(fixture.root, ".env"),
          "SUPABASE_PROJECT_ID=root-env-project\n",
        );
        const merged = yield* legacyResolveProjectEnvironmentValues(
          fixture.project(),
          fixture.root,
          EMPTY_ENV,
        );
        expect(merged["SUPABASE_PROJECT_ID"]).toBe("root-env-project");
      }),
    ),
  );

  it.effect("prefers a supabase/-dir dotenv file over the same key in a project-root file", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        yield* fixture.write(
          fixture.join(fixture.supabaseDir, ".env"),
          "SUPABASE_PROJECT_ID=supabase-dir-project\n",
        );
        yield* fixture.write(
          fixture.join(fixture.root, ".env"),
          "SUPABASE_PROJECT_ID=root-dir-project\n",
        );
        const merged = yield* legacyResolveProjectEnvironmentValues(
          fixture.project(),
          fixture.root,
          EMPTY_ENV,
        );
        expect(merged["SUPABASE_PROJECT_ID"]).toBe("supabase-dir-project");
      }),
    ),
  );

  it.effect("lets already-resolved projectEnv.values win over anything discovered locally", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        yield* fixture.write(
          fixture.join(fixture.root, ".env"),
          "SUPABASE_PROJECT_ID=root-env-project\n",
        );
        const merged = yield* legacyResolveProjectEnvironmentValues(
          fixture.project({ SUPABASE_PROJECT_ID: "ambient-project" }),
          fixture.root,
          EMPTY_ENV,
        );
        expect(merged["SUPABASE_PROJECT_ID"]).toBe("ambient-project");
      }),
    ),
  );

  it.effect("defaults SUPABASE_ENV to development when unset", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        yield* fixture.write(
          fixture.join(fixture.root, ".env.development"),
          "SUPABASE_PROJECT_ID=dev-project\n",
        );
        const merged = yield* legacyResolveProjectEnvironmentValues(
          fixture.project(),
          fixture.root,
          EMPTY_ENV,
        );
        expect(merged["SUPABASE_PROJECT_ID"]).toBe("dev-project");
      }),
    ),
  );

  it.effect("defaults an explicitly empty SUPABASE_ENV to development", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        yield* fixture.write(
          fixture.join(fixture.root, ".env.development"),
          "SUPABASE_PROJECT_ID=dev-project\n",
        );
        const merged = yield* legacyResolveProjectEnvironmentValues(
          fixture.project(),
          fixture.root,
          { SUPABASE_ENV: "" },
        );
        expect(merged["SUPABASE_PROJECT_ID"]).toBe("dev-project");
      }),
    ),
  );

  it.effect("selects the SUPABASE_ENV-named file over the bare .env file", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const env = { SUPABASE_ENV: "production" };
        yield* fixture.write(
          fixture.join(fixture.root, ".env"),
          "SUPABASE_PROJECT_ID=bare-env-project\n",
        );
        yield* fixture.write(
          fixture.join(fixture.root, ".env.production"),
          "SUPABASE_PROJECT_ID=prod-project\n",
        );
        const merged = yield* legacyResolveProjectEnvironmentValues(
          fixture.project(),
          fixture.root,
          env,
        );
        expect(merged["SUPABASE_PROJECT_ID"]).toBe("prod-project");
      }),
    ),
  );

  it.effect("prefers the .local variant of the SUPABASE_ENV file over the non-local one", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const env = { SUPABASE_ENV: "production" };
        yield* fixture.write(
          fixture.join(fixture.root, ".env.production"),
          "SUPABASE_PROJECT_ID=prod-project\n",
        );
        yield* fixture.write(
          fixture.join(fixture.root, ".env.production.local"),
          "SUPABASE_PROJECT_ID=prod-local-project\n",
        );
        const merged = yield* legacyResolveProjectEnvironmentValues(
          fixture.project(),
          fixture.root,
          env,
        );
        expect(merged["SUPABASE_PROJECT_ID"]).toBe("prod-local-project");
      }),
    ),
  );

  it.effect("skips .env.local when SUPABASE_ENV=test, matching Go's loadDefaultEnv", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const env = { SUPABASE_ENV: "test" };
        yield* fixture.write(
          fixture.join(fixture.root, ".env.local"),
          "SUPABASE_PROJECT_ID=local-project\n",
        );
        yield* fixture.write(
          fixture.join(fixture.root, ".env.test"),
          "SUPABASE_PROJECT_ID=test-project\n",
        );
        const merged = yield* legacyResolveProjectEnvironmentValues(
          fixture.project(),
          fixture.root,
          env,
        );
        expect(merged["SUPABASE_PROJECT_ID"]).toBe("test-project");
      }),
    ),
  );

  it.effect("strips quotes the same way the shared dotenv parser does", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        yield* fixture.write(
          fixture.join(fixture.root, ".env"),
          'SUPABASE_AUTH_JWT_SECRET="a quoted value"\n',
        );
        const merged = yield* legacyResolveProjectEnvironmentValues(
          fixture.project(),
          fixture.root,
          EMPTY_ENV,
        );
        expect(merged["SUPABASE_AUTH_JWT_SECRET"]).toBe("a quoted value");
      }),
    ),
  );

  it.effect("ignores blank lines and comments", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        yield* fixture.write(
          fixture.join(fixture.root, ".env"),
          "\n# a comment\nSUPABASE_PROJECT_ID=commented-project\n",
        );
        const merged = yield* legacyResolveProjectEnvironmentValues(
          fixture.project(),
          fixture.root,
          EMPTY_ENV,
        );
        expect(merged["SUPABASE_PROJECT_ID"]).toBe("commented-project");
      }),
    ),
  );

  it.effect(
    "preserves a literal # in an unquoted value with no leading whitespace, matching godotenv",
    () =>
      withFixture((fixture) =>
        Effect.gen(function* () {
          yield* fixture.write(
            fixture.join(fixture.root, ".env"),
            "SUPABASE_AUTH_JWT_SECRET=long#secret\n",
          );
          const merged = yield* legacyResolveProjectEnvironmentValues(
            fixture.project(),
            fixture.root,
            EMPTY_ENV,
          );
          expect(merged["SUPABASE_AUTH_JWT_SECRET"]).toBe("long#secret");
        }),
      ),
  );

  it.effect("still truncates an unquoted value at a whitespace-preceded inline comment", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        yield* fixture.write(
          fixture.join(fixture.root, ".env"),
          "SUPABASE_PROJECT_ID=54323 # local\n",
        );
        const merged = yield* legacyResolveProjectEnvironmentValues(
          fixture.project(),
          fixture.root,
          EMPTY_ENV,
        );
        expect(merged["SUPABASE_PROJECT_ID"]).toBe("54323");
      }),
    ),
  );

  it.effect("strips a trailing comment after a quoted value", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        yield* fixture.write(
          fixture.join(fixture.root, ".env"),
          'SUPABASE_PROJECT_ID="demo" # local\n',
        );
        const merged = yield* legacyResolveProjectEnvironmentValues(
          fixture.project(),
          fixture.root,
          EMPTY_ENV,
        );
        expect(merged["SUPABASE_PROJECT_ID"]).toBe("demo");
      }),
    ),
  );

  it.effect("accepts a colon-separated assignment", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        yield* fixture.write(
          fixture.join(fixture.root, ".env"),
          "SUPABASE_PROJECT_ID: colon-project\n",
        );
        const merged = yield* legacyResolveProjectEnvironmentValues(
          fixture.project(),
          fixture.root,
          EMPTY_ENV,
        );
        expect(merged["SUPABASE_PROJECT_ID"]).toBe("colon-project");
      }),
    ),
  );

  it.effect(
    "prefers an env-specific file over a same-key value sourced from a bare .env file",
    () =>
      withFixture((fixture) =>
        Effect.gen(function* () {
          const env = { SUPABASE_ENV: "development" };
          yield* fixture.write(
            fixture.join(fixture.supabaseDir, ".env.development.local"),
            "SUPABASE_PROJECT_ID=env-specific-project\n",
          );
          const merged = yield* legacyResolveProjectEnvironmentValues(
            fixture.project(
              { SUPABASE_PROJECT_ID: "bare-dotenv-project" },
              { SUPABASE_PROJECT_ID: ".env" },
            ),
            fixture.root,
            env,
          );
          expect(merged["SUPABASE_PROJECT_ID"]).toBe("env-specific-project");
        }),
      ),
  );

  it.effect("still lets a truly ambient-sourced value win over any file", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const env = { SUPABASE_ENV: "development" };
        yield* fixture.write(
          fixture.join(fixture.supabaseDir, ".env.development.local"),
          "SUPABASE_PROJECT_ID=env-specific-project\n",
        );
        const merged = yield* legacyResolveProjectEnvironmentValues(
          fixture.project(
            { SUPABASE_PROJECT_ID: "ambient-project" },
            { SUPABASE_PROJECT_ID: "ambient" },
          ),
          fixture.root,
          env,
        );
        expect(merged["SUPABASE_PROJECT_ID"]).toBe("ambient-project");
      }),
    ),
  );

  it.effect("fails on a malformed line", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        yield* fixture.write(fixture.join(fixture.root, ".env"), "not a valid line\n");
        const exit = yield* legacyResolveProjectEnvironmentValues(
          fixture.project(),
          fixture.root,
          EMPTY_ENV,
        ).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const error = Exit.findErrorOption(exit);
          expect(Option.isSome(error)).toBe(true);
          if (Option.isSome(error)) {
            expect(error.value.message).toMatch(/failed to parse environment file/);
          }
        }
      }),
    ),
  );

  it.effect("expands an unquoted $VAR reference to an earlier value in the same file", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        yield* fixture.write(
          fixture.join(fixture.root, ".env"),
          "BASE=demo\nSUPABASE_PROJECT_ID=$BASE\n",
        );
        const merged = yield* legacyResolveProjectEnvironmentValues(
          fixture.project(),
          fixture.root,
          EMPTY_ENV,
        );
        expect(merged["SUPABASE_PROJECT_ID"]).toBe("demo");
      }),
    ),
  );

  it.effect("expands a braced ${VAR} reference in a double-quoted value", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        yield* fixture.write(
          fixture.join(fixture.root, ".env"),
          'SECRET=shh\nSUPABASE_AUTH_JWT_SECRET="${SECRET}"\n',
        );
        const merged = yield* legacyResolveProjectEnvironmentValues(
          fixture.project(),
          fixture.root,
          EMPTY_ENV,
        );
        expect(merged["SUPABASE_AUTH_JWT_SECRET"]).toBe("shh");
      }),
    ),
  );

  it.effect("does not expand variable references inside single-quoted values", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        yield* fixture.write(
          fixture.join(fixture.root, ".env"),
          "BASE=demo\nSUPABASE_PROJECT_ID='$BASE'\n",
        );
        const merged = yield* legacyResolveProjectEnvironmentValues(
          fixture.project(),
          fixture.root,
          EMPTY_ENV,
        );
        expect(merged["SUPABASE_PROJECT_ID"]).toBe("$BASE");
      }),
    ),
  );

  it.effect("expands an unresolved bare reference to an empty string", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        yield* fixture.write(fixture.join(fixture.root, ".env"), "SUPABASE_PROJECT_ID=$NOPE\n");
        const merged = yield* legacyResolveProjectEnvironmentValues(
          fixture.project(),
          fixture.root,
          EMPTY_ENV,
        );
        expect(merged["SUPABASE_PROJECT_ID"]).toBe("");
      }),
    ),
  );

  it.effect("expands an unresolved braced reference to an empty string", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        yield* fixture.write(
          fixture.join(fixture.root, ".env"),
          'SUPABASE_AUTH_JWT_SECRET="${NOPE}"\n',
        );
        const merged = yield* legacyResolveProjectEnvironmentValues(
          fixture.project(),
          fixture.root,
          EMPTY_ENV,
        );
        expect(merged["SUPABASE_AUTH_JWT_SECRET"]).toBe("");
      }),
    ),
  );

  it.effect("preserves a backslash-escaped $VAR reference as a literal", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        yield* fixture.write(
          fixture.join(fixture.root, ".env"),
          "BASE=demo\nSUPABASE_PROJECT_ID=demo\\$BASE\n",
        );
        const merged = yield* legacyResolveProjectEnvironmentValues(
          fixture.project(),
          fixture.root,
          EMPTY_ENV,
        );
        expect(merged["SUPABASE_PROJECT_ID"]).toBe("demo$BASE");
      }),
    ),
  );

  it.effect("preserves a backslash-escaped ${VAR} reference in a double-quoted value", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        yield* fixture.write(
          fixture.join(fixture.root, ".env"),
          'BASE=demo\nSUPABASE_PROJECT_ID="demo\\${BASE}"\n',
        );
        const merged = yield* legacyResolveProjectEnvironmentValues(
          fixture.project(),
          fixture.root,
          EMPTY_ENV,
        );
        expect(merged["SUPABASE_PROJECT_ID"]).toBe("demo${BASE}");
      }),
    ),
  );

  it.effect("treats a bare trailing $ with no variable name as a literal", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        yield* fixture.write(fixture.join(fixture.root, ".env"), "SUPABASE_PROJECT_ID=demo$\n");
        const merged = yield* legacyResolveProjectEnvironmentValues(
          fixture.project(),
          fixture.root,
          EMPTY_ENV,
        );
        expect(merged["SUPABASE_PROJECT_ID"]).toBe("demo$");
      }),
    ),
  );

  it.effect("preserves a multiline quoted value alongside an unrelated SUPABASE_* key", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const pem = "-----BEGIN PRIVATE KEY-----\nMIIBogIBAAJ\n-----END PRIVATE KEY-----";
        yield* fixture.write(
          fixture.join(fixture.root, ".env"),
          `PRIVATE_KEY="${pem}"\nSUPABASE_PROJECT_ID=multiline-safe-project\n`,
        );
        const merged = yield* legacyResolveProjectEnvironmentValues(
          fixture.project(),
          fixture.root,
          EMPTY_ENV,
        );
        expect(merged["SUPABASE_PROJECT_ID"]).toBe("multiline-safe-project");
      }),
    ),
  );

  describe("when no project was found (projectEnv is null)", () => {
    it.effect("still reads a supabase/-dir dotenv file directly under workdir", () =>
      withFixture((fixture) =>
        Effect.gen(function* () {
          yield* fixture.write(
            fixture.join(fixture.supabaseDir, ".env"),
            "SUPABASE_PROJECT_ID=fallback-project\n",
          );
          const merged = yield* legacyResolveProjectEnvironmentValues(
            null,
            fixture.root,
            EMPTY_ENV,
          );
          expect(merged["SUPABASE_PROJECT_ID"]).toBe("fallback-project");
        }),
      ),
    );

    it.effect("still reads a project-root dotenv file directly under workdir", () =>
      withFixture((fixture) =>
        Effect.gen(function* () {
          yield* fixture.write(
            fixture.join(fixture.root, ".env"),
            "SUPABASE_PROJECT_ID=root-fallback-project\n",
          );
          const merged = yield* legacyResolveProjectEnvironmentValues(
            null,
            fixture.root,
            EMPTY_ENV,
          );
          expect(merged["SUPABASE_PROJECT_ID"]).toBe("root-fallback-project");
        }),
      ),
    );

    it.effect("prefers the supabase/-dir file over the project-root file", () =>
      withFixture((fixture) =>
        Effect.gen(function* () {
          yield* fixture.write(
            fixture.join(fixture.supabaseDir, ".env"),
            "SUPABASE_PROJECT_ID=supabase-dir-project\n",
          );
          yield* fixture.write(
            fixture.join(fixture.root, ".env"),
            "SUPABASE_PROJECT_ID=root-dir-project\n",
          );
          const merged = yield* legacyResolveProjectEnvironmentValues(
            null,
            fixture.root,
            EMPTY_ENV,
          );
          expect(merged["SUPABASE_PROJECT_ID"]).toBe("supabase-dir-project");
        }),
      ),
    );

    it.effect("lets an ambient shell var win over a dotenv value", () =>
      withFixture((fixture) =>
        Effect.gen(function* () {
          yield* fixture.write(
            fixture.join(fixture.supabaseDir, ".env"),
            "SUPABASE_PROJECT_ID=dotenv-fallback-project\n",
          );
          const merged = yield* legacyResolveProjectEnvironmentValues(null, fixture.root, {
            SUPABASE_PROJECT_ID: "ambient-fallback-project",
          });
          expect(merged["SUPABASE_PROJECT_ID"]).toBe("ambient-fallback-project");
        }),
      ),
    );

    it.effect("returns an empty object when workdir has no dotenv files and no ambient value", () =>
      withFixture((fixture) =>
        Effect.gen(function* () {
          const merged = yield* legacyResolveProjectEnvironmentValues(
            null,
            fixture.root,
            EMPTY_ENV,
          );
          expect(merged["SUPABASE_PROJECT_ID"]).toBeUndefined();
        }),
      ),
    );
  });
});
