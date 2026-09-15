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
import { NotebookIdError, NotebookNameConflictError } from "../notebooks.errors.ts";
import { notebooksPullHandler as notebooksPull } from "./pull.command.ts";
import type { NotebooksPullFlags } from "./pull.command.ts";

const SALES_ID = "44444444-4444-4444-8444-444444444444";
const ERRORS_ID = "55555555-5555-4555-8555-555555555555";

function flags(overrides: Partial<NotebooksPullFlags> = {}): NotebooksPullFlags {
  return { notebookId: Option.none(), projectRef: Option.none(), ...overrides };
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

describe("notebooks pull", () => {
  it.live("writes missing project notebooks without replacing local notebooks", () => {
    const localSales = '{"content":{"cells":[{"type":"markdown","text":"# Local"}]}}';
    const repo = project({ "supabase/notebooks/sales-dashboard.json": localSales });
    const { layer, http, out } = setupNotebooks({
      workdir: repo.dir,
      routes: {
        [`GET ${notebooksRoute()}`]: {
          status: 200,
          body: notebookListPage({
            notebooks: [
              { id: SALES_ID, name: "sales-dashboard" },
              { id: ERRORS_ID, name: "error-rates" },
            ],
          }),
        },
        [`GET ${notebooksRoute(`/${ERRORS_ID}`)}`]: {
          status: 200,
          body: {
            data: notebookResource({
              id: ERRORS_ID,
              name: "error-rates",
              cells: [{ id: "cell-1", type: "database", sql: "select 1", row_limit: 100 }],
            }),
          },
        },
      },
    });

    return Effect.gen(function* () {
      yield* notebooksPull(flags());

      expect(repo.read("sales-dashboard")).toBe(localSales);
      // A newly downloaded file is the notebook's attributes minus its name and
      // the server-owned `schema_version`.
      expect(JSON.parse(repo.read("error-rates"))).toEqual({
        favorite: false,
        content: { cells: [{ id: "cell-1", type: "database", sql: "select 1", row_limit: 100 }] },
      });
      expect(http.routeKeys).toEqual([
        `GET ${notebooksRoute()}`,
        `GET ${notebooksRoute(`/${ERRORS_ID}`)}`,
      ]);
      expect(out.stdoutText).toContain("Pulled 1 notebook(s)");
      expect(out.stdoutText).toContain("Kept 1 existing local notebook(s) unchanged.");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("replaces a single local notebook by id without listing or reconciling", () => {
    const repo = project({
      "supabase/notebooks/sales-dashboard.json":
        '{"content":{"cells":[{"type":"markdown","text":"# Local"}]}}',
      "supabase/notebooks/leftover.json": '{"content":{"cells":[]}}',
    });
    const { layer, http } = setupNotebooks({
      workdir: repo.dir,
      routes: {
        [`GET ${notebooksRoute(`/${SALES_ID}`)}`]: {
          status: 200,
          body: { data: notebookResource({ id: SALES_ID, name: "sales-dashboard" }) },
        },
      },
    });

    return Effect.gen(function* () {
      yield* notebooksPull(flags({ notebookId: Option.some(SALES_ID) }));

      expect(JSON.parse(repo.read("sales-dashboard"))).toEqual({
        favorite: false,
        content: { cells: [{ id: "cell-1", type: "markdown", text: "# Hello" }] },
      });
      expect(repo.exists("leftover")).toBe(true);
      expect(http.routeKeys).toEqual([`GET ${notebooksRoute(`/${SALES_ID}`)}`]);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("rejects a non-UUID notebook id before calling the API", () => {
    const repo = project();
    const { layer, http } = setupNotebooks({ workdir: repo.dir });

    return Effect.gen(function* () {
      const error = yield* notebooksPull(flags({ notebookId: Option.some("nope") })).pipe(
        Effect.flip,
      );

      expect(error).toBeInstanceOf(NotebookIdError);
      expect(http.requests).toEqual([]);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("deletes the local notebooks the project does not have when asked to", () => {
    const repo = project({ "supabase/notebooks/gone.json": '{"content":{"cells":[]}}' });
    const { layer, out } = setupNotebooks({
      workdir: repo.dir,
      promptSelectResponses: ["delete"],
      routes: {
        [`GET ${notebooksRoute()}`]: { status: 200, body: notebookListPage({ notebooks: [] }) },
      },
    });

    return Effect.gen(function* () {
      yield* notebooksPull(flags());

      expect(repo.exists("gone")).toBe(false);
      expect(out.stderrText).toContain("1 local notebook(s) are not in the project:");
      expect(out.stderrText).toContain(" • gone");
      expect(out.promptSelectCalls.map((call) => call.message)).toEqual([
        "What should happen to them?",
      ]);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("creates the local notebooks in the project instead when asked to", () => {
    const repo = project({
      "supabase/notebooks/new-one.json":
        '{"content":{"cells":[{"type":"markdown","text":"# New"}]}}',
    });
    const { layer, http } = setupNotebooks({
      workdir: repo.dir,
      promptSelectResponses: ["copy"],
      routes: {
        [`GET ${notebooksRoute()}`]: { status: 200, body: notebookListPage({ notebooks: [] }) },
        [`POST ${notebooksRoute()}`]: {
          status: 201,
          body: { data: notebookResource({ id: SALES_ID, name: "new-one" }) },
        },
      },
    });

    return Effect.gen(function* () {
      yield* notebooksPull(flags());

      expect(repo.exists("new-one")).toBe(true);
      const created = http.requests.find((request) => request.method === "POST");
      // The name goes up from the file name, and the cells go up as written.
      expect(JSON.parse(created?.body ?? "{}")).toEqual({
        data: {
          type: "notebook",
          attributes: {
            name: "new-one",
            content: { cells: [{ type: "markdown", text: "# New" }] },
          },
        },
      });
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // Both other answers delete something, so an unattended run reports the
  // divergence and resolves nothing.
  it.live("leaves both sides alone when there is nobody to ask", () => {
    const repo = project({ "supabase/notebooks/gone.json": '{"content":{"cells":[]}}' });
    const { layer, out } = setupNotebooks({
      workdir: repo.dir,
      format: "json",
      routes: {
        [`GET ${notebooksRoute()}`]: { status: 200, body: notebookListPage({ notebooks: [] }) },
      },
    });

    return Effect.gen(function* () {
      yield* notebooksPull(flags());

      expect(repo.exists("gone")).toBe(true);
      expect(out.promptSelectCalls).toHaveLength(0);
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "success",
          data: expect.objectContaining({ pulled: [], deleted_locally: [], created: [] }),
        }),
      );
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // `page[after]` has to reach the wire as its own query parameter, or the
  // second page is the first one again and the walk never ends.
  it.live("follows the cursor the list route hands back", () => {
    const repo = project();
    const { layer, http } = setupNotebooks({
      workdir: repo.dir,
      routes: {
        [`GET ${notebooksRoute()}`]: [
          {
            status: 200,
            body: notebookListPage({
              notebooks: [{ id: SALES_ID, name: "sales-dashboard" }],
              next: `${notebooksRoute()}?page[size]=100&page[after]=cursor-1`,
            }),
          },
          {
            status: 200,
            body: notebookListPage({ notebooks: [{ id: ERRORS_ID, name: "error-rates" }] }),
          },
        ],
        [`GET ${notebooksRoute(`/${SALES_ID}`)}`]: {
          status: 200,
          body: { data: notebookResource({ id: SALES_ID, name: "sales-dashboard" }) },
        },
        [`GET ${notebooksRoute(`/${ERRORS_ID}`)}`]: {
          status: 200,
          body: { data: notebookResource({ id: ERRORS_ID, name: "error-rates" }) },
        },
      },
    });

    return Effect.gen(function* () {
      yield* notebooksPull(flags());

      expect(repo.exists("sales-dashboard")).toBe(true);
      expect(repo.exists("error-rates")).toBe(true);
      const listCalls = http.requests.filter(
        (request) => new URL(request.url).pathname === notebooksRoute(),
      );
      expect(listCalls).toHaveLength(2);
      // `page` is a `style: deepObject` parameter, so it has to arrive expanded
      // rather than as one JSON blob.
      expect(listCalls[0]!.query.get("page[size]")).toBe("100");
      expect(listCalls[0]!.query.get("page[after]")).toBeNull();
      expect(listCalls[1]!.query.get("page[after]")).toBe("cursor-1");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("skips a notebook whose name cannot be a file name", () => {
    const repo = project();
    const { layer, out } = setupNotebooks({
      workdir: repo.dir,
      routes: {
        [`GET ${notebooksRoute()}`]: {
          status: 200,
          body: notebookListPage({ notebooks: [{ id: SALES_ID, name: "reports/weekly" }] }),
        },
      },
    });

    return Effect.gen(function* () {
      yield* notebooksPull(flags());

      expect(out.stderrText).toContain("Skipped 1 notebook(s)");
      // Nothing was read, so nothing could have been written outside the dir.
      expect(out.stdoutText).toContain("No notebooks to pull.");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("refuses duplicate remote names before writing either notebook", () => {
    const repo = project();
    const { layer, http } = setupNotebooks({
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
      const error = yield* notebooksPull(flags()).pipe(Effect.flip);

      expect(error).toBeInstanceOf(NotebookNameConflictError);
      expect(repo.exists("sales-dashboard")).toBe(false);
      expect(http.routeKeys).toEqual([`GET ${notebooksRoute()}`]);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("emits the machine payload without text output", () => {
    const repo = project();
    const { layer, out } = setupNotebooks({
      workdir: repo.dir,
      goOutput: "json",
      routes: {
        [`GET ${notebooksRoute()}`]: { status: 200, body: notebookListPage({ notebooks: [] }) },
      },
    });

    return Effect.gen(function* () {
      yield* notebooksPull(flags());

      expect(JSON.parse(out.stdoutText)).toEqual(
        expect.objectContaining({ pulled: [], preserved_locally: [], skipped: 0 }),
      );
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });
});
