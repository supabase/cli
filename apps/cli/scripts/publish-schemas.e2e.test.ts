import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, JsonSchema, Layer, Path } from "effect";
import { fileURLToPath } from "node:url";

const cliRoot = fileURLToPath(new URL("..", import.meta.url));
const platformLayer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const runScript = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const { FORCE_COLOR: _forceColor, NO_COLOR: _noColor, ...env } = process.env;
    const child = Bun.spawn(["bun", "scripts/publish-schemas.ts", ...args], {
      cwd: cliRoot,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = yield* Effect.all(
      [
        Effect.promise(() => child.exited),
        Effect.promise(() => new Response(child.stdout).text()),
        Effect.promise(() => new Response(child.stderr).text()),
      ],
      { concurrency: "unbounded" },
    );
    return { exitCode, stdout, stderr };
  });

const schemaText = (name: string, version: number, overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    $schema: JsonSchema.META_SCHEMA_URI_DRAFT_07,
    $id: `https://supabase.com/schemas/${name}/v${version}.json`,
    type: "object",
    ...overrides,
  });

const schemasDirOf = (files: Record<string, string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "publish-schemas-" });
    for (const [file, content] of Object.entries(files)) {
      yield* fs.makeDirectory(path.dirname(path.join(directory, file)), { recursive: true });
      yield* fs.writeFileString(path.join(directory, file), content);
    }
    return directory;
  });

const refusals: ReadonlyArray<{
  description: string;
  files: Record<string, string>;
  message: string;
}> = [
  {
    description: "an $id that does not match the schema's path",
    files: { "config/v1.json": schemaText("config", 1, { $id: "https://example.com/c.json" }) },
    message: `Refusing to publish: config/v1.json must declare "$id": "https://supabase.com/schemas/config/v1.json".`,
  },
  {
    description: "a $schema that is not draft-07",
    files: {
      "config/v1.json": schemaText("config", 1, {
        $schema: "https://json-schema.org/draft/2020-12/schema",
      }),
    },
    message: `Refusing to publish: config/v1.json must declare "$schema": "${JsonSchema.META_SCHEMA_URI_DRAFT_07}".`,
  },
  {
    description: "a file that is not valid JSON",
    files: { "config/v1.json": "{ not json" },
    message: "Refusing to publish: config/v1.json is not a valid JSON object.",
  },
  {
    description: "a file in a schema directory that is not named v<N>.json",
    files: { "config/v1.json": schemaText("config", 1), "config/notes.md": "# notes" },
    message: "Refusing to publish: config/notes.md does not match v<N>.json.",
  },
  {
    description: "a schemas directory without schemas",
    files: {},
    message: "Refusing to publish: no schemas found in ",
  },
];

describe("publish-schemas.ts entrypoint", () => {
  it.effect("prints usage and fails without --version", () =>
    Effect.gen(function* () {
      const { exitCode, stderr } = yield* runScript(["--dry-run"]);

      expect(exitCode).toBe(1);
      expect(stderr).toContain("Usage:");
    }).pipe(Effect.provide(platformLayer)),
  );

  it.effect("summarizes the committed schemas in dry-run mode without publishing", () =>
    Effect.gen(function* () {
      const { exitCode, stdout, stderr } = yield* runScript(["--version", "v2.0.0", "--dry-run"]);

      expect(exitCode, stderr).toBe(0);
      expect(stdout.trim()).toMatch(
        /^Would publish .+ to supabase\/supabase:apps\/www\/public\/schemas on branch cli\/schemas$/,
      );
    }).pipe(Effect.provide(platformLayer)),
  );

  it.effect("summarizes only the highest version of each schema", () =>
    Effect.gen(function* () {
      const schemasDir = yield* schemasDirOf({
        "config/v1.json": "frozen, never validated",
        "config/v2.json": schemaText("config", 2),
        "lock/v1.json": schemaText("lock", 1),
      });

      const { exitCode, stdout, stderr } = yield* runScript([
        "--version",
        "1.0.0",
        "--schemas-dir",
        schemasDir,
        "--dry-run",
      ]);

      expect(exitCode, stderr).toBe(0);
      expect(stdout).toContain("Would publish config/v2.json, lock/v1.json to ");
    }).pipe(Effect.provide(platformLayer)),
  );

  it.effect.each(refusals)("refuses $description", ({ files, message }) =>
    Effect.gen(function* () {
      const schemasDir = yield* schemasDirOf(files);

      const { exitCode, stdout, stderr } = yield* runScript([
        "--version",
        "1.0.0",
        "--schemas-dir",
        schemasDir,
        "--dry-run",
      ]);

      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain(message);
    }).pipe(Effect.provide(platformLayer)),
  );
});
