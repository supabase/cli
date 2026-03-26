import { describe, expect, it } from "@effect/vitest";
import { projectConfigStoreLayer } from "@supabase/config";
import { BunServices } from "@effect/platform-bun";
import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { PROJECT_CONFIG_SCHEMA_URL } from "@supabase/config";
import { mockOutput, mockRuntimeInfo } from "../../../tests/helpers/mocks.ts";
import { init } from "./init.handler.ts";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "supabase-init-command-"));
}

function buildLayer(cwd: string) {
  const runtimeInfoLayer = mockRuntimeInfo({ cwd });
  const out = mockOutput({ format: "text", interactive: false });

  return {
    out,
    layer: Layer.mergeAll(
      out.layer,
      runtimeInfoLayer,
      BunServices.layer,
      projectConfigStoreLayer.pipe(Layer.provide(BunServices.layer)),
    ),
  };
}

describe("init handler", () => {
  it.live("creates a minimal config.json with the hosted $schema", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => mkdir(join(tempDir, ".git"), { recursive: true }));
      const { layer, out } = buildLayer(tempDir);

      yield* init().pipe(Effect.provide(layer));

      const configPath = join(tempDir, "supabase", "config.json");
      const content = yield* Effect.tryPromise(() => readFile(configPath, "utf8"));

      expect(JSON.parse(content)).toEqual({
        $schema: PROJECT_CONFIG_SCHEMA_URL,
      });
      expect(
        yield* Effect.tryPromise(() => readFile(join(tempDir, ".gitignore"), "utf8")),
      ).toContain(".supabase/");
      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "success", message: "Initialized Supabase project." }),
      );
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("does not overwrite an existing config", () => {
    const tempDir = makeTempDir();
    const configPath = join(tempDir, "supabase", "config.json");
    const initialConfig = JSON.stringify(
      {
        $schema: "./node_modules/@supabase/config/schema.json",
        db: { major_version: 16 },
      },
      null,
      2,
    );

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => mkdir(join(tempDir, "supabase"), { recursive: true }));
      yield* Effect.tryPromise(() => mkdir(join(tempDir, ".git"), { recursive: true }));
      yield* Effect.tryPromise(() => writeFile(configPath, `${initialConfig}\n`));

      const { layer, out } = buildLayer(tempDir);

      yield* init().pipe(Effect.provide(layer));

      const content = yield* Effect.tryPromise(() => readFile(configPath, "utf8"));
      expect(content).toBe(`${initialConfig}\n`);
      expect(
        yield* Effect.tryPromise(() => readFile(join(tempDir, ".gitignore"), "utf8")),
      ).toContain(".supabase/");
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "success",
          message: "Supabase project already initialized.",
        }),
      );
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });

  it.live("does not create local link metadata", () => {
    const tempDir = makeTempDir();

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => mkdir(join(tempDir, ".git"), { recursive: true }));
      const { layer } = buildLayer(tempDir);

      yield* init().pipe(Effect.provide(layer));

      expect(existsSync(join(tempDir, ".supabase", "project.json"))).toBe(false);
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(tempDir, { recursive: true, force: true }))),
    );
  });
});
