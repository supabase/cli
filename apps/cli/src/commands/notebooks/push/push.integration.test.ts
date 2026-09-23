import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import {
  makeNotebooksProject,
  notebookListPage,
  notebookResource,
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

function project(files: Readonly<Record<string, string>> = {}) {
  const created = makeNotebooksProject(files);
  return {
    dir: created.dir,
    read: (name: string) =>
      readFileSync(join(created.dir, "supabase", "notebooks", `${name}.json`), "utf8"),
    exists: (name: string) =>
      existsSync(join(created.dir, "supabase", "notebooks", `${name}.json`)),
    cleanup: () => rmSync(created.dir, { recursive: true, force: true }),
  };
}

describe("notebooks push", () => {
  it.live("updates the notebook of that name and creates the ones with no match", () => {
    const repo = project({
      "supabase/notebooks/sales-dashboard.json": SALES_FILE,
      "supabase/notebooks/brand-new.json": '{"content":{"cells":[]}}',
    });
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
      yield* notebooksPush(flags());

      // Matched by name, so the existing notebook is updated in place rather
      // than duplicated.
      const patched = http.requests.find((request) => request.method === "PATCH");
      expect(JSON.parse(patched?.body ?? "{}")).toEqual({
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
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("pushes a single notebook by name without touching the rest", () => {
    const repo = project({
      "supabase/notebooks/sales-dashboard.json": SALES_FILE,
      "supabase/notebooks/other.json": '{"content":{"cells":[]}}',
    });
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
      yield* notebooksPush(flags({ notebookName: Option.some("sales-dashboard") }));

      expect(http.routeKeys).toEqual([
        `GET ${notebooksRoute()}`,
        `PATCH ${notebooksRoute(`/${SALES_ID}`)}`,
      ]);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
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
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // One unreadable file stops the whole push: the alternative is a project left
  // half-written, with no way to tell how far it got.
  it.live("sends nothing when one of the files is not a notebook", () => {
    const repo = project({
      "supabase/notebooks/good.json": '{"content":{"cells":[]}}',
      "supabase/notebooks/broken.json": "{ not json",
    });
    const { layer, http } = setupNotebooks({ command: "push", workdir: repo.dir });

    return Effect.gen(function* () {
      const error = yield* notebooksPush(flags()).pipe(Effect.flip);

      expect(error).toBeInstanceOf(NotebookFileError);
      expect(http.requests).toEqual([]);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("deletes the project notebooks the directory does not have when asked to", () => {
    const repo = project({ "supabase/notebooks/kept.json": '{"content":{"cells":[]}}' });
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
      yield* notebooksPush(flags());

      expect(http.routeKeys).toContain(`DELETE ${notebooksRoute(`/${ERRORS_ID}`)}`);
      expect(out.stderrText).toContain(" • stale");
      expect(out.stdoutText).toContain("Deleted 1 notebook(s) from the project.");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
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

      expect(repo.exists("error-rates")).toBe(true);
      expect(http.routeKeys).not.toContain(`DELETE ${notebooksRoute(`/${ERRORS_ID}`)}`);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
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
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("fails instead of treating an unreadable notebooks path as empty", () => {
    const repo = project({ "supabase/notebooks": "not a directory" });
    const { layer, http } = setupNotebooks({ command: "push", workdir: repo.dir });

    return Effect.gen(function* () {
      const error = yield* notebooksPush(flags()).pipe(Effect.flip);

      expect(error).toBeInstanceOf(NotebookFileError);
      expect(http.requests).toEqual([]);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
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
      const error = yield* notebooksPush(flags()).pipe(Effect.flip);

      expect(error).toBeInstanceOf(NotebookFileError);
      expect(existsSync(join(repo.dir, "supabase", "config.json"))).toBe(false);
      expect(http.routeKeys).toEqual([`GET ${notebooksRoute()}`]);
      expect(out.promptSelectCalls).toHaveLength(1);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // A directory of files cannot say which of two notebooks of one name it means,
  // and guessing would write one user's notebook over another's.
  it.live("refuses a project holding two notebooks of the same name", () => {
    const repo = project({ "supabase/notebooks/sales-dashboard.json": SALES_FILE });
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
      const error = yield* notebooksPush(flags()).pipe(Effect.flip);

      expect(error).toBeInstanceOf(NotebookNameConflictError);
      expect(http.routeKeys).toEqual([`GET ${notebooksRoute()}`]);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
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

      expect(JSON.parse(out.stdoutText)).toEqual(
        expect.objectContaining({ created: [], updated: [], deleted: [], pulled: [] }),
      );
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });
});
