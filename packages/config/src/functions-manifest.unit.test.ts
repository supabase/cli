import { describe, expect, test } from "vitest";
import { BunServices } from "@effect/platform-bun";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, FileSystem, Path, Schema } from "effect";
import { ProjectConfigSchema } from "./base.ts";
import { inferFunctionsManifest } from "./functions-manifest.ts";

const decodeProjectConfig = Schema.decodeUnknownSync(ProjectConfigSchema);

function makeTempProject(): string {
  return mkdtempSync(join(tmpdir(), "supabase-functions-manifest-"));
}

function runConfigEffect<A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)));
}

describe("functions manifest", () => {
  test("detects default functions from the filesystem", async () => {
    const cwd = makeTempProject();

    try {
      const functionDir = join(cwd, "supabase", "functions", "hello-world");
      await mkdir(functionDir, { recursive: true });
      await writeFile(join(functionDir, "index.ts"), "Deno.serve(() => new Response())\n");
      await writeFile(join(functionDir, "deno.json"), '{"imports":{}}\n');

      await expect(runConfigEffect(inferFunctionsManifest({ cwd }))).resolves.toEqual({
        "hello-world": {
          enabled: true,
          verify_jwt: true,
          import_map: "./functions/hello-world/deno.json",
          entrypoint: "./functions/hello-world/index.ts",
          static_files: [],
          env: {},
        },
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("keeps the default import map when config only customizes other fields", async () => {
    const cwd = makeTempProject();

    try {
      const functionDir = join(cwd, "supabase", "functions", "hello-world");
      await mkdir(functionDir, { recursive: true });
      await writeFile(join(functionDir, "index.ts"), "Deno.serve(() => new Response())\n");
      await writeFile(join(functionDir, "deno.json"), '{"imports":{}}\n');
      await writeFile(
        join(cwd, "supabase", "config.json"),
        JSON.stringify({
          functions: {
            "hello-world": {
              verify_jwt: false,
            },
          },
        }),
      );

      await expect(runConfigEffect(inferFunctionsManifest({ cwd }))).resolves.toEqual({
        "hello-world": {
          enabled: true,
          verify_jwt: false,
          import_map: "./functions/hello-world/deno.json",
          entrypoint: "./functions/hello-world/index.ts",
          static_files: [],
          env: {},
        },
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("applies config-only custom functions", async () => {
    const cwd = makeTempProject();
    const config = decodeProjectConfig({
      functions: {
        "custom-entrypoint": {
          entrypoint: "./functions/custom-entrypoint/main.ts",
          import_map: "./functions/custom-entrypoint/deno.json",
          static_files: ["./functions/custom-entrypoint/*.html"],
          env: {
            OPENAI_API_KEY: "env(OPENAI_API_KEY)",
          },
        },
      },
    });

    try {
      await expect(runConfigEffect(inferFunctionsManifest({ cwd, config }))).resolves.toEqual({
        "custom-entrypoint": {
          enabled: true,
          verify_jwt: true,
          import_map: "./functions/custom-entrypoint/deno.json",
          entrypoint: "./functions/custom-entrypoint/main.ts",
          static_files: ["./functions/custom-entrypoint/*.html"],
          env: {
            OPENAI_API_KEY: "env(OPENAI_API_KEY)",
          },
        },
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("uses slug defaults for config-only functions with non-path overrides", async () => {
    const cwd = makeTempProject();
    const config = decodeProjectConfig({
      functions: {
        "hello-world": {
          verify_jwt: false,
        },
      },
    });

    try {
      await expect(runConfigEffect(inferFunctionsManifest({ cwd, config }))).resolves.toEqual({
        "hello-world": {
          enabled: true,
          verify_jwt: false,
          import_map: "",
          entrypoint: "./functions/hello-world/index.ts",
          static_files: [],
          env: {},
        },
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("keeps disabled filesystem functions in the inferred manifest", async () => {
    const cwd = makeTempProject();
    const config = decodeProjectConfig({
      functions: {
        "hello-world": {
          enabled: false,
        },
      },
    });

    try {
      const functionDir = join(cwd, "supabase", "functions", "hello-world");
      await mkdir(functionDir, { recursive: true });
      await writeFile(join(functionDir, "index.ts"), "Deno.serve(() => new Response())\n");

      await expect(runConfigEffect(inferFunctionsManifest({ cwd, config }))).resolves.toEqual({
        "hello-world": {
          enabled: false,
          verify_jwt: true,
          import_map: "",
          entrypoint: "./functions/hello-world/index.ts",
          static_files: [],
          env: {},
        },
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("ignores directories that are not default function shapes", async () => {
    const cwd = makeTempProject();

    try {
      await mkdir(join(cwd, "supabase", "functions", "missing-entrypoint"), {
        recursive: true,
      });
      await mkdir(join(cwd, "supabase", "functions", "invalid.slug"), { recursive: true });
      await writeFile(
        join(cwd, "supabase", "functions", "invalid.slug", "index.ts"),
        "Deno.serve(() => new Response())\n",
      );

      await expect(runConfigEffect(inferFunctionsManifest({ cwd }))).resolves.toEqual({});
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
