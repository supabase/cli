import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { useTempWorkdir, VALID_REF } from "../../../../tests/helpers/command-mocks.ts";
import { describeHostedConsent } from "../../../../tests/helpers/hosted-consent.ts";
import {
  NOTEBOOKS_PROJECT_REF,
  notebookListPage,
  notebookResource,
  notebooksProject,
  notebooksRoute,
  setupNotebooks,
} from "../../../../tests/helpers/notebooks.ts";
import {
  assertBlockDrift,
  assertPermissionDrift,
} from "../../../../tests/helpers/permission-drift.ts";
import { projectResponse } from "../../../../tests/helpers/permission-real-layers.ts";
import {
  NotebookFileError,
  NotebookNameConflictError,
  NotebookNotFoundError,
} from "../notebooks.errors.ts";
import { HostedMutationDeclinedError } from "../../../command-internal/hosted-consent/hosted-consent.errors.ts";
import { notebookCreate, notebookRead, notebooksList } from "../notebooks.shared.ts";
import { notebooksPushHandler as notebooksPush } from "./push.command.ts";
import { notebooksPush as notebooksPushCore } from "./push.handler.ts";
import type { NotebooksPushFlags } from "./push.command.ts";

const SALES_ID = "44444444-4444-4444-8444-444444444444";
const ERRORS_ID = "55555555-5555-4555-8555-555555555555";

const SALES_FILE = JSON.stringify({
  description: "Weekly revenue",
  favorite: true,
  content: { cells: [{ id: "cell-1", type: "database", sql: "select 1", row_limit: 10 }] },
});

function flags(overrides: Partial<NotebooksPushFlags> = {}): NotebooksPushFlags {
  return {
    notebookName: Option.none(),
    remote: Option.none(),
    projectRef: Option.none(),
    ...overrides,
  };
}

const temp = useTempWorkdir("supabase-notebooks-push-");

const jsonValue = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

function project() {
  return notebooksProject(temp.current);
}

describe("notebooks push", () => {
  it.effect("updates the notebook of that name and creates the ones with no match", () => {
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
      expect(http.routeKeys).toEqual([
        `GET ${notebooksRoute()}`,
        `POST ${notebooksRoute()}`,
        `PATCH ${notebooksRoute(`/${SALES_ID}`)}`,
      ]);
      assertPermissionDrift({ command: "notebooks push", requests: http.driftRequests });
      assertBlockDrift(notebookCreate, {
        requests: http.driftRequests.filter((request) => request.method === "POST"),
        exact: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("pushes a single notebook by name without touching the rest", () => {
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
      assertPermissionDrift({
        command: "notebooks push",
        requests: http.driftRequests,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails when the named notebook is not in the notebooks directory", () => {
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
  it.effect("sends nothing when one of the files is not a notebook", () => {
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

  it.effect("deletes the project notebooks the directory does not have when asked to", () => {
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
      expect(http.routeKeys).toEqual([
        `GET ${notebooksRoute()}`,
        `PATCH ${notebooksRoute(`/${SALES_ID}`)}`,
        `DELETE ${notebooksRoute(`/${ERRORS_ID}`)}`,
      ]);
      assertPermissionDrift({ command: "notebooks push", requests: http.driftRequests });
    }).pipe(Effect.provide(layer));
  });

  it.effect("writes them into the notebooks directory instead when asked to", () => {
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
      expect(http.routeKeys).toEqual([
        `GET ${notebooksRoute()}`,
        `GET ${notebooksRoute(`/${ERRORS_ID}`)}`,
      ]);
      assertPermissionDrift({ command: "notebooks push", requests: http.driftRequests });
      assertBlockDrift(notebookRead, {
        requests: http.driftRequests.filter(
          (request) => new URL(request.url).pathname === notebooksRoute(`/${ERRORS_ID}`),
        ),
        exact: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("leaves both sides alone when there is nobody to ask", () => {
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
      assertPermissionDrift({ command: "notebooks push", requests: http.driftRequests });
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "success",
          data: expect.objectContaining({ created: [], updated: [], deleted: [] }),
        }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("picks the project, pushes its notebooks and records the linked project", () => {
    const repo = project();
    const { layer, http, out } = setupNotebooks({
      command: "push",
      workdir: repo.dir,
      realLayers: true,
      promptSelectResponses: [NOTEBOOKS_PROJECT_REF],
      routes: {
        "GET /v1/projects": { status: 200, body: [projectResponse(NOTEBOOKS_PROJECT_REF)] },
        [`GET /v1/projects/${NOTEBOOKS_PROJECT_REF}`]: {
          status: 200,
          body: projectResponse(NOTEBOOKS_PROJECT_REF),
        },
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
      const fs = yield* FileSystem.FileSystem;
      yield* repo.write("sales-dashboard", SALES_FILE);
      yield* notebooksPush(flags());

      expect(http.routeKeys).toEqual([
        "GET /v1/projects",
        `GET ${notebooksRoute()}`,
        `PATCH ${notebooksRoute(`/${SALES_ID}`)}`,
        `GET /v1/projects/${NOTEBOOKS_PROJECT_REF}`,
      ]);
      expect(out.promptSelectCalls).toHaveLength(1);
      expect(out.stdoutText).toContain("(0 created, 1 updated)");
      expect(yield* fs.exists(`${repo.dir}/supabase/.temp/linked-project.json`)).toBe(true);
      assertPermissionDrift({ command: "notebooks push", requests: http.driftRequests });
      assertBlockDrift(notebooksList, {
        requests: http.driftRequests.filter(
          (request) => new URL(request.url).pathname === notebooksRoute(),
        ),
        exact: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails instead of treating an unreadable notebooks path as empty", () => {
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

  it.effect("refuses an unsafe remote name before it can escape the notebooks directory", () => {
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
  it.effect("refuses a project holding two notebooks of the same name", () => {
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

  it.effect("emits the machine payload without text output", () => {
    const repo = project();
    const { layer, out } = setupNotebooks({
      command: "push",
      workdir: repo.dir,
      outputFlag: "json",
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

  it.effect("asks once for the uploads and the deletion, and changes nothing when declined", () => {
    const repo = project();
    const { layer, http, out } = setupNotebooks({
      command: "push",
      workdir: repo.dir,
      yes: false,
      promptSelectResponses: ["delete"],
      promptConfirmResponses: [false],
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
      },
    });

    return Effect.gen(function* () {
      yield* repo.write("kept", '{"content":{"cells":[]}}');
      const error = yield* notebooksPush(flags()).pipe(Effect.flip);

      expect(error).toBeInstanceOf(HostedMutationDeclinedError);
      expect(out.promptConfirmCalls).toHaveLength(1);
      expect(out.stderrText).toContain("Update kept");
      expect(out.stderrText).toContain("Delete stale");
      expect(http.routeKeys).toEqual([`GET ${notebooksRoute()}`]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("asks nothing when there is nothing to upload or delete", () => {
    const repo = project();
    const { layer, out } = setupNotebooks({
      command: "push",
      workdir: repo.dir,
      yes: false,
      routes: {
        [`GET ${notebooksRoute()}`]: { status: 200, body: notebookListPage({ notebooks: [] }) },
      },
    });

    return Effect.gen(function* () {
      yield* notebooksPush(flags());

      expect(out.promptConfirmCalls).toEqual([]);
      expect(out.stdoutText).toContain("No notebooks in");
    }).pipe(Effect.provide(layer));
  });
});

describeHostedConsent("notebooks push", {
  setup: (workdir) =>
    notebooksProject(workdir)
      .write("brand-new", '{"content":{"cells":[]}}')
      .pipe(Effect.provide(Path.layer)),
  invoke: ({ workdir }) => {
    const { http } = setupNotebooks({
      command: "push",
      workdir,
      routes: {
        [`GET ${notebooksRoute()}`]: { status: 200, body: notebookListPage({ notebooks: [] }) },
        [`POST ${notebooksRoute()}`]: {
          status: 201,
          body: { data: notebookResource({ id: ERRORS_ID, name: "brand-new" }) },
        },
      },
    });
    return {
      run: notebooksPushCore({
        notebookName: Option.none(),
        remote: Option.some({ _tag: "Ref", ref: VALID_REF }),
        projectRef: Option.none(),
      }).pipe(Effect.provide(http.layer)),
      mutations: () => http.requests.filter((request) => request.method !== "GET").length,
    };
  },
});
