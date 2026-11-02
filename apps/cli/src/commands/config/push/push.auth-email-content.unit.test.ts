import { BunServices } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { loadAuthEmailContent } from "./push.auth-email-content.ts";

/**
 * Builds the anchored containment-rejection regex for a given declared `content_path` — the
 * thrown message echoes that declared value (quoted), not the fully-canonicalized target,
 * avoiding a recon leak.
 */
function containmentRejectionPattern(fieldPath: string, declaredContentPath: string): RegExp {
  const escaped = declaredContentPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^Invalid config for ${fieldPath}: "${escaped}" resolves outside the project root`,
  );
}

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

const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "auth-email-content-" });
  const supabaseDir = path.join(cwd, "supabase");
  yield* fs.makeDirectory(supabaseDir, { recursive: true });
  return { cwd, supabaseDir };
});

/**
 * Writes a real file outside `cwd`, in a sibling tmpdir, so a containment
 * test proves the escape check fires rather than a missing-file error.
 */
const setupOutsideFile = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const outsideDir = yield* fs.makeTempDirectoryScoped({
    prefix: "auth-email-content-outside-",
  });
  const outsideFile = path.join(outsideDir, "secret.html");
  yield* fs.writeFileString(outsideFile, "<p>Outside</p>");
  return outsideFile;
});

layer(BunServices.layer)("loadAuthEmailContent", (it) => {
  it.effect("loads templates and notifications from the same project-root base", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { cwd, supabaseDir } = yield* setup;
      const templateDir = path.join(supabaseDir, "templates");
      yield* fs.makeDirectory(templateDir, { recursive: true });
      yield* fs.writeFileString(path.join(templateDir, "invite.html"), "<h1>Invite</h1>");
      yield* fs.writeFileString(path.join(templateDir, "password_changed.html"), "<p>Changed</p>");

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
  );

  it.effect("keeps a leading byte order mark in the loaded HTML", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { cwd } = yield* setup;
      yield* fs.writeFileString(path.join(cwd, "invite.html"), "\uFEFF<h1>Invite</h1>");

      const content = yield* loadAuthEmailContent(cwd, {
        ...emptyEmail,
        template: { invite: { subject: "s", content_path: "./invite.html" } },
      });

      expect(content.template["invite"]).toBe("\uFEFF<h1>Invite</h1>");
    }),
  );

  it.effect("falls back to the legacy supabase-relative notification path", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { cwd, supabaseDir } = yield* setup;
      const templateDir = path.join(supabaseDir, "templates");
      yield* fs.makeDirectory(templateDir, { recursive: true });
      yield* fs.writeFileString(
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
  );

  it.effect("falls back when the root-resolved path is a directory, not a file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { cwd, supabaseDir } = yield* setup;
      yield* fs.makeDirectory(path.join(cwd, "templates", "n.html"), { recursive: true });
      yield* fs.makeDirectory(path.join(supabaseDir, "templates"), { recursive: true });
      yield* fs.writeFileString(
        path.join(supabaseDir, "templates", "n.html"),
        "<p>Legacy file</p>",
      );

      const content = yield* loadAuthEmailContent(cwd, {
        ...emptyEmail,
        notification: {
          password_changed: {
            enabled: true,
            subject: "s",
            content_path: "./templates/n.html",
          },
        },
      });

      expect(content.notification["password_changed"]).toBe("<p>Legacy file</p>");
    }),
  );

  it.effect("prefers the project-root notification path over the legacy fallback", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { cwd, supabaseDir } = yield* setup;
      yield* fs.makeDirectory(path.join(cwd, "templates"), { recursive: true });
      yield* fs.makeDirectory(path.join(supabaseDir, "templates"), { recursive: true });
      yield* fs.writeFileString(path.join(cwd, "templates", "n.html"), "<p>Root</p>");
      yield* fs.writeFileString(path.join(supabaseDir, "templates", "n.html"), "<p>Legacy</p>");

      const content = yield* loadAuthEmailContent(cwd, {
        ...emptyEmail,
        notification: {
          password_changed: {
            enabled: true,
            subject: "s",
            content_path: "./templates/n.html",
          },
        },
      });

      expect(content.notification["password_changed"]).toBe("<p>Root</p>");
    }),
  );

  it.effect("skips notification templates when disabled", () =>
    Effect.gen(function* () {
      const { cwd } = yield* setup;

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
  );

  it.effect("skips entries with an empty content_path", () =>
    Effect.gen(function* () {
      const { cwd } = yield* setup;

      const content = yield* loadAuthEmailContent(cwd, {
        ...emptyEmail,
        template: {
          invite: {
            subject: "You are invited",
            content_path: "",
          },
        },
      });

      expect(content.template).toEqual({});
      expect(content.notification).toEqual({});
    }),
  );

  it.effect("fails with a descriptive error when a template file is missing", () =>
    Effect.gen(function* () {
      const { cwd } = yield* setup;

      const error = yield* Effect.flip(
        loadAuthEmailContent(cwd, {
          ...emptyEmail,
          template: {
            invite: {
              subject: "You are invited",
              content_path: "./templates/missing.html",
            },
          },
        }),
      );

      // A genuinely missing in-root file must surface the normal read-failure message, never the
      // containment message, guarding against over-rejecting a missing file as "outside the
      // project root".
      expect(error.message).not.toMatch(/resolves outside the project root/);
      expect(error.message).toMatch(
        /^Invalid config for auth\.email\.template\.invite\.content_path: ENOENT: no such file or directory, open '.*missing\.html'$/,
      );
    }),
  );

  it.effect("reports a NUL byte in content_path with the runtime's own argument error", () =>
    Effect.gen(function* () {
      const { cwd } = yield* setup;

      const error = yield* Effect.flip(
        loadAuthEmailContent(cwd, {
          ...emptyEmail,
          template: { invite: { subject: "s", content_path: "./bad\u0000.html" } },
        }),
      );

      expect(error.message).toMatch(
        /^Invalid config for auth\.email\.template\.invite\.content_path: The argument 'path' must be a string, Uint8Array, or URL without null bytes\./,
      );
    }),
  );

  it.effect(
    "does not raise the containment error for a template file missing behind a symlinked project root",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // The project root itself is reached through a symlink (mirroring macOS's /tmp ->
        // /private/tmp), and the configured template file doesn't exist.
        const realDir = yield* fs.makeTempDirectoryScoped({ prefix: "auth-email-content-real-" });
        const linkContainer = yield* fs.makeTempDirectoryScoped({
          prefix: "auth-email-content-link-",
        });
        const symlinkedRoot = path.join(linkContainer, "project-root");
        yield* fs.symlink(realDir, symlinkedRoot);

        const error = yield* Effect.flip(
          loadAuthEmailContent(symlinkedRoot, {
            ...emptyEmail,
            template: {
              invite: {
                subject: "You are invited",
                content_path: "./missing-invite.html",
              },
            },
          }),
        );

        expect(error.message).not.toMatch(/resolves outside the project root/);
        expect(error.message).toMatch(
          /^Invalid config for auth\.email\.template\.invite\.content_path:/,
        );
      }),
  );

  it.effect("rejects an absolute template content_path outside the project root", () =>
    Effect.gen(function* () {
      const { cwd } = yield* setup;
      const outsideFile = yield* setupOutsideFile;

      const error = yield* Effect.flip(
        loadAuthEmailContent(cwd, {
          ...emptyEmail,
          template: {
            invite: {
              subject: "You are invited",
              content_path: outsideFile,
            },
          },
        }),
      );

      expect(error.message).toMatch(
        containmentRejectionPattern("auth.email.template.invite.content_path", outsideFile),
      );
    }),
  );

  it.effect("rejects an absolute notification content_path outside the project root", () =>
    Effect.gen(function* () {
      const { cwd } = yield* setup;
      const outsideFile = yield* setupOutsideFile;

      const error = yield* Effect.flip(
        loadAuthEmailContent(cwd, {
          ...emptyEmail,
          notification: {
            password_changed: {
              enabled: true,
              subject: "Password changed",
              content_path: outsideFile,
            },
          },
        }),
      );

      expect(error.message).toMatch(
        containmentRejectionPattern(
          "auth.email.notification.password_changed.content_path",
          outsideFile,
        ),
      );
    }),
  );

  it.effect("rejects a relative template content_path that escapes the project root via ..", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { cwd } = yield* setup;
      const outsideFile = yield* setupOutsideFile;
      const escapePath = path.relative(cwd, outsideFile);

      const error = yield* Effect.flip(
        loadAuthEmailContent(cwd, {
          ...emptyEmail,
          template: {
            invite: {
              subject: "You are invited",
              content_path: escapePath,
            },
          },
        }),
      );

      expect(error.message).toMatch(
        containmentRejectionPattern("auth.email.template.invite.content_path", escapePath),
      );
    }),
  );

  it.effect(
    "rejects a relative notification content_path that escapes the project root via ..",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const { cwd } = yield* setup;
        const outsideFile = yield* setupOutsideFile;
        const escapePath = path.relative(cwd, outsideFile);

        const error = yield* Effect.flip(
          loadAuthEmailContent(cwd, {
            ...emptyEmail,
            notification: {
              password_changed: {
                enabled: true,
                subject: "Password changed",
                content_path: escapePath,
              },
            },
          }),
        );

        expect(error.message).toMatch(
          containmentRejectionPattern(
            "auth.email.notification.password_changed.content_path",
            escapePath,
          ),
        );
      }),
  );

  it.effect("rejects a template content_path that is an in-root symlink to an outside file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { cwd } = yield* setup;
      const outsideFile = yield* setupOutsideFile;
      yield* fs.symlink(outsideFile, path.join(cwd, "evil-template.html"));

      const error = yield* Effect.flip(
        loadAuthEmailContent(cwd, {
          ...emptyEmail,
          template: {
            invite: {
              subject: "You are invited",
              content_path: "./evil-template.html",
            },
          },
        }),
      );

      expect(error.message).toMatch(
        containmentRejectionPattern(
          "auth.email.template.invite.content_path",
          "./evil-template.html",
        ),
      );
    }),
  );

  it.effect(
    "rejects a notification content_path that is an in-root symlink to an outside file",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { cwd } = yield* setup;
        const outsideFile = yield* setupOutsideFile;
        yield* fs.symlink(outsideFile, path.join(cwd, "evil-notification.html"));

        const error = yield* Effect.flip(
          loadAuthEmailContent(cwd, {
            ...emptyEmail,
            notification: {
              password_changed: {
                enabled: true,
                subject: "Password changed",
                content_path: "./evil-notification.html",
              },
            },
          }),
        );

        expect(error.message).toMatch(
          containmentRejectionPattern(
            "auth.email.notification.password_changed.content_path",
            "./evil-notification.html",
          ),
        );
      }),
  );

  it.effect(
    "does not raise the containment error for a template content_path resolving to exactly the project root",
    () =>
      Effect.gen(function* () {
        const { cwd } = yield* setup;

        const error = yield* Effect.flip(
          loadAuthEmailContent(cwd, {
            ...emptyEmail,
            template: {
              invite: {
                subject: "You are invited",
                content_path: ".",
              },
            },
          }),
        );

        expect(error.message).not.toMatch(/resolves outside the project root/);
        expect(error.message).toMatch(
          /^Invalid config for auth\.email\.template\.invite\.content_path:/,
        );
      }),
  );
});
