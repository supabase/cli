// oxlint-disable effecttsgo/node-builtin-import -- temporary filesystem fixtures use native setup APIs.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { afterEach, beforeEach, describe, expect } from "vitest";
import {
  displayPath,
  resolveComputeSource,
  computeDir,
  computeRootDir,
  computeSourceDir,
} from "./compute-paths.ts";
import { InvalidComputeSourceError } from "./compute.errors.ts";

const PROJECT = "/repo";

/**
 * Confinement is decided on the filesystem's terms, so these need a real one.
 * A path that does not exist still resolves — `canonicalize` walks up to the
 * deepest existing ancestor — which is what lets the `/repo` cases below stay
 * pure string scenarios.
 */
const runFs = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
  effect.pipe(Effect.provide(BunServices.layer));
const runPath = <A>(fn: (path: Path.Path) => A): Effect.Effect<A> =>
  Effect.gen(function* () {
    return fn(yield* Path.Path);
  }).pipe(Effect.provide(BunServices.layer));

describe("compute directories", () => {
  it.live("resolve under supabase/compute/", () =>
    Effect.gen(function* () {
      expect(yield* runPath((path) => computeRootDir(path, PROJECT))).toBe(
        join(PROJECT, "supabase", "compute"),
      );
      expect(yield* runPath((path) => computeDir(path, PROJECT, "api"))).toBe(
        join(PROJECT, "supabase", "compute", "api"),
      );
    }),
  );

  it.live("a recorded source wins and is anchored to the project root", () =>
    Effect.gen(function* () {
      const defaultDir = yield* runPath((path) => computeDir(path, PROJECT, "api"));
      const sourceDir = (configuredSource: string | undefined) =>
        runFs(
          computeSourceDir({ projectRoot: PROJECT, defaultDir, name: "api", configuredSource }),
        );

      expect(yield* sourceDir(undefined)).toBe(defaultDir);
      expect(yield* sourceDir("")).toBe(defaultDir);
      expect(yield* sourceDir("packages/api")).toBe(join(PROJECT, "packages", "api"));
    }),
  );

  // `source` arrives from a committed `config.toml`, so it is as much an input
  // as `--source` is — and `push` packages and uploads whatever it resolves to.
  it.live.each([
    { configuredSource: "../../elsewhere" },
    { configuredSource: "/etc" },
    { configuredSource: "supabase/functions/hello" },
  ])("refuses a recorded source of $configuredSource", ({ configuredSource }) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        runFs(
          computeSourceDir({
            projectRoot: PROJECT,
            defaultDir: yield* runPath((path) => computeDir(path, PROJECT, "api")),
            name: "api",
            configuredSource,
          }),
        ),
      );
      expect(error).toBeInstanceOf(InvalidComputeSourceError);
      expect(error.detail).toContain("[compute.api] source");
    }),
  );
});

describe("displayPath", () => {
  it.live("prefers the relative form, and falls back to absolute when it would climb out", () =>
    Effect.gen(function* () {
      expect(
        yield* runPath((path) =>
          displayPath(path, PROJECT, join(PROJECT, "supabase", "compute", "api")),
        ),
      ).toBe(join("supabase", "compute", "api"));
      expect(yield* runPath((path) => displayPath(path, PROJECT, PROJECT))).toBe(".");
      expect(
        yield* runPath((path) =>
          displayPath(path, join(PROJECT, "deep", "deeper"), "/elsewhere/api"),
        ),
      ).toBe("/elsewhere/api");
    }),
  );
});

describe("resolveComputeSource", () => {
  const cwd = `${PROJECT}/apps/web`;

  it.live("resolves a directory inside the project against the directory it was typed in", () =>
    Effect.gen(function* () {
      expect(
        yield* runFs(
          resolveComputeSource({ projectRoot: PROJECT, cwd, raw: "../../packages/api" }),
        ),
      ).toBe(join(PROJECT, "packages", "api"));
      expect(
        yield* runFs(
          resolveComputeSource({ projectRoot: PROJECT, cwd: PROJECT, raw: "packages/api/" }),
        ),
      ).toBe(join(PROJECT, "packages", "api"));
    }),
  );

  // The starter files land in whatever this resolves to, so each of these would
  // write into work belonging to the project or to the machine.
  it.live.each([
    { raw: ".", reason: "the project root itself" },
    { raw: "", reason: "empty" },
    { raw: "..", reason: "outside the project" },
    { raw: "/etc", reason: "outside the project" },
    { raw: "../elsewhere", reason: "outside the project" },
    { raw: "supabase", reason: "the supabase directory itself" },
    { raw: "supabase/functions", reason: "supabase/functions/" },
    { raw: "supabase/functions/hello", reason: "supabase/functions/" },
    { raw: "supabase/migrations", reason: "supabase/migrations/" },
    { raw: "supabase/.temp", reason: "supabase/.temp/" },
    { raw: "supabase/.temp/project-ref", reason: "supabase/.temp/" },
    // Refusing the reserved directories is not enough on its own: this path is
    // inside the project, is not `supabase/` itself, and is in no reserved
    // subdirectory — so without this it would be authorized as a scaffold
    // destination, and the project's config file is not that.
    { raw: "supabase/config.toml", reason: "supabase/config.toml" },
    { raw: "supabase/config.json", reason: "supabase/config.json" },
  ])("refuses $raw", ({ raw, reason }) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        runFs(resolveComputeSource({ projectRoot: PROJECT, cwd: PROJECT, raw })),
      );
      expect(error).toBeInstanceOf(InvalidComputeSourceError);
      expect(error.detail).toContain(reason);
    }),
  );
});

// Containment on a real filesystem, because a string comparison cannot see a
// symlink: a directory inside the project is free to point anywhere outside it,
// and the starter files land wherever the path really resolves.
describe("resolveComputeSource containment on a real filesystem", () => {
  let project = "";
  let outside = "";

  beforeEach(() => {
    const scratch = mkdtempSync(join(tmpdir(), "compute-paths-"));
    project = join(scratch, "project");
    outside = join(scratch, "outside");
    mkdirSync(join(project, "packages"), { recursive: true });
    mkdirSync(join(outside, "api"), { recursive: true });
    mkdirSync(join(project, "supabase", "functions", "hello"), { recursive: true });
  });

  afterEach(() => {
    rmSync(join(project, ".."), { recursive: true, force: true });
  });

  it.live("resolves a genuine directory inside the project", () =>
    Effect.gen(function* () {
      expect(
        yield* runFs(resolveComputeSource({ projectRoot: project, cwd: project, raw: "packages" })),
      ).toBe(join(project, "packages"));
    }),
  );

  it.live("refuses a path that reaches outside the project through a symlink", () =>
    Effect.gen(function* () {
      symlinkSync(outside, join(project, "packages", "external"));

      const error = yield* Effect.flip(
        runFs(
          resolveComputeSource({
            projectRoot: project,
            cwd: project,
            raw: join("packages", "external", "api"),
          }),
        ),
      );

      expect(error).toBeInstanceOf(InvalidComputeSourceError);
      expect(error.detail).toContain("resolves outside the project");
    }),
  );

  it.live("refuses a reserved directory reached through a symlink", () =>
    Effect.gen(function* () {
      symlinkSync(join(project, "supabase", "functions"), join(project, "fns"));

      const error = yield* Effect.flip(
        runFs(
          resolveComputeSource({
            projectRoot: project,
            cwd: project,
            raw: join("fns", "hello"),
          }),
        ),
      );

      expect(error).toBeInstanceOf(InvalidComputeSourceError);
      expect(error.detail).toContain("supabase/functions/");
    }),
  );

  // A destination that does not exist yet is the normal case for `new`, and the
  // project root itself is usually behind a symlink on macOS (`/var` ->
  // `/private/var`). Both have to compare equal, not fail containment.
  // A name that ends in a space is legal on Unix, and only reaches argv as one
  // entry if the user quoted it. Trimming it pointed the scaffold at a different
  // directory than the one asked for.
  it.live("keeps whitespace that is part of the directory name", () =>
    Effect.gen(function* () {
      expect(
        yield* runFs(
          resolveComputeSource({ projectRoot: project, cwd: project, raw: "packages/api " }),
        ),
      ).toBe(join(project, "packages", "api "));
    }),
  );

  it.live.each([{ raw: "" }, { raw: "   " }, { raw: "\t" }])(
    "refuses an all-whitespace --source of $raw",
    ({ raw }) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          runFs(resolveComputeSource({ projectRoot: project, cwd: project, raw })),
        );
        expect(error).toBeInstanceOf(InvalidComputeSourceError);
        expect(error.detail).toContain("is empty");
      }),
  );

  it.live("accepts a destination that does not exist yet", () =>
    Effect.gen(function* () {
      expect(
        yield* runFs(
          resolveComputeSource({ projectRoot: project, cwd: project, raw: "packages/brand-new" }),
        ),
      ).toBe(join(project, "packages", "brand-new"));
    }),
  );
});
