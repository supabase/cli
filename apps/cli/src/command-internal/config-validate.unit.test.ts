import { BunServices } from "@effect/platform-bun";
import { describe, expect, it, layer } from "@effect/vitest";
import { Effect, FileSystem, Path, PlatformError, Predicate } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  BUCKET_NAME_PATTERN,
  CLERK_DOMAIN_PATTERN,
  FUNCTION_SLUG_PATTERN,
  HOOK_SECRET_PATTERN,
  PROJECT_REF_PATTERN,
  ConfigValidateError,
  resolveEmailTemplateContentPath,
} from "./config-validate.ts";
import { parseBoolLiteral } from "../shared/config/config-bool.ts";

describe("parseBoolLiteral", () => {
  it("accepts the true forms", () => {
    for (const value of ["1", "t", "T", "TRUE", "true", "True"]) {
      expect(parseBoolLiteral(value)).toBe(true);
    }
  });

  it("accepts the false forms, including the empty string", () => {
    for (const value of ["0", "f", "F", "FALSE", "false", "False", ""]) {
      expect(parseBoolLiteral(value)).toBe(false);
    }
  });

  it("returns undefined for a value outside the accepted set", () => {
    expect(parseBoolLiteral("yes")).toBeUndefined();
    expect(parseBoolLiteral("2")).toBeUndefined();
    expect(parseBoolLiteral("tRuE")).toBeUndefined();
    expect(parseBoolLiteral("tRue")).toBeUndefined();
  });
});

describe("PROJECT_REF_PATTERN", () => {
  it("matches a valid 20-character lowercase project ref", () => {
    expect(PROJECT_REF_PATTERN.test("abcdefghijklmnopqrst")).toBe(true);
  });

  it("rejects refs of the wrong length or case", () => {
    expect(PROJECT_REF_PATTERN.test("short")).toBe(false);
    expect(PROJECT_REF_PATTERN.test("ABCDEFGHIJKLMNOPQRST")).toBe(false);
  });
});

describe("BUCKET_NAME_PATTERN", () => {
  it("matches legal bucket name characters", () => {
    expect(BUCKET_NAME_PATTERN.test("my-bucket.1")).toBe(true);
  });

  it("rejects characters outside the bucket name pattern", () => {
    expect(BUCKET_NAME_PATTERN.test("bad#name")).toBe(false);
    expect(BUCKET_NAME_PATTERN.test("bad/name")).toBe(false);
  });
});

describe("FUNCTION_SLUG_PATTERN", () => {
  it("matches a valid function slug (letters, digits, _ and -)", () => {
    expect(FUNCTION_SLUG_PATTERN.test("my-function")).toBe(true);
    expect(FUNCTION_SLUG_PATTERN.test("function_1")).toBe(true);
  });

  it("rejects a slug that doesn't start with a letter", () => {
    expect(FUNCTION_SLUG_PATTERN.test("123")).toBe(false);
    expect(FUNCTION_SLUG_PATTERN.test("1bad")).toBe(false);
  });
});

describe("HOOK_SECRET_PATTERN", () => {
  it("matches a valid v1,whsec_ secret", () => {
    expect(HOOK_SECRET_PATTERN.test(`v1,whsec_${"a".repeat(32)}`)).toBe(true);
  });

  it("rejects a secret that doesn't match the hook secret pattern", () => {
    expect(HOOK_SECRET_PATTERN.test("not-a-valid-secret")).toBe(false);
  });
});

describe("CLERK_DOMAIN_PATTERN", () => {
  it("matches a valid clerk.example.com domain", () => {
    expect(CLERK_DOMAIN_PATTERN.test("clerk.example.com")).toBe(true);
  });

  it("matches a valid <slug>.clerk.accounts.dev domain", () => {
    expect(CLERK_DOMAIN_PATTERN.test("example.clerk.accounts.dev")).toBe(true);
  });

  it("rejects a domain that doesn't match the clerk domain pattern", () => {
    expect(CLERK_DOMAIN_PATTERN.test("not-a-clerk-domain")).toBe(false);
  });
});

// Direct coverage for the containment check shared by every caller (config push's
// loadAuthEmailContent, db-config.read.ts, local-config-values.ts, start.handler.ts's
// pre-Docker pass), cheaper to pin here than to re-derive through every caller's own fixtures.
layer(BunServices.layer)("resolveEmailTemplateContentPath", (it) => {
  const tempDir = (prefix: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* fs.makeTempDirectoryScoped({ prefix });
    });

  const setup = () => tempDir("config-validate-email-content-");

  /** A real file outside `base`, so a containment test proves the escape check fires rather than a missing-file error. */
  const setupOutsideFile = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const outsideDir = yield* tempDir("config-validate-email-content-outside-");
    const outsideFile = path.join(outsideDir, "secret.html");
    yield* fs.writeFileString(outsideFile, "<p>Outside</p>");
    return outsideFile;
  });

  /** Whether `chmod 000` actually blocks reading `dir` here (it doesn't when running as root). */
  const permissionEnforced = (dir: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return !(yield* fs.readDirectory(dir).pipe(Effect.isSuccess));
    });

  function resolveContentPath(
    section: "template" | "notification",
    contentPath: string,
    base: string,
  ) {
    return resolveEmailTemplateContentPath({
      section,
      name: "invite",
      contentPath,
      contentPresent: false,
      base,
    });
  }

  it.effect.each(["template", "notification"] as const)(
    "rejects an absolute %s content_path outside the project root",
    (section) =>
      Effect.gen(function* () {
        const base = yield* setup();
        const outsideFile = yield* setupOutsideFile;

        expect(yield* Effect.flip(resolveContentPath(section, outsideFile, base))).toBeInstanceOf(
          ConfigValidateError,
        );
        expect(
          (yield* Effect.flip(resolveContentPath(section, outsideFile, base))).message,
        ).toMatch(/resolves outside the project root/);
      }),
  );

  it.effect.each(["template", "notification"] as const)(
    "rejects a relative %s content_path that escapes the project root via ..",
    (section) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const base = yield* setup();
        const outsideFile = yield* setupOutsideFile;
        const escapePath = path.relative(base, outsideFile);

        expect((yield* Effect.flip(resolveContentPath(section, escapePath, base))).message).toMatch(
          /resolves outside the project root/,
        );
      }),
  );

  it.effect.each(["template", "notification"] as const)(
    "rejects a %s content_path that is an in-root symlink pointing outside the project root",
    (section) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const base = yield* setup();
        const outsideFile = yield* setupOutsideFile;
        const symlinkPath = path.join(base, "evil.html");
        yield* fs.symlink(outsideFile, symlinkPath);

        expect(
          (yield* Effect.flip(resolveContentPath(section, "./evil.html", base))).message,
        ).toMatch(/resolves outside the project root/);
      }),
  );

  it.effect(
    "accepts an in-root sibling path whose name literally starts with two dots, distinct from a .. escape",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const base = yield* setup();
        const dotDir = path.join(base, "..templates");
        yield* fs.makeDirectory(dotDir, { recursive: true });
        yield* fs.writeFileString(path.join(dotDir, "invite.html"), "<h1>Invite</h1>");

        const resolved = yield* resolveContentPath("template", "..templates/invite.html", base);

        expect(resolved).toBe(path.join(yield* fs.realPath(base), "..templates", "invite.html"));
      }),
  );

  it.effect("accepts a content_path that resolves to exactly the project root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const base = yield* setup();

      const resolved = yield* resolveContentPath("template", ".", base);

      expect(resolved).toBe(yield* fs.realPath(base));
    }),
  );

  it.effect(
    "resolves a missing in-root file behind a symlinked project root instead of raising the containment error",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const realDir = yield* tempDir("config-validate-email-content-real-");
        const linkContainer = yield* tempDir("config-validate-email-content-link-");
        const symlinkedRoot = path.join(linkContainer, "project-root");
        yield* fs.symlink(realDir, symlinkedRoot);

        const resolved = yield* resolveContentPath(
          "template",
          "missing-invite.html",
          symlinkedRoot,
        );
        expect(resolved).toBe(path.join(yield* fs.realPath(symlinkedRoot), "missing-invite.html"));
      }),
  );

  it.effect.each(["template", "notification"] as const)(
    "rejects a %s content_path that is an in-root dangling symlink pointing to a nonexistent target outside the project root",
    (section) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const base = yield* setup();
        const outsideDir = yield* tempDir("config-validate-email-content-outside-");
        const neverCreatedOutsideTarget = path.join(outsideDir, "never-created.html");
        const danglingSymlinkPath = path.join(base, "dangling.html");
        yield* fs.symlink(neverCreatedOutsideTarget, danglingSymlinkPath);

        expect(
          yield* Effect.flip(resolveContentPath(section, "./dangling.html", base)),
        ).toBeInstanceOf(ConfigValidateError);
        expect(
          (yield* Effect.flip(resolveContentPath(section, "./dangling.html", base))).message,
        ).toMatch(/resolves outside the project root/);
      }),
  );

  it.effect.each(["template", "notification"] as const)(
    "rejects a %s content_path that is an in-root dangling symlink whose own mode denies reading it",
    (section) =>
      Effect.gen(function* () {
        /* Skipped where symlink modes can't be set or aren't enforced (Linux, root). */
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const base = yield* setup();
        const outsideDir = yield* tempDir("config-validate-email-content-outside-");
        const lockedSymlinkPath = path.join(base, "locked.html");
        yield* fs.symlink(path.join(outsideDir, "never-created.html"), lockedSymlinkPath);
        const locked = yield* spawner
          .exitCode(ChildProcess.make("chmod", ["-h", "000", lockedSymlinkPath]))
          .pipe(
            Effect.map((exitCode) => exitCode === 0),
            Effect.orElseSucceed(() => false),
          );
        if (!locked || (yield* fs.readLink(lockedSymlinkPath).pipe(Effect.isSuccess))) {
          return;
        }

        const failure = yield* Effect.flip(resolveContentPath(section, "./locked.html", base));
        expect(
          failure instanceof PlatformError.PlatformError &&
            Predicate.isTagged(failure.reason, "PermissionDenied"),
        ).toBe(true);
      }),
  );

  /* Linux ignores a symlink's own mode, so a `readLink` denied by the symlink itself is driven
     through a `FileSystem` that denies it, with the parent `stat` passing or failing. */
  const denyingReadLink = (lockedPath: string, parentSearchable: boolean) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parentProbe = `${path.dirname(lockedPath)}${path.sep}.`;
      const parentInfo = yield* fs.stat(parentProbe);
      const denied = (method: string, pathOrDescriptor: string) =>
        PlatformError.systemError({
          _tag: "PermissionDenied",
          module: "FileSystem",
          method,
          pathOrDescriptor,
        });
      return FileSystem.FileSystem.of({
        ...fs,
        readLink: (p) => (p === lockedPath ? Effect.fail(denied("readLink", p)) : fs.readLink(p)),
        stat: (p) =>
          p !== parentProbe
            ? fs.stat(p)
            : parentSearchable
              ? Effect.succeed(parentInfo)
              : Effect.fail(denied("stat", p)),
      });
    });

  it.effect("rejects a content_path whose own readLink is denied under a searchable parent", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const base = yield* setup();
      const lockedFs = yield* denyingReadLink(path.join(base, "locked.html"), true);

      const failure = yield* Effect.flip(
        resolveContentPath("template", "./locked.html", base).pipe(
          Effect.provideService(FileSystem.FileSystem, lockedFs),
        ),
      );
      expect(
        failure instanceof PlatformError.PlatformError &&
          Predicate.isTagged(failure.reason, "PermissionDenied"),
      ).toBe(true);
    }),
  );

  it.effect("accepts a content_path whose readLink is denied by an unsearchable parent", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const base = yield* setup();
      const lockedFs = yield* denyingReadLink(path.join(base, "locked.html"), false);

      const resolved = yield* resolveContentPath("template", "./locked.html", base).pipe(
        Effect.provideService(FileSystem.FileSystem, lockedFs),
      );
      expect(resolved).toBe(path.join(yield* fs.realPath(base), "locked.html"));
    }),
  );

  it.effect.each(["template", "notification"] as const)(
    "rejects a %s content_path that is an in-root symlink whose outside target sits behind an unsearchable (EACCES) directory",
    (section) =>
      Effect.gen(function* () {
        // Skipped when this environment doesn't enforce chmod 000 (e.g. running as root); the
        // dangling-symlink case above already covers the core regression without a permission trick.
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const base = yield* setup();
        const outsideDir = yield* tempDir("config-validate-email-content-outside-");
        const unsearchableDir = path.join(outsideDir, "locked");
        yield* fs.makeDirectory(unsearchableDir);
        const target = path.join(unsearchableDir, "secret.html");
        yield* fs.writeFileString(target, "<p>Locked</p>");
        yield* fs.chmod(unsearchableDir, 0o000);

        yield* Effect.gen(function* () {
          if (!(yield* permissionEnforced(unsearchableDir))) {
            return;
          }

          const symlinkPath = path.join(base, "unsearchable.html");
          yield* fs.symlink(target, symlinkPath);

          expect(
            yield* Effect.flip(resolveContentPath(section, "./unsearchable.html", base)),
          ).toBeInstanceOf(ConfigValidateError);
          expect(
            (yield* Effect.flip(resolveContentPath(section, "./unsearchable.html", base))).message,
          ).toMatch(/resolves outside the project root/);
        }).pipe(Effect.ensuring(fs.chmod(unsearchableDir, 0o755).pipe(Effect.orDie)));
      }),
  );

  it.effect(
    "accepts a genuinely in-root file behind an unsearchable (EACCES) directory, even when the project root itself is reached through a symlink",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const realDir = yield* tempDir("config-validate-email-content-real-");
        const linkContainer = yield* tempDir("config-validate-email-content-link-");
        const symlinkedRoot = path.join(linkContainer, "project-root");
        yield* fs.symlink(realDir, symlinkedRoot);
        const lockedDir = path.join(realDir, "locked");
        yield* fs.makeDirectory(lockedDir);
        const target = path.join(lockedDir, "invite.html");
        yield* fs.writeFileString(target, "<h1>Invite</h1>");
        yield* fs.chmod(lockedDir, 0o000);

        yield* Effect.gen(function* () {
          if (!(yield* permissionEnforced(lockedDir))) {
            return;
          }

          const resolved = yield* resolveContentPath(
            "template",
            "./locked/invite.html",
            symlinkedRoot,
          );

          expect(resolved).toBe(
            path.join(yield* fs.realPath(symlinkedRoot), "locked", "invite.html"),
          );
        }).pipe(Effect.ensuring(fs.chmod(lockedDir, 0o755).pipe(Effect.orDie)));
      }),
  );

  it.effect.each(["template", "notification"] as const)(
    "rejects a %s content_path that is an in-root symlink pointing to an unstattable (ENAMETOOLONG) target name, without relying on directory permissions",
    (section) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const base = yield* setup();
        const outsideDir = yield* tempDir("config-validate-email-content-outside-");
        const tooLongName = `${"a".repeat(300)}.html`;
        const symlinkPath = path.join(base, "toolong.html");
        // Unprivileged symlink creation isn't unconditionally available (e.g. Windows without
        // Developer Mode/admin) — skip rather than fail an environment that can't set this up.
        if (
          !(yield* fs
            .symlink(path.join(outsideDir, tooLongName), symlinkPath)
            .pipe(Effect.isSuccess))
        ) {
          return;
        }

        expect(
          yield* Effect.flip(resolveContentPath(section, "./toolong.html", base)),
        ).toBeInstanceOf(ConfigValidateError);
        expect(
          (yield* Effect.flip(resolveContentPath(section, "./toolong.html", base))).message,
        ).toMatch(/resolves outside the project root/);
      }),
  );

  it.effect.each(["template", "notification"] as const)(
    "rejects an in-root %s symlink loop instead of hanging or crashing",
    (section) =>
      Effect.gen(function* () {
        // Reuses the symlinked-root fixture (rather than relying on incidental ambient-tmpdir
        // symlinks) so there's a guaranteed canonicalization gap between root and the loop path.
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const realDir = yield* tempDir("config-validate-email-content-real-");
        const linkContainer = yield* tempDir("config-validate-email-content-link-");
        const symlinkedRoot = path.join(linkContainer, "project-root");
        yield* fs.symlink(realDir, symlinkedRoot);

        const loopA = path.join(symlinkedRoot, "loop-a.html");
        const loopB = path.join(symlinkedRoot, "loop-b.html");
        yield* fs.symlink(loopB, loopA);
        yield* fs.symlink(loopA, loopB);

        expect(
          yield* Effect.flip(resolveContentPath(section, "./loop-a.html", symlinkedRoot)),
        ).toBeInstanceOf(ConfigValidateError);
        expect(
          (yield* Effect.flip(resolveContentPath(section, "./loop-a.html", symlinkedRoot))).message,
        ).toMatch(/resolves outside the project root/);
      }),
  );

  it.effect(
    "never selects an unstattable notification legacy-fallback twin behind an unsearchable (EACCES) supabase/ directory",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const base = yield* setup();
        const supabaseDir = path.join(base, "supabase");
        yield* fs.makeDirectory(supabaseDir);
        yield* fs.chmod(supabaseDir, 0o000);

        yield* Effect.gen(function* () {
          if (!(yield* permissionEnforced(supabaseDir))) {
            return;
          }

          const resolved = yield* resolveContentPath("notification", "notification.html", base);

          // The result must be the root-resolved path, not the unverified legacy twin; this
          // function only resolves a path, it doesn't check that the file exists, so a non-throw
          // here is expected.
          expect(resolved).toBe(path.join(yield* fs.realPath(base), "notification.html"));
        }).pipe(Effect.ensuring(fs.chmod(supabaseDir, 0o755).pipe(Effect.orDie)));
      }),
  );
});
