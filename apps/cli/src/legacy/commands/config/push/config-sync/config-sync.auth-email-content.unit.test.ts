/** Unit tests for config-sync.auth-email-content.ts. */

import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Scope } from "effect";

import {
  LegacyAuthEmailContentError,
  loadAuthEmailContent,
} from "./config-sync.auth-email-content.ts";

const emptyEmail = {
  enable_signup: true,
  double_confirm_changes: true,
  enable_confirmations: false,
  secure_password_change: false,
  max_frequency: "1s",
  otp_length: 6,
  otp_expiry: 3600,
  template: {},
  notification: {},
};

type Fixture = {
  readonly cwd: string;
  readonly supabaseDir: string;
  readonly path: Path.Path;
  readonly makeDirectory: (directory: string) => Effect.Effect<void, LegacyAuthEmailContentError>;
  readonly writeFileString: (
    file: string,
    content: string,
  ) => Effect.Effect<void, LegacyAuthEmailContentError>;
};

const setup: Effect.Effect<
  Fixture,
  LegacyAuthEmailContentError,
  FileSystem.FileSystem | Path.Path | Scope.Scope
> = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "auth-email-content-" });
  const supabaseDir = path.join(cwd, "supabase");
  yield* fileSystem.makeDirectory(supabaseDir, { recursive: true });
  const mapError = (cause: { readonly message: string }) =>
    new LegacyAuthEmailContentError({ message: cause.message });
  const fixture: Fixture = {
    cwd,
    supabaseDir,
    path,
    makeDirectory: (directory: string) =>
      fileSystem.makeDirectory(directory, { recursive: true }).pipe(Effect.mapError(mapError)),
    writeFileString: (file: string, content: string) =>
      fileSystem.writeFileString(file, content).pipe(Effect.mapError(mapError)),
  };
  return fixture;
}).pipe(Effect.mapError((cause) => new LegacyAuthEmailContentError({ message: cause.message })));

const withSetup = (
  f: (
    fixture: Effect.Success<typeof setup>,
  ) => Effect.Effect<unknown, LegacyAuthEmailContentError, FileSystem.FileSystem | Path.Path>,
): Effect.Effect<
  unknown,
  LegacyAuthEmailContentError,
  FileSystem.FileSystem | Path.Path | Scope.Scope
> => {
  const program: Effect.Effect<
    unknown,
    LegacyAuthEmailContentError,
    FileSystem.FileSystem | Path.Path | Scope.Scope
  > = Effect.gen(function* () {
    const fixture = yield* setup;
    return yield* f(fixture);
  });
  return program;
};

const fileSystemLayer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

describe("loadAuthEmailContent", () => {
  it.effect("loads templates and notifications from the same project-root base", () =>
    withSetup(({ cwd, supabaseDir, makeDirectory, writeFileString, path }) =>
      Effect.gen(function* () {
        const templateDir = path.join(supabaseDir, "templates");
        yield* makeDirectory(templateDir);
        yield* writeFileString(path.join(templateDir, "invite.html"), "<h1>Invite</h1>");
        yield* writeFileString(path.join(templateDir, "password_changed.html"), "<p>Changed</p>");
        const content = yield* loadAuthEmailContent(cwd, {
          ...emptyEmail,
          template: {
            invite: {
              subject: "You are invited",
              content_path: "./supabase/templates/invite.html",
            },
          },
          notification: {
            password_changed: {
              enabled: true,
              subject: "Password changed",
              content_path: "./supabase/templates/password_changed.html",
            },
          },
        });
        expect(content.template["invite"]).toBe("<h1>Invite</h1>");
        expect(content.notification["password_changed"]).toBe("<p>Changed</p>");
      }),
    ).pipe(Effect.provide(fileSystemLayer)),
  );

  it.effect("falls back to the legacy supabase-relative notification path", () =>
    withSetup(({ cwd, supabaseDir, makeDirectory, writeFileString, path }) =>
      Effect.gen(function* () {
        const templateDir = path.join(supabaseDir, "templates");
        yield* makeDirectory(templateDir);
        yield* writeFileString(
          path.join(templateDir, "password_changed.html"),
          "<p>Legacy location</p>",
        );
        const content = yield* loadAuthEmailContent(cwd, {
          ...emptyEmail,
          notification: {
            password_changed: {
              enabled: true,
              subject: "Password changed",
              content_path: "./templates/password_changed.html",
            },
          },
        });
        expect(content.notification["password_changed"]).toBe("<p>Legacy location</p>");
      }),
    ).pipe(Effect.provide(fileSystemLayer)),
  );

  it.effect(
    "reports the canonical project-root path when both notification paths are missing",
    () =>
      withSetup(({ cwd, path }) =>
        Effect.gen(function* () {
          const result = yield* loadAuthEmailContent(cwd, {
            ...emptyEmail,
            notification: {
              password_changed: {
                enabled: true,
                subject: "Password changed",
                content_path: "./templates/missing.html",
              },
            },
          }).pipe(Effect.catchTag("LegacyAuthEmailContentError", (error) => Effect.succeed(error)));

          expect(result).toBeInstanceOf(LegacyAuthEmailContentError);
          if (result instanceof LegacyAuthEmailContentError) {
            expect(result.message).toContain(
              `Invalid config for auth.email.notification.password_changed.content_path:`,
            );
            expect(result.message).toContain(path.join(cwd, "templates", "missing.html"));
            expect(result.message).not.toContain(
              path.join(cwd, "supabase", "templates", "missing.html"),
            );
          }
        }),
      ).pipe(Effect.provide(fileSystemLayer)),
  );

  it.effect("falls back when the root-resolved path is a directory, not a file", () =>
    withSetup(({ cwd, supabaseDir, makeDirectory, writeFileString, path }) =>
      Effect.gen(function* () {
        yield* makeDirectory(path.join(cwd, "templates", "n.html"));
        yield* makeDirectory(path.join(supabaseDir, "templates"));
        yield* writeFileString(path.join(supabaseDir, "templates", "n.html"), "<p>Legacy file</p>");
        const content = yield* loadAuthEmailContent(cwd, {
          ...emptyEmail,
          notification: {
            password_changed: { enabled: true, subject: "s", content_path: "./templates/n.html" },
          },
        });
        expect(content.notification["password_changed"]).toBe("<p>Legacy file</p>");
      }),
    ).pipe(Effect.provide(fileSystemLayer)),
  );

  it.effect("prefers the project-root notification path over the legacy fallback", () =>
    withSetup(({ cwd, supabaseDir, makeDirectory, writeFileString, path }) =>
      Effect.gen(function* () {
        yield* makeDirectory(path.join(cwd, "templates"));
        yield* makeDirectory(path.join(supabaseDir, "templates"));
        yield* writeFileString(path.join(cwd, "templates", "n.html"), "<p>Root</p>");
        yield* writeFileString(path.join(supabaseDir, "templates", "n.html"), "<p>Legacy</p>");
        const content = yield* loadAuthEmailContent(cwd, {
          ...emptyEmail,
          notification: {
            password_changed: { enabled: true, subject: "s", content_path: "./templates/n.html" },
          },
        });
        expect(content.notification["password_changed"]).toBe("<p>Root</p>");
      }),
    ).pipe(Effect.provide(fileSystemLayer)),
  );

  it.effect("skips notification templates when disabled", () =>
    withSetup(({ cwd }) =>
      Effect.gen(function* () {
        const content = yield* loadAuthEmailContent(cwd, {
          ...emptyEmail,
          notification: {
            password_changed: {
              enabled: false,
              subject: "Password changed",
              content_path: "./password_changed.html",
            },
          },
        });
        expect(content.notification).toEqual({});
      }),
    ).pipe(Effect.provide(fileSystemLayer)),
  );

  it.effect("skips entries with an empty content_path", () =>
    withSetup(({ cwd }) =>
      Effect.gen(function* () {
        const content = yield* loadAuthEmailContent(cwd, {
          ...emptyEmail,
          template: { invite: { subject: "You are invited", content_path: "" } },
        });
        expect(content.template).toEqual({});
        expect(content.notification).toEqual({});
      }),
    ).pipe(Effect.provide(fileSystemLayer)),
  );

  it.effect("fails with a Go-shaped error when a template file is missing", () =>
    withSetup(({ cwd }) =>
      Effect.gen(function* () {
        const result = yield* loadAuthEmailContent(cwd, {
          ...emptyEmail,
          template: {
            invite: { subject: "You are invited", content_path: "./templates/missing.html" },
          },
        }).pipe(Effect.catchTag("LegacyAuthEmailContentError", (error) => Effect.succeed(error)));
        expect(result).toMatchObject({
          message: expect.stringMatching(
            /^Invalid config for auth\.email\.template\.invite\.content_path:/,
          ),
        });
      }),
    ).pipe(Effect.provide(fileSystemLayer)),
  );
});
