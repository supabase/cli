import * as BunPath from "@effect/platform-bun/BunPath";
import { Effect, FileSystem, Layer, Path, PlatformError } from "effect";
import { describe, expect, it } from "vitest";

import { resolveEmailTemplateContentPath } from "./config-validate.ts";

/**
 * Exercises `canonicalPathForContainment`'s ancestor walk-up with a 5,000-component missing
 * path — deeper than any real filesystem allows (`PATH_MAX` caps a real OS at a few thousand
 * components), so `FileSystem` is faked here to drive the loop's own iteration count directly.
 */
const missingEntry = (method: string, syscall: string, path: string) =>
  PlatformError.systemError({
    _tag: "NotFound",
    module: "FileSystem",
    method,
    syscall,
    pathOrDescriptor: path,
    cause: Object.assign(new Error(`ENOENT: no such file or directory, ${syscall} '${path}'`), {
      code: "ENOENT",
    }),
  });

const FAKE_EXISTING_BASE = "/fake/project-root";
const path = Effect.runSync(Effect.provide(Path.Path, BunPath.layer));
const fakeFileSystem = FileSystem.layerNoop({
  realPath: (path) =>
    path === FAKE_EXISTING_BASE
      ? Effect.succeed(FAKE_EXISTING_BASE)
      : Effect.fail(missingEntry("realPath", "realpath", path)),
  /* The `lstat` stand-in: no path in this fixture exists, so none is a symlink. */
  readLink: (path) => Effect.fail(missingEntry("readLink", "readlink", path)),
  stat: () =>
    Effect.die(new Error("`stat` should never be reached by the template content_path branch")),
});

describe("canonicalPathForContainment (via resolveEmailTemplateContentPath)", () => {
  it("resolves a 5,000-component-deep missing content_path without blowing the call stack", () => {
    const missingSegments = Array.from({ length: 5000 }, (_, i) => `missing-${i}`);
    const contentPath = `${missingSegments.join("/")}/invite.html`;

    const resolved = Effect.runSync(
      resolveEmailTemplateContentPath({
        section: "template",
        name: "invite",
        contentPath,
        contentPresent: false,
        base: FAKE_EXISTING_BASE,
      }).pipe(Effect.provide(Layer.mergeAll(fakeFileSystem, BunPath.layer))),
    );

    expect(resolved).toBe(path.join(FAKE_EXISTING_BASE, contentPath));
  });
});
