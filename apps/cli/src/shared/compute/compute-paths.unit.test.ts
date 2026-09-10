// oxlint-disable effecttsgo/async-function -- Vitest callbacks await filesystem-backed Effect programs.
// oxlint-disable effecttsgo/node-builtin-import -- temporary filesystem fixtures use native setup APIs.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Path } from "effect";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
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
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)));
const runPath = <A>(fn: (path: Path.Path) => A): A =>
  Effect.runSync(
    Effect.gen(function* () {
      return fn(yield* Path.Path);
    }).pipe(Effect.provide(BunServices.layer)),
  );

describe("compute directories", () => {
  test("resolve under supabase/compute/", () => {
    expect(runPath((path) => computeRootDir(path, PROJECT))).toBe(
      join(PROJECT, "supabase", "compute"),
    );
    expect(runPath((path) => computeDir(path, PROJECT, "api"))).toBe(
      join(PROJECT, "supabase", "compute", "api"),
    );
  });

  test("a recorded source wins and is anchored to the project root", async () => {
    const defaultDir = runPath((path) => computeDir(path, PROJECT, "api"));
    const sourceDir = (configuredSource: string | undefined) =>
      runFs(computeSourceDir({ projectRoot: PROJECT, defaultDir, name: "api", configuredSource }));

    expect(await sourceDir(undefined)).toBe(defaultDir);
    expect(await sourceDir("")).toBe(defaultDir);
    expect(await sourceDir("packages/api")).toBe(join(PROJECT, "packages", "api"));
  });

  // `source` arrives from a committed `config.toml`, so it is as much an input
  // as `--source` is — and `push` packages and uploads whatever it resolves to.
  test.each([["../../elsewhere"], ["/etc"], ["supabase/functions/hello"]])(
    "refuses a recorded source of %j",
    async (configuredSource) => {
      const error = await runFs(
        computeSourceDir({
          projectRoot: PROJECT,
          defaultDir: runPath((path) => computeDir(path, PROJECT, "api")),
          name: "api",
          configuredSource,
        }).pipe(Effect.flip),
      );
      expect(error).toBeInstanceOf(InvalidComputeSourceError);
      expect(error.detail).toContain("[compute.api] source");
    },
  );
});

describe("displayPath", () => {
  test("prefers the relative form, and falls back to absolute when it would climb out", () => {
    expect(
      runPath((path) => displayPath(path, PROJECT, join(PROJECT, "supabase", "compute", "api"))),
    ).toBe(join("supabase", "compute", "api"));
    expect(runPath((path) => displayPath(path, PROJECT, PROJECT))).toBe(".");
    expect(
      runPath((path) => displayPath(path, join(PROJECT, "deep", "deeper"), "/elsewhere/api")),
    ).toBe("/elsewhere/api");
  });
});

describe("resolveComputeSource", () => {
  const cwd = `${PROJECT}/apps/web`;

  test("resolves a directory inside the project against the directory it was typed in", async () => {
    expect(
      await runFs(resolveComputeSource({ projectRoot: PROJECT, cwd, raw: "../../packages/api" })),
    ).toBe(join(PROJECT, "packages", "api"));
    expect(
      await runFs(
        resolveComputeSource({ projectRoot: PROJECT, cwd: PROJECT, raw: "packages/api/" }),
      ),
    ).toBe(join(PROJECT, "packages", "api"));
  });

  // The starter files land in whatever this resolves to, so each of these would
  // write into work belonging to the project or to the machine.
  test.each([
    [".", "the project root itself"],
    ["", "empty"],
    ["..", "outside the project"],
    ["/etc", "outside the project"],
    ["../elsewhere", "outside the project"],
    ["supabase", "the supabase directory itself"],
    ["supabase/functions", "supabase/functions/"],
    ["supabase/functions/hello", "supabase/functions/"],
    ["supabase/migrations", "supabase/migrations/"],
    ["supabase/.temp", "supabase/.temp/"],
    ["supabase/.temp/project-ref", "supabase/.temp/"],
    // Refusing the reserved directories is not enough on its own: this path is
    // inside the project, is not `supabase/` itself, and is in no reserved
    // subdirectory — so without this it would be authorized as a scaffold
    // destination, and the project's config file is not that.
    ["supabase/config.toml", "supabase/config.toml"],
    ["supabase/config.json", "supabase/config.json"],
  ])("refuses %j", async (raw, reason) => {
    const error = await runFs(
      resolveComputeSource({ projectRoot: PROJECT, cwd: PROJECT, raw }).pipe(Effect.flip),
    );
    expect(error).toBeInstanceOf(InvalidComputeSourceError);
    expect(error.detail).toContain(reason);
  });
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

  test("resolves a genuine directory inside the project", async () => {
    expect(
      await runFs(resolveComputeSource({ projectRoot: project, cwd: project, raw: "packages" })),
    ).toBe(join(project, "packages"));
  });

  test("refuses a path that reaches outside the project through a symlink", async () => {
    symlinkSync(outside, join(project, "packages", "external"));

    const error = await runFs(
      resolveComputeSource({
        projectRoot: project,
        cwd: project,
        raw: join("packages", "external", "api"),
      }).pipe(Effect.flip),
    );

    expect(error).toBeInstanceOf(InvalidComputeSourceError);
    expect(error.detail).toContain("resolves outside the project");
  });

  test("refuses a reserved directory reached through a symlink", async () => {
    symlinkSync(join(project, "supabase", "functions"), join(project, "fns"));

    const error = await runFs(
      resolveComputeSource({
        projectRoot: project,
        cwd: project,
        raw: join("fns", "hello"),
      }).pipe(Effect.flip),
    );

    expect(error).toBeInstanceOf(InvalidComputeSourceError);
    expect(error.detail).toContain("supabase/functions/");
  });

  // A destination that does not exist yet is the normal case for `new`, and the
  // project root itself is usually behind a symlink on macOS (`/var` ->
  // `/private/var`). Both have to compare equal, not fail containment.
  // A name that ends in a space is legal on Unix, and only reaches argv as one
  // entry if the user quoted it. Trimming it pointed the scaffold at a different
  // directory than the one asked for.
  test("keeps whitespace that is part of the directory name", async () => {
    expect(
      await runFs(
        resolveComputeSource({ projectRoot: project, cwd: project, raw: "packages/api " }),
      ),
    ).toBe(join(project, "packages", "api "));
  });

  test.each([[""], ["   "], ["\t"]])("refuses an all-whitespace --source of %j", async (raw) => {
    const error = await runFs(
      resolveComputeSource({ projectRoot: project, cwd: project, raw }).pipe(Effect.flip),
    );
    expect(error).toBeInstanceOf(InvalidComputeSourceError);
    expect(error.detail).toContain("is empty");
  });

  test("accepts a destination that does not exist yet", async () => {
    expect(
      await runFs(
        resolveComputeSource({ projectRoot: project, cwd: project, raw: "packages/brand-new" }),
      ),
    ).toBe(join(project, "packages", "brand-new"));
  });
});
