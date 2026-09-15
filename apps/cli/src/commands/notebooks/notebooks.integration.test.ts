import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, FileSystem, Option } from "effect";
import {
  notebookListPage,
  notebookResource,
  notebooksRoute,
  NOTEBOOKS_PROJECT_REF,
  setupNotebooks,
  type NotebooksSetupOptions,
} from "../../../tests/helpers/notebooks.ts";
import { useTempWorkdir } from "../../../tests/helpers/command-mocks.ts";
import { Output } from "../../shared/output/output.service.ts";
import { NonInteractiveError } from "../../shared/output/errors.ts";
import {
  EventCommandExecuted,
  PropExitCode,
  PropFlags,
} from "../../shared/telemetry/event-catalog.ts";
import {
  NotebookFileError,
  NotebookNameConflictError,
  NotebooksNetworkError,
  NotebooksPaginationError,
} from "./notebooks.errors.ts";
import { notebooksPullHandler } from "./pull/pull.command.ts";

const temp = useTempWorkdir("supabase-notebooks-regression-");
const ID = "44444444-4444-4444-8444-444444444444";
const OTHER_ID = "55555555-5555-4555-8555-555555555555";
const LOCAL = '{"content":{"cells":[{"type":"markdown","text":"local edits"}]}}';
const commands = ["pull"] as const;
type Command = (typeof commands)[number];

const run = Effect.fnUntraced(function* (
  command: Command,
  name?: string,
  projectRef: Option.Option<string> = Option.some(NOTEBOOKS_PROJECT_REF),
) {
  return yield* notebooksPullHandler({
    projectRef,
    notebookId: Option.fromUndefinedOr(name),
  });
});

function setup(command: Command, options: Omit<NotebooksSetupOptions, "workdir" | "command"> = {}) {
  return setupNotebooks({
    workdir: temp.current,
    command,
    args: ["notebooks", command, "--project-ref", NOTEBOOKS_PROJECT_REF],
    routes: {
      [`GET ${notebooksRoute()}`]: { status: 200, body: notebookListPage({ notebooks: [] }) },
    },
    ...options,
  });
}

function write(name: string, contents = LOCAL) {
  const dir = join(temp.current, "supabase", "notebooks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), contents);
}

function read(name: string) {
  return readFileSync(join(temp.current, "supabase", "notebooks", `${name}.json`), "utf8");
}

function remote(name: string, id = ID) {
  return { id, name };
}

function list(notebooks: ReadonlyArray<{ id: string; name: string }>) {
  return { status: 200, body: notebookListPage({ notebooks }) };
}

function downloaded(name: string, id = ID) {
  return { status: 200, body: { data: notebookResource({ id, name }) } };
}

describe("notebook file preservation", () => {
  it.live.each([
    { local: "Sales", name: "sales" },
    { local: "café", name: "cafe\u0301" },
  ])("refuses local filename aliases $local / $name before downloading", ({ local, name }) => {
    write(local);
    const { layer, http } = setup("pull", {
      routes: { [`GET ${notebooksRoute()}`]: list([remote(name)]) },
    });
    return Effect.gen(function* () {
      const error = yield* run("pull").pipe(Effect.flip);
      expect(error).toBeInstanceOf(NotebookNameConflictError);
      expect(read(local)).toBe(LOCAL);
      expect(http.requests).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.live("refuses colliding remote filenames before writing any notebook", () => {
    const { layer, http } = setup("pull", {
      routes: { [`GET ${notebooksRoute()}`]: list([remote("Sales"), remote("sales", OTHER_ID)]) },
    });
    return Effect.gen(function* () {
      expect(yield* run("pull").pipe(Effect.flip)).toBeInstanceOf(NotebookNameConflictError);
      expect(http.requests).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.live.each(["a".repeat(210), "b".repeat(250), "é".repeat(125)])(
    "pulls long filenames and removes temporary artifacts (%s)",
    (name) => {
      const { layer } = setup("pull", {
        routes: {
          [`GET ${notebooksRoute()}`]: list([remote(name)]),
          [`GET ${notebooksRoute(`/${ID}`)}`]: downloaded(name),
        },
      });
      return Effect.gen(function* () {
        yield* run("pull");
        expect(JSON.parse(read(name)).content.cells).toHaveLength(1);
        expect(readdirSync(join(temp.current, "supabase", "notebooks"))).toEqual([`${name}.json`]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("skips unsupported portable filenames without attempting downloads", () => {
    const names = [
      "CON",
      "nul.backup",
      "LPT1",
      "COM¹",
      "report:2026",
      "report?",
      "trailing.",
      "trailing ",
      "a".repeat(251),
      "é".repeat(126),
    ];
    const { layer, http, out } = setup("pull", {
      format: "json",
      routes: {
        [`GET ${notebooksRoute()}`]: list(names.map((name, index) => remote(name, String(index)))),
      },
    });
    return Effect.gen(function* () {
      yield* run("pull");
      expect(http.requests).toHaveLength(1);
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "success",
          data: expect.objectContaining({ skipped: names.length }),
        }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("preserves a file created after the pull inventory was read", () => {
    const { layer, cache, telemetry } = setup("pull", {
      routes: {
        [`GET ${notebooksRoute()}`]: list([remote("sales")]),
        [`GET ${notebooksRoute(`/${ID}`)}`]: downloaded("sales"),
      },
    });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const error = yield* run("pull").pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          link: (source, destination) =>
            fs
              .writeFileString(destination, LOCAL)
              .pipe(Effect.andThen(fs.link(source, destination))),
        }),
        Effect.flip,
      );
      expect(error).toBeInstanceOf(NotebookFileError);
      expect(read("sales")).toBe(LOCAL);
      expect(readdirSync(join(temp.current, "supabase", "notebooks"))).toEqual(["sales.json"]);
      expect(cache.cacheCount).toBe(1);
      expect(telemetry.flushCount).toBe(1);
    }).pipe(Effect.provide(layer));
  });

  it.live("cleans temporary files when a pull is interrupted before publication", () => {
    const { layer, cache, telemetry } = setup("pull", {
      routes: {
        [`GET ${notebooksRoute()}`]: list([remote("sales")]),
        [`GET ${notebooksRoute(`/${ID}`)}`]: downloaded("sales"),
      },
    });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const publishing = yield* Deferred.make<void>();
      const fiber = yield* run("pull").pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          link: () => Deferred.succeed(publishing, undefined).pipe(Effect.andThen(Effect.never)),
        }),
        Effect.forkChild,
      );
      yield* Deferred.await(publishing);
      yield* Fiber.interrupt(fiber);
      expect(readdirSync(join(temp.current, "supabase", "notebooks"))).toEqual([]);
      expect(cache.cacheCount).toBe(1);
      expect(telemetry.flushCount).toBe(1);
    }).pipe(Effect.provide(layer));
  });
});

describe("notebook reconciliation preflight", () => {
  it.live("reports a failed local deletion without losing the notebook", () => {
    write("sales");
    const { layer, cache, telemetry } = setup("pull", { promptSelectResponses: ["delete"] });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const error = yield* run("pull").pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          remove: (path) => fs.remove(join(path, "not-a-directory")),
        }),
        Effect.flip,
      );
      expect(error).toBeInstanceOf(NotebookFileError);
      expect(read("sales")).toBe(LOCAL);
      expect(cache.cacheCount).toBe(1);
      expect(telemetry.flushCount).toBe(1);
    }).pipe(Effect.provide(layer));
  });

  it.live("validates all local files before creating any during pull reconciliation", () => {
    write("a-good");
    write("z-broken", "{}");
    const { layer, http } = setup("pull", { promptSelectResponses: ["copy"] });
    return Effect.gen(function* () {
      expect(yield* run("pull").pipe(Effect.flip)).toBeInstanceOf(NotebookFileError);
      expect(http.requests).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.live.each(commands)("leaves divergence alone when the %s prompt is cancelled", (command) => {
    write("local");
    const { layer, http, cache, telemetry } = setup(command, {
      routes: { [`GET ${notebooksRoute()}`]: list([]) },
    });
    return Effect.gen(function* () {
      const output = yield* Output;
      yield* run(command).pipe(
        Effect.provideService(Output, {
          ...output,
          promptSelect: () =>
            Effect.fail(new NonInteractiveError({ detail: "context canceled", suggestion: "" })),
        }),
      );
      expect(http.requests).toHaveLength(1);
      expect(cache.cacheCount).toBe(1);
      expect(telemetry.flushCount).toBe(1);
    }).pipe(Effect.provide(layer));
  });
});

describe.each(commands)("notebooks %s command wiring", (command) => {
  it.live.each([
    { status: 200, transportError: "ECONNRESET" },
    { status: 200, body: { invalid: "response" } },
  ])("reports transport and response failures and stops progress", (response) => {
    const { layer, cache, telemetry, analytics } = setup(command, {
      routes: { [`GET ${notebooksRoute()}`]: response },
    });
    return Effect.gen(function* () {
      const output = yield* Output;
      let failed = 0;
      const error = yield* run(command).pipe(
        Effect.provideService(Output, {
          ...output,
          task: (message) =>
            output.task(message).pipe(
              Effect.map((task) => ({
                ...task,
                fail: () =>
                  Effect.sync(() => {
                    failed += 1;
                  }),
              })),
            ),
        }),
        Effect.flip,
      );
      expect(error).toBeInstanceOf(NotebooksNetworkError);
      expect(failed).toBe(1);
      expect(cache.cacheCount).toBe(1);
      expect(telemetry.flushCount).toBe(1);
      expect(analytics.captured).toContainEqual({
        event: EventCommandExecuted,
        properties: expect.objectContaining({ [PropExitCode]: 1 }),
      });
    }).pipe(Effect.provide(layer));
  });

  it.live.each([{ interactive: false }, { goOutput: "json" as const }])(
    "keeps divergence without prompting in unattended text output (%j)",
    (options) => {
      write("local");
      const { layer, out, http } = setup(command, {
        ...options,
        routes: { [`GET ${notebooksRoute()}`]: list([]) },
      });
      return Effect.gen(function* () {
        yield* run(command);
        expect(out.promptSelectCalls).toEqual([]);
        expect(http.requests).toHaveLength(1);
        expect(out.stderrText).toContain("Left alone");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("flushes telemetry when project resolution fails", () => {
    const { layer, cache, telemetry, http } = setup(command, { linked: false });
    return Effect.gen(function* () {
      const exit = yield* run(command, undefined, Option.none()).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(cache.cacheCount).toBe(0);
      expect(telemetry.flushCount).toBe(1);
      expect(http.requests).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.live.each(["json", "stream-json"] as const)(
    "emits %s failures with a nonzero exit code and telemetry",
    (format) => {
      const { layer, out, process, analytics, cache, telemetry } = setup(command, {
        format,
        routes: { [`GET ${notebooksRoute()}`]: { status: 403, body: { message: "denied" } } },
      });
      return Effect.gen(function* () {
        yield* run(command);
        expect(process.exitCode).toBe(1);
        expect(out.messages).toContainEqual(
          expect.objectContaining({ type: "fail", message: expect.stringContaining("403") }),
        );
        expect(out.progressEvents).toEqual([]);
        expect(cache.cacheCount).toBe(1);
        expect(telemetry.flushCount).toBe(1);
        expect(analytics.captured).toContainEqual({
          event: EventCommandExecuted,
          properties: expect.objectContaining({
            [PropExitCode]: 1,
            [PropFlags]: { "project-ref": NOTEBOOKS_PROJECT_REF },
            command: `notebooks ${command}`,
          }),
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.live.each(["json", "stream-json"] as const)(
    "emits %s success without prompts or progress",
    (format) => {
      const { layer, out, analytics } = setup(command, { format });
      return Effect.gen(function* () {
        yield* run(command);
        expect(out.messages).toContainEqual(
          expect.objectContaining({
            type: "success",
            data: expect.objectContaining({ project_ref: NOTEBOOKS_PROJECT_REF }),
          }),
        );
        expect(out.promptSelectCalls).toEqual([]);
        expect(out.progressEvents).toEqual([]);
        expect(analytics.captured).toContainEqual({
          event: EventCommandExecuted,
          properties: expect.objectContaining({ [PropExitCode]: 0 }),
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.live.each(["json", "yaml", "toml"] as const)(
    "honors -o %s before --output-format and keeps stdout clean",
    (goOutput) => {
      const { layer, out } = setup(command, { goOutput, format: "stream-json" });
      return Effect.gen(function* () {
        yield* run(command);
        expect(out.stdoutText).toContain(NOTEBOOKS_PROJECT_REF);
        expect(out.messages).toEqual([]);
        expect(out.progressEvents).toEqual([]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live.each(["table", "csv", "env"] as const)(
    "rejects -o %s without reading or changing notebooks",
    (goOutput) => {
      const { layer, http, cache } = setup(command, { goOutput });
      return Effect.gen(function* () {
        expect(Exit.isFailure(yield* run(command).pipe(Effect.exit))).toBe(true);
        expect(http.requests).toEqual([]);
        expect(cache.cacheCount).toBe(0);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live.each([undefined, "", "cursor-a", "cycle"])(
    "fails closed for a missing or cyclic pagination cursor (%s)",
    (cursor) => {
      const next = (value: string | undefined) =>
        value === undefined ? notebooksRoute() : `${notebooksRoute()}?page[after]=${value}`;
      const cursors =
        cursor === "cycle"
          ? ["cursor-a", "cursor-b", "cursor-a"]
          : cursor === "cursor-a"
            ? [cursor, cursor]
            : [cursor];
      const { layer, http, out } = setup(command, {
        routes: {
          [`GET ${notebooksRoute()}`]: cursors.map((value) => ({
            status: 200,
            body: notebookListPage({ notebooks: [], next: next(value) }),
          })),
        },
      });
      return Effect.gen(function* () {
        expect(yield* run(command).pipe(Effect.flip)).toBeInstanceOf(NotebooksPaginationError);
        expect(http.requests).toHaveLength(cursors.length);
        expect(out.promptSelectCalls).toEqual([]);
      }).pipe(Effect.provide(layer));
    },
  );
});
