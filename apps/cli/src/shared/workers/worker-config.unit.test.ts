import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect, Exit } from "effect";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  readWorkersSection,
  WorkerAlreadyConfiguredError,
  WorkerConfigWriteUnsafeError,
  commitWorkerEntry,
  planWorkerEntry,
} from "./worker-config.ts";

describe("readWorkersSection", () => {
  test("reads each worker's recorded dials", () => {
    expect(
      readWorkersSection({
        api: {
          runtime: "node",
          size: "2gb",
          exposure: "private",
          instances: 4,
          source: "packages/api",
        },
        box: { runtime: "sandbox" },
      }),
    ).toEqual({
      workers: {
        api: {
          runtime: "node",
          size: "2gb",
          exposure: "private",
          instances: 4,
          source: "packages/api",
        },
        box: {
          runtime: "sandbox",
          size: undefined,
          exposure: undefined,
          instances: undefined,
          source: undefined,
        },
      },
    });
  });

  test("drops non-object values so a stray scalar is not read as a worker", () => {
    expect(readWorkersSection({ stray: "oops", api: {} })).toEqual({
      workers: {
        api: {
          runtime: undefined,
          size: undefined,
          exposure: undefined,
          instances: undefined,
          source: undefined,
        },
      },
    });
  });

  // `push` has to send a count with every deploy, so a value the API would
  // reject is dropped here and the default used instead.
  test.each([
    ["a float", 1.5],
    ["a negative", -1],
    ["a string", "3"],
  ])("drops %s instance count", (_label, value) => {
    expect(readWorkersSection({ api: { instances: value } }).workers["api"]?.instances).toBe(
      undefined,
    );
  });

  test("keeps a zero instance count, which scales a worker down rather than being absent", () => {
    expect(readWorkersSection({ api: { instances: 0 } }).workers["api"]?.instances).toBe(0);
  });

  // Unlike the instance count, an unrecognized exposure is kept and carried to
  // `push`, which names the values it accepts. Dropping it here would deploy the
  // worker at the default exposure — public — which is the opposite of what a
  // misspelled `private` was asking for.
  test("keeps an exposure it does not recognize, for push to refuse by name", () => {
    expect(readWorkersSection({ api: { exposure: "privat" } }).workers["api"]?.exposure).toBe(
      "privat",
    );
  });

  test("treats a missing or malformed section as empty", () => {
    expect(readWorkersSection(undefined)).toEqual({ workers: {} });
    expect(readWorkersSection([])).toEqual({ workers: {} });
  });
});

describe("planWorkerEntry + commitWorkerEntry", () => {
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

  /** plan + commit — the pairing `new` performs once it has decided to write. */
  const writeWorkerEntry = (options: Parameters<typeof planWorkerEntry>[0]) =>
    planWorkerEntry(options).pipe(Effect.flatMap(commitWorkerEntry));

  // The re-parse below is a syntax check, not a schema one: `instances = 1.5`
  // is perfectly valid TOML that the worker schema rejects, so it would reach
  // the user's config and only fail later, when the loader refuses the file.
  test.each([
    ["a fraction", 1.5],
    ["a negative count", -1],
    ["a value past the safe integer range", 1e21],
    ["not a number at all", Number.NaN],
  ])("refuses %s rather than rendering it", async (_label, instances) => {
    const exit = await Effect.runPromise(
      writeWorkerEntry({
        configPath,
        name: "api",
        existingWorkers: {},
        patch: { runtime: "node", instances },
      }).pipe(Effect.provide(BunServices.layer), Effect.exit),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    // Refused before anything reaches disk, the way every other unsafe write is.
    expect(existsSync(configPath)).toBe(false);
  });

  test("writes a whole, non-negative count unquoted", async () => {
    await run(
      writeWorkerEntry({
        configPath,
        name: "api",
        existingWorkers: {},
        patch: { runtime: "node", instances: 0 },
      }).pipe(Effect.provide(BunServices.layer)),
    );

    expect(readFileSync(configPath, "utf8")).toContain("instances = 0");
  });

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

  test("appends to an existing file without touching the rest of it", async () => {
    writeFileSync(configPath, '# keep me\nproject_id = "demo"\n');

    await run(
      writeWorkerEntry({
        configPath,
        name: "api",
        existingWorkers: {},
        patch: { runtime: "node", size: "4gb" },
      }).pipe(Effect.provide(BunServices.layer)),
    );

    expect(readFileSync(configPath, "utf8")).toBe(
      '# keep me\nproject_id = "demo"\n\n[workers.api]\nruntime = "node"\nsize = "4gb"\n',
    );
  });

  // `new` creates a worker; changing one that exists is a `config.toml` edit and
  // the file is the user's. Refusing is also what keeps writes append-only.
  test("refuses a worker that is already configured, leaving the file alone", async () => {
    const before = '# hand-written\n[workers.api]\nruntime = "node" # mine\n';
    writeFileSync(configPath, before);

    const error = await run(
      writeWorkerEntry({
        configPath,
        name: "api",
        existingWorkers: { api: { runtime: "node" } },
        patch: { runtime: "deno" },
      }).pipe(Effect.provide(BunServices.layer), Effect.flip),
    );

    expect(error).toBeInstanceOf(WorkerAlreadyConfiguredError);
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  // How the entry is written — dotted, inline or a table — does not matter. The
  // decoded config says it exists, which is the whole question, and answering it
  // from the parser rather than the file text is what removed the need to know
  // any TOML beyond how to render a value.
  test.each([
    ["dotted keys", 'workers.api.runtime = "node"\n'],
    ["an inline table", 'workers = { api = { runtime = "node" } }\n'],
    ["a value spanning lines", '[workers.api]\nruntime = [\n  "node",\n]\n'],
    ["a header inside a multiline string", 'notes = """\n[workers.api]\nstill inside"""\n'],
  ])("refuses an entry written as %s without reading the file text", async (_label, before) => {
    writeFileSync(configPath, before);

    const error = await run(
      writeWorkerEntry({
        configPath,
        name: "api",
        existingWorkers: { api: { runtime: "node" } },
        patch: { runtime: "node" },
      }).pipe(Effect.provide(BunServices.layer), Effect.flip),
    );

    expect(error).toBeInstanceOf(WorkerAlreadyConfiguredError);
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  // An inline `[workers]` is sealed: TOML forbids extending it, so appending
  // `[workers.api]` renders a file nothing can parse. The name is absent from
  // the decoded section, so the already-configured check cannot catch this —
  // reading the rendered plan back is what does.
  test.each([
    ["an empty inline workers table", "workers = {}\n"],
    [
      "an inline workers table holding another worker",
      'workers = { web = { runtime = "node" } }\n',
    ],
  ])("refuses to append to %s, leaving the file alone", async (_label, before) => {
    writeFileSync(configPath, before);

    const error = await run(
      writeWorkerEntry({
        configPath,
        name: "api",
        existingWorkers: {},
        patch: { runtime: "node" },
      }).pipe(Effect.provide(BunServices.layer), Effect.flip),
    );

    expect(error).toBeInstanceOf(WorkerConfigWriteUnsafeError);
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  // The backstop is not limited to the inline case: a config.toml that does not
  // parse to begin with cannot be appended to safely either, and finding that
  // out after the scaffold is written is exactly what the plan/commit split
  // exists to avoid.
  test("refuses a config.toml that does not parse, leaving the file alone", async () => {
    const before = "this is not = = toml\n";
    writeFileSync(configPath, before);

    const error = await run(
      writeWorkerEntry({
        configPath,
        name: "api",
        existingWorkers: {},
        patch: { runtime: "node" },
      }).pipe(Effect.provide(BunServices.layer), Effect.flip),
    );

    expect(error).toBeInstanceOf(WorkerConfigWriteUnsafeError);
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  // Why rendering is separate from writing: `new` writes the starter files before
  // it records anything, so a failure that could only surface at the write would
  // leave a scaffold on disk that nothing records.
  test("renders without writing, and only writes when committed", async () => {
    writeFileSync(configPath, 'project_id = "demo"\n');

    const write = await Effect.runPromise(
      planWorkerEntry({
        configPath,
        name: "api",
        existingWorkers: {},
        patch: { runtime: "node" },
      }).pipe(Effect.provide(BunServices.layer)),
    );

    expect(write.text).toContain("[workers.api]");
    expect(readFileSync(configPath, "utf8")).toBe('project_id = "demo"\n');

    await run(commitWorkerEntry(write).pipe(Effect.provide(BunServices.layer)));
    expect(readFileSync(configPath, "utf8")).toContain("[workers.api]");
  });
});

describe("readWorkersSection blank values", () => {
  // Absent means the `public` default, so a blank `exposure` must not read as
  // absent — that would silently widen a worker whose config tried to say
  // something. `push` refuses the value instead.
  test("keeps an explicitly blank exposure so push can refuse it", () => {
    const section = readWorkersSection({ api: { runtime: "node", exposure: "" } });

    expect(section.workers["api"]?.exposure).toBe("");
  });

  // The mirror: nothing else here widens anything on absence — a missing
  // runtime is guessed, a missing size defaults, a missing source is the
  // conventional directory — so blank keeps collapsing to absent for those.
  test("still folds the other blank dials into absent", () => {
    const section = readWorkersSection({ api: { runtime: "", size: "", source: "" } });

    expect(section.workers["api"]).toMatchObject({
      runtime: undefined,
      size: undefined,
      source: undefined,
    });
  });
});

describe("readWorkersSection prototype safety", () => {
  // `constructor` is a valid DNS label, so it is a valid worker name. Read into
  // a plain `{}`, looking it up would return `Object.prototype.constructor` and
  // every caller would believe the worker was already configured.
  test.each([["constructor"], ["toString"], ["hasOwnProperty"]])(
    "reports %j as absent when it is absent",
    (name) => {
      const section = readWorkersSection({ api: { runtime: "node" } });
      expect(section.workers[name]).toBeUndefined();
    },
  );

  test("still reads a worker actually named constructor", () => {
    const section = readWorkersSection({ constructor: { runtime: "node" } });
    expect(section.workers["constructor"]).toEqual({
      runtime: "node",
      size: undefined,
      source: undefined,
    });
  });
});
