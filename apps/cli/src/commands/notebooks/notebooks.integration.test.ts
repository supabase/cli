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
import { notebooksPushHandler } from "./push/push.command.ts";

const temp = useTempWorkdir("supabase-notebooks-regression-");
const ID = "44444444-4444-4444-8444-444444444444";
const OTHER_ID = "55555555-5555-4555-8555-555555555555";
const LOCAL = '{"content":{"cells":[{"type":"markdown","text":"local edits"}]}}';
const commands = ["pull", "push"] as const;
type Command = (typeof commands)[number];

const run = Effect.fnUntraced(function* (
  command: Command,
  name?: string,
  projectRef: Option.Option<string> = Option.some(NOTEBOOKS_PROJECT_REF),
) {
  if (command === "pull")
    return yield* notebooksPullHandler({
      projectRef,
      notebookId: Option.fromUndefinedOr(name),
    });
  return yield* notebooksPushHandler({
    projectRef,
    notebookName: Option.fromUndefinedOr(name),
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
  it.live("round-trips notebook metadata, cell identities, charts, and log ranges", () => {
    const cells = [
      { id: "markdown-cell", type: "markdown", text: "# Report", collapsed: true },
      {
        id: "database-cell",
        type: "database",
        sql: "select 1",
        view: "chart",
        chart: {
          cumulative: false,
          scale: "linear",
          show_labels: true,
          type: "line",
          x_column: "time",
          y_series: [{ column: "count", color: "green" }],
        },
      },
      {
        id: "log-cell",
        type: "log",
        sql: "select timestamp from postgres_logs",
        time_range: {
          type: "absolute",
          start: "2026-01-01T00:00:00Z",
          end: "2026-01-02T00:00:00Z",
        },
      },
    ];
    const pulling = setup("pull", {
      routes: {
        [`GET ${notebooksRoute()}`]: list([remote("sales")]),
        [`GET ${notebooksRoute(`/${ID}`)}`]: {
          status: 200,
          body: {
            data: notebookResource({
              id: ID,
              name: "sales",
              description: "Shared report",
              favorite: true,
              cells,
            }),
          },
        },
      },
    });
    const pushing = setup("push", {
      routes: {
        [`GET ${notebooksRoute()}`]: list([remote("sales")]),
        [`PATCH ${notebooksRoute(`/${ID}`)}`]: downloaded("sales"),
      },
    });
    return Effect.gen(function* () {
      yield* run("pull").pipe(Effect.provide(pulling.layer));
      yield* run("push", "sales").pipe(Effect.provide(pushing.layer));
      const request = pushing.http.requests.find((entry) => entry.method === "PATCH");
      expect(JSON.parse(request?.body ?? "{}").data.attributes).toEqual({
        name: "sales",
        description: "Shared report",
        favorite: true,
        content: { cells },
      });
    });
  });

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
  it.live("reports a local read failure without uploading notebooks", () => {
    write("sales");
    const { layer, http } = setup("push");
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const error = yield* run("push").pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          readFileString: (path) => fs.readFileString(`${path}.missing`),
        }),
        Effect.flip,
      );
      expect(error).toBeInstanceOf(NotebookFileError);
      expect(read("sales")).toBe(LOCAL);
      expect(http.requests).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

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

  it.live.each(["keep", "delete"])(
    "can %s remote notebooks with unsupported filenames",
    (choice) => {
      write("sales");
      const { layer, http } = setup("push", {
        promptSelectResponses: [choice],
        routes: {
          [`GET ${notebooksRoute()}`]: list([remote("sales"), remote("reports/weekly", OTHER_ID)]),
          [`PATCH ${notebooksRoute(`/${ID}`)}`]: downloaded("sales"),
          [`DELETE ${notebooksRoute(`/${OTHER_ID}`)}`]: { status: 204 },
        },
      });
      return Effect.gen(function* () {
        yield* run("push");
        expect(http.requests.filter((request) => request.method === "PATCH")).toHaveLength(1);
        expect(http.requests.filter((request) => request.method === "DELETE")).toHaveLength(
          choice === "delete" ? 1 : 0,
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it.live.each(["reports/weekly", "Sales"])(
    "validates copying %s before uploading local edits",
    (name) => {
      write("sales");
      const { layer, http } = setup("push", {
        promptSelectResponses: ["copy"],
        routes: { [`GET ${notebooksRoute()}`]: list([remote("sales"), remote(name, OTHER_ID)]) },
      });
      return Effect.gen(function* () {
        expect(Exit.isFailure(yield* run("push").pipe(Effect.exit))).toBe(true);
        expect(read("sales")).toBe(LOCAL);
        expect(http.requests).toHaveLength(1);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("pushes a selected notebook despite unrelated duplicate names", () => {
    write("sales");
    const { layer, http } = setup("push", {
      routes: {
        [`GET ${notebooksRoute()}`]: list([
          remote("sales"),
          remote("other", OTHER_ID),
          remote("other", "66666666-6666-4666-8666-666666666666"),
        ]),
        [`PATCH ${notebooksRoute(`/${ID}`)}`]: downloaded("sales"),
      },
    });
    return Effect.gen(function* () {
      yield* run("push", "sales");
      expect(http.routeKeys).toEqual([
        `GET ${notebooksRoute()}`,
        `PATCH ${notebooksRoute(`/${ID}`)}`,
      ]);
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
    if (command === "pull") write("local");
    const { layer, http, cache, telemetry } = setup(command, {
      routes: { [`GET ${notebooksRoute()}`]: list(command === "push" ? [remote("remote")] : []) },
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
      if (command === "pull") write("local");
      const { layer, out, http } = setup(command, {
        ...options,
        routes: {
          [`GET ${notebooksRoute()}`]: list(command === "push" ? [remote("reports/weekly")] : []),
        },
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
