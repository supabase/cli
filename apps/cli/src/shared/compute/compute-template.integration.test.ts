import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { makeGitRepo, runFixtureGit } from "../../../tests/helpers/git-repo.ts";
import {
  ComputeTemplateContentError,
  ComputeTemplateFetchError,
  stageComputeTemplate,
  type ComputeTemplateSpec,
} from "./compute-template.ts";

function spec(
  overrides: Partial<ComputeTemplateSpec> & { readonly url: string },
): ComputeTemplateSpec {
  return { ref: undefined, subdir: [], display: overrides.url, ...overrides };
}

describe("stageComputeTemplate", () => {
  it.live("stages the repository's files without its history", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repo = yield* makeGitRepo({
        "index.mjs": "export default { fetch: () => new Response('hi') };\n",
        "lib/util.mjs": "export const one = 1;\n",
      });

      const staged = yield* stageComputeTemplate(spec({ url: repo }));

      expect(yield* fs.readFileString(path.join(staged, "index.mjs"))).toContain("Response('hi')");
      expect(yield* fs.readFileString(path.join(staged, "lib", "util.mjs"))).toContain("one = 1");
      expect(yield* fs.exists(path.join(staged, ".git"))).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("stages only the named subdirectory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repo = yield* makeGitRepo({
        "README.md": "the whole repo\n",
        "examples/hono/index.ts": "export default {};\n",
      });

      const staged = yield* stageComputeTemplate(spec({ url: repo, subdir: ["examples", "hono"] }));

      expect(yield* fs.exists(path.join(staged, "index.ts"))).toBe(true);
      expect(yield* fs.exists(path.join(staged, "README.md"))).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("checks out a tag by name", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repo = yield* makeGitRepo({ "index.mjs": "v1\n" });
      yield* Effect.scoped(runFixtureGit(repo, ["tag", "v1.0.0"]));
      yield* fs.writeFileString(path.join(repo, "index.mjs"), "v2\n");
      yield* Effect.scoped(runFixtureGit(repo, ["commit", "--quiet", "-am", "v2"]));

      const staged = yield* stageComputeTemplate(spec({ url: repo, ref: "v1.0.0" }));

      expect(yield* fs.readFileString(path.join(staged, "index.mjs"))).toBe("v1\n");
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("reports what git said when the ref does not exist", () =>
    Effect.gen(function* () {
      const repo = yield* makeGitRepo({ "index.mjs": "v1\n" });

      const error = yield* stageComputeTemplate(spec({ url: repo, ref: "nope" })).pipe(Effect.flip);

      expect(error).toBeInstanceOf(ComputeTemplateFetchError);
      expect(error.detail).toContain("nope");
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("refuses a repository that is not there", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-template-absent-" });

      const error = yield* stageComputeTemplate(spec({ url: path.join(parent, "missing") })).pipe(
        Effect.flip,
      );

      expect(error).toBeInstanceOf(ComputeTemplateFetchError);
      expect(error.suggestion).toContain("git is installed");
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("refuses a subdirectory the repository does not have", () =>
    Effect.gen(function* () {
      const repo = yield* makeGitRepo({ "index.mjs": "v1\n" });

      const error = yield* stageComputeTemplate(spec({ url: repo, subdir: ["nope"] })).pipe(
        Effect.flip,
      );

      expect(error).toBeInstanceOf(ComputeTemplateContentError);
      expect(error.detail).toContain("does not have");
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("refuses a subdirectory that names a file", () =>
    Effect.gen(function* () {
      const repo = yield* makeGitRepo({ "index.mjs": "v1\n" });

      const error = yield* stageComputeTemplate(spec({ url: repo, subdir: ["index.mjs"] })).pipe(
        Effect.flip,
      );

      expect(error).toBeInstanceOf(ComputeTemplateContentError);
      expect(error.detail).toContain("not a directory");
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // The cloned repository decides what the subdirectory resolves to, so this is the
  // one way a template could aim the copy at the rest of the machine.
  it.live("refuses a subdirectory that is a link leading out of the repository", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-template-outside-" });
      yield* fs.writeFileString(path.join(outside, "secret"), "not yours\n");
      const repo = yield* makeGitRepo({ "index.mjs": "v1\n" });
      yield* fs.symlink(outside, path.join(repo, "escape"));
      yield* Effect.scoped(runFixtureGit(repo, ["add", "-A"]));
      yield* Effect.scoped(runFixtureGit(repo, ["commit", "--quiet", "-m", "escape"]));

      const error = yield* stageComputeTemplate(spec({ url: repo, subdir: ["escape"] })).pipe(
        Effect.flip,
      );

      expect(error).toBeInstanceOf(ComputeTemplateContentError);
      expect(error.detail).toContain("outside the repository");
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("refuses a template whose tree holds no files", () =>
    Effect.gen(function* () {
      const repo = yield* makeGitRepo({ ".keep": "" });
      yield* Effect.scoped(runFixtureGit(repo, ["rm", "--quiet", ".keep"]));
      yield* Effect.scoped(runFixtureGit(repo, ["commit", "--quiet", "-m", "empty"]));

      const error = yield* stageComputeTemplate(spec({ url: repo })).pipe(Effect.flip);

      expect(error).toBeInstanceOf(ComputeTemplateContentError);
      expect(error.detail).toContain("holds no files");
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );
});
