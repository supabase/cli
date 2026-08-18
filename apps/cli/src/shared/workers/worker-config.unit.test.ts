import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  readWorkersSection,
  WorkerEntryNotATableError,
  WorkerEntryValueNotEditableError,
  writeWorkerEntry,
} from "./worker-config.ts";

describe("readWorkersSection", () => {
  test("splits the project-wide root from the per-worker tables", () => {
    expect(
      readWorkersSection({
        root: "services",
        api: { runtime: "node", size: "2gb", source: "packages/api" },
        box: { runtime: "sandbox" },
      }),
    ).toEqual({
      root: "services",
      workers: {
        api: { runtime: "node", size: "2gb", source: "packages/api" },
        box: { runtime: "sandbox", size: undefined, source: undefined },
      },
    });
  });

  test("drops non-object values so a stray scalar is not read as a worker", () => {
    expect(readWorkersSection({ root: "services", stray: "oops", api: {} })).toEqual({
      root: "services",
      workers: { api: { runtime: undefined, size: undefined, source: undefined } },
    });
  });

  test("treats a missing or malformed section as empty", () => {
    expect(readWorkersSection(undefined)).toEqual({ root: undefined, workers: {} });
    expect(readWorkersSection([])).toEqual({ root: undefined, workers: {} });
    // An empty root is passed through so the validator can name it.
    expect(readWorkersSection({ root: "" })).toEqual({ root: "", workers: {} });
  });
});

describe("writeWorkerEntry", () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "supabase-worker-config-"));
    configPath = join(dir, "config.toml");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (effect: Effect.Effect<void, unknown, never>) => Effect.runPromise(effect);

  test("creates the file when there is none yet", async () => {
    await run(
      writeWorkerEntry({
        configPath,
        name: "api",
        existingWorkers: {},
        patch: { runtime: "node" },
      }).pipe(Effect.provide(BunServices.layer)),
    );

    expect(readFileSync(configPath, "utf8")).toBe('[workers.api]\nruntime = "node"\n');
  });

  test("updates an existing table without touching the rest of the file", async () => {
    writeFileSync(
      configPath,
      '# keep me\nproject_id = "demo"\n\n[workers.api]\nruntime = "node"\n',
    );

    await run(
      writeWorkerEntry({
        configPath,
        name: "api",
        existingWorkers: { api: { runtime: "node" } },
        patch: { runtime: "bun", size: "4gb" },
      }).pipe(Effect.provide(BunServices.layer)),
    );

    expect(readFileSync(configPath, "utf8")).toBe(
      '# keep me\nproject_id = "demo"\n\n[workers.api]\nruntime = "bun"\nsize = "4gb"\n',
    );
  });

  test("refuses a multi-line value instead of stranding its continuation lines", async () => {
    const before = '[workers.api]\nruntime = [\n  "node",\n]\n';
    writeFileSync(configPath, before);

    const error = await run(
      writeWorkerEntry({
        configPath,
        name: "api",
        existingWorkers: { api: {} },
        patch: { runtime: "bun" },
      }).pipe(Effect.provide(BunServices.layer), Effect.flip),
    );

    expect(error).toBeInstanceOf(WorkerEntryValueNotEditableError);
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  test("keeps a trailing comment on the value it rewrites", async () => {
    writeFileSync(configPath, '[workers.api]\nruntime = "node" # hand-picked\n');

    await run(
      writeWorkerEntry({
        configPath,
        name: "api",
        existingWorkers: { api: { runtime: "node" } },
        patch: { runtime: "bun" },
      }).pipe(Effect.provide(BunServices.layer)),
    );

    expect(readFileSync(configPath, "utf8")).toBe('[workers.api]\nruntime = "bun" # hand-picked\n');
  });

  test("refuses to rewrite a worker expressed as dotted keys rather than its own table", async () => {
    writeFileSync(configPath, 'workers.api.runtime = "node"\n');

    const error = await run(
      writeWorkerEntry({
        configPath,
        name: "api",
        existingWorkers: { api: { runtime: "node" } },
        patch: { runtime: "bun" },
      }).pipe(Effect.provide(BunServices.layer), Effect.flip),
    );

    expect(error).toBeInstanceOf(WorkerEntryNotATableError);
    // The file is left exactly as it was rather than duplicated into invalid TOML.
    expect(readFileSync(configPath, "utf8")).toBe('workers.api.runtime = "node"\n');
  });
});
