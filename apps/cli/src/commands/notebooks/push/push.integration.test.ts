import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { useTempWorkdir } from "../../../../tests/helpers/command-mocks.ts";
import {
  notebookListPage,
  notebookResource,
  notebooksProject,
  notebooksRoute,
  setupNotebooks,
} from "../../../../tests/helpers/notebooks.ts";
import {
  NotebookFileError,
  NotebookNameConflictError,
  NotebookNotFoundError,
} from "../notebooks.errors.ts";
import { notebooksPushHandler as notebooksPush } from "./push.command.ts";
import type { NotebooksPushFlags } from "./push.command.ts";

const SALES_ID = "44444444-4444-4444-8444-444444444444";
const ERRORS_ID = "55555555-5555-4555-8555-555555555555";

const SALES_FILE = JSON.stringify({
  description: "Weekly revenue",
  favorite: true,
  content: { cells: [{ id: "cell-1", type: "database", sql: "select 1", row_limit: 10 }] },
});

function flags(overrides: Partial<NotebooksPushFlags> = {}): NotebooksPushFlags {
  return { notebookName: Option.none(), projectRef: Option.none(), ...overrides };
}

const temp = useTempWorkdir("supabase-notebooks-push-");

const jsonValue = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

function project() {
  return notebooksProject(temp.current);
}

describe("notebooks push", () => {
  it.live("updates the notebook of that name and creates the ones with no match", () => {
    const repo = project();
    const { layer, http, out } = setupNotebooks({
      command: "push",
      workdir: repo.dir,
      routes: {
        [`GET ${notebooksRoute()}`]: {
          status: 200,
          body: notebookListPage({ notebooks: [{ id: SALES_ID, name: "sales-dashboard" }] }),
        },
        [`PATCH ${notebooksRoute(`/${SALES_ID}`)}`]: {
          status: 200,
          body: { data: notebookResource({ id: SALES_ID, name: "sales-dashboard" }) },
        },
        [`POST ${notebooksRoute()}`]: {
          status: 201,
          body: { data: notebookResource({ id: ERRORS_ID, name: "brand-new" }) },
        },
      },
    });

    return Effect.gen(function* () {
      yield* repo.write("sales-dashboard", SALES_FILE);
      yield* repo.write("brand-new", '{"content":{"cells":[]}}');
      yield* notebooksPush(flags());

      // Matched by name, so the existing notebook is updated in place rather
      // than duplicated.
      const patched = http.requests.find((request) => request.method === "PATCH");
      expect(yield* jsonValue(patched?.body ?? "{}")).toEqual({
        data: {
          type: "notebook",
          attributes: {
            name: "sales-dashboard",
            description: "Weekly revenue",
            favorite: true,
            content: {
              cells: [{ id: "cell-1", type: "database", sql: "select 1", row_limit: 10 }],
            },
          },
        },
      });
      expect(http.requests.filter((request) => request.method === "POST")).toHaveLength(1);
      expect(out.stdoutText).toContain("(1 created, 1 updated)");
    }).pipe(Effect.provide(layer));
  });

  it.live("pushes a single notebook by name without touching the rest", () => {
    const repo = project();
    const { layer, http } = setupNotebooks({
      command: "push",
      workdir: repo.dir,
      routes: {
        [`GET ${notebooksRoute()}`]: {
          status: 200,
          body: notebookListPage({ notebooks: [{ id: SALES_ID, name: "sales-dashboard" }] }),
        },
        [`PATCH ${notebooksRoute(`/${SALES_ID}`)}`]: {
          status: 200,
          body: { data: notebookResource({ id: SALES_ID, name: "sales-dashboard" }) },
        },
      },
    });

    return Effect.gen(function* () {
      yield* repo.write("sales-dashboard", SALES_FILE);
      yield* repo.write("other", '{"content":{"cells":[]}}');
      yield* notebooksPush(flags({ notebookName: Option.some("sales-dashboard") }));

      expect(http.routeKeys).toEqual([
        `GET ${notebooksRoute()}`,
        `PATCH ${notebooksRoute(`/${SALES_ID}`)}`,
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when the named notebook is not in the notebooks directory", () => {
    const repo = project();
    const { layer, http } = setupNotebooks({ command: "push", workdir: repo.dir });

    return Effect.gen(function* () {
      const error = yield* notebooksPush(flags({ notebookName: Option.some("nope") })).pipe(
        Effect.flip,
      );

      expect(error).toBeInstanceOf(NotebookNotFoundError);
      // Refused before the project was read, let alone written.
      expect(http.requests).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  // One unreadable file stops the whole push: the alternative is a project left
  // half-written, with no way to tell how far it got.
  it.live("sends nothing when one of the files is not a notebook", () => {
    const repo = project();
    const { layer, http } = setupNotebooks({ command: "push", workdir: repo.dir });

    return Effect.gen(function* () {
      yield* repo.write("good", '{"content":{"cells":[]}}');
      yield* repo.write("broken", "{ not json");
      const error = yield* notebooksPush(flags()).pipe(Effect.flip);

      expect(error).toBeInstanceOf(NotebookFileError);
      expect(http.requests).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.live("deletes the project notebooks the directory does not have when asked to", () => {
    const repo = project();
    const { layer, http, out } = setupNotebooks({
      command: "push",
      workdir: repo.dir,
      promptSelectResponses: ["delete"],
      routes: {
        [`GET ${notebooksRoute()}`]: {
          status: 200,
          body: notebookListPage({
            notebooks: [
              { id: SALES_ID, name: "kept" },
              { id: ERRORS_ID, name: "stale" },
            ],
          }),
        },
        [`PATCH ${notebooksRoute(`/${SALES_ID}`)}`]: {
          status: 200,
          body: { data: notebookResource({ id: SALES_ID, name: "kept" }) },
        },
        [`DELETE ${notebooksRoute(`/${ERRORS_ID}`)}`]: { status: 204 },
      },
    });

    return Effect.gen(function* () {
      yield* repo.write("kept", '{"content":{"cells":[]}}');
      yield* notebooksPush(flags());

      expect(http.routeKeys).toContain(`DELETE ${notebooksRoute(`/${ERRORS_ID}`)}`);
      expect(out.stderrText).toContain(" • stale");
      expect(out.stdoutText).toContain("Deleted 1 notebook(s) from the project.");
    }).pipe(Effect.provide(layer));
  });

  it.live("writes them into the notebooks directory instead when asked to", () => {
    const repo = project();
    const { layer, http } = setupNotebooks({
      command: "push",
      workdir: repo.dir,
      promptSelectResponses: ["copy"],
      routes: {
        [`GET ${notebooksRoute()}`]: {
          status: 200,
          body: notebookListPage({ notebooks: [{ id: ERRORS_ID, name: "error-rates" }] }),
        },
        [`GET ${notebooksRoute(`/${ERRORS_ID}`)}`]: {
          status: 200,
          body: { data: notebookResource({ id: ERRORS_ID, name: "error-rates" }) },
        },
      },
    });

    return Effect.gen(function* () {
      yield* notebooksPush(flags());

      expect(yield* repo.exists("error-rates")).toBe(true);
      expect(http.routeKeys).not.toContain(`DELETE ${notebooksRoute(`/${ERRORS_ID}`)}`);
    }).pipe(Effect.provide(layer));
  });

  it.live("leaves both sides alone when there is nobody to ask", () => {
    const repo = project();
    const { layer, http, out } = setupNotebooks({
      command: "push",
      workdir: repo.dir,
      format: "json",
      routes: {
        [`GET ${notebooksRoute()}`]: {
          status: 200,
          body: notebookListPage({ notebooks: [{ id: ERRORS_ID, name: "error-rates" }] }),
        },
      },
    });

    return Effect.gen(function* () {
      yield* notebooksPush(flags());

      expect(out.promptSelectCalls).toHaveLength(0);
      expect(http.routeKeys).toEqual([`GET ${notebooksRoute()}`]);
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "success",
          data: expect.objectContaining({ created: [], updated: [], deleted: [] }),
        }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("fails instead of treating an unreadable notebooks path as empty", () => {
    const repo = project();
    const { layer, http } = setupNotebooks({ command: "push", workdir: repo.dir });

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.join(repo.dir, "supabase"), { recursive: true });
      yield* fs.writeFileString(path.join(repo.dir, "supabase", "notebooks"), "not a directory");
      const error = yield* notebooksPush(flags()).pipe(Effect.flip);

      expect(error).toBeInstanceOf(NotebookFileError);
      expect(http.requests).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.live("refuses an unsafe remote name before it can escape the notebooks directory", () => {
    const repo = project();
    const { layer, http, out } = setupNotebooks({
      command: "push",
      workdir: repo.dir,
      promptSelectResponses: ["copy"],
      routes: {
        [`GET ${notebooksRoute()}`]: {
          status: 200,
          body: notebookListPage({ notebooks: [{ id: ERRORS_ID, name: "../config" }] }),
        },
      },
    });

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const error = yield* notebooksPush(flags()).pipe(Effect.flip);

      expect(error).toBeInstanceOf(NotebookFileError);
      expect(yield* fs.exists(path.join(repo.dir, "supabase", "config.json"))).toBe(false);
      expect(http.routeKeys).toEqual([`GET ${notebooksRoute()}`]);
      expect(out.promptSelectCalls).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  // A directory of files cannot say which of two notebooks of one name it means,
  // and guessing would write one user's notebook over another's.
  it.live("refuses a project holding two notebooks of the same name", () => {
    const repo = project();
    const { layer, http } = setupNotebooks({
      command: "push",
      workdir: repo.dir,
      routes: {
        [`GET ${notebooksRoute()}`]: {
          status: 200,
          body: notebookListPage({
            notebooks: [
              { id: SALES_ID, name: "sales-dashboard" },
              { id: ERRORS_ID, name: "sales-dashboard" },
            ],
          }),
        },
      },
    });

    return Effect.gen(function* () {
      yield* repo.write("sales-dashboard", SALES_FILE);
      const error = yield* notebooksPush(flags()).pipe(Effect.flip);

      expect(error).toBeInstanceOf(NotebookNameConflictError);
      expect(http.routeKeys).toEqual([`GET ${notebooksRoute()}`]);
    }).pipe(Effect.provide(layer));
  });

  it.live("emits the machine payload without text output", () => {
    const repo = project();
    const { layer, out } = setupNotebooks({
      command: "push",
      workdir: repo.dir,
      goOutput: "json",
      routes: {
        [`GET ${notebooksRoute()}`]: { status: 200, body: notebookListPage({ notebooks: [] }) },
      },
    });

    return Effect.gen(function* () {
      yield* notebooksPush(flags());

      expect(yield* jsonValue(out.stdoutText)).toEqual(
        expect.objectContaining({ created: [], updated: [], deleted: [], pulled: [] }),
      );
    }).pipe(Effect.provide(layer));
  });
});
