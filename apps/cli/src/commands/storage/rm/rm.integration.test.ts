import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach } from "vitest";

import { setupStorage } from "../../../../tests/helpers/storage.ts";
import { VALID_REF, useTempWorkdir } from "../../../../tests/helpers/command-mocks.ts";
import { storageRm } from "./rm.handler.ts";

function writeAncestorConfig(root: string, toml: string): void {
  const dir = join(root, "supabase");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.toml"), toml);
}

const BUCKET = "/storage/v1/bucket";
const DELETE_OBJECT = (bucket: string) => `/storage/v1/object/${bucket}`;
const DELETE_BUCKET = (bucket: string) => `/storage/v1/bucket/${bucket}`;
const LIST = (bucket: string) => `/storage/v1/object/list/${bucket}`;

function prefixCount(body: unknown): number {
  return typeof body === "object" &&
    body !== null &&
    Array.isArray((body as { prefixes?: unknown }).prefixes)
    ? (body as { prefixes: unknown[] }).prefixes.length
    : -1;
}

describe("storage rm", () => {
  const tmp = useTempWorkdir("supabase-storage-rm-");

  afterEach(() => {
    delete process.env["SUPABASE_YES"];
  });

  it.live("deletes multiple objects after confirmation", () => {
    const { layer, requests } = setupStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      yes: true,
      routes: [
        {
          method: "DELETE",
          match: DELETE_OBJECT("private"),
          body: [{ name: "abstract.pdf" }, { name: "docs/readme.md" }],
        },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* storageRm({
        files: ["ss:///private/abstract.pdf", "ss:///private/docs/readme.md"],
        recursive: false,
        linked: true,
        local: true,
        projectRef: Option.none(),
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      const del = requests.find(
        (r) => r.method === "DELETE" && r.url.includes(DELETE_OBJECT("private")),
      );
      expect(del?.body).toEqual({ prefixes: ["abstract.pdf", "docs/readme.md"] });
    });
  });

  it.live("echoes the confirmation and deletes with --yes", () => {
    const { layer, out } = setupStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      yes: true,
      routes: [{ method: "DELETE", match: DELETE_OBJECT("private"), body: [{ name: "a.pdf" }] }],
    });
    return Effect.gen(function* () {
      const exit = yield* storageRm({
        files: ["ss:///private/a.pdf"],
        recursive: false,
        linked: true,
        local: true,
        projectRef: Option.none(),
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stderrText).toContain("Confirm deleting files in bucket");
      expect(out.stderrText).toContain("[y/N] y");
      expect(out.stderrText).toContain("Deleting objects: [a.pdf]");
    });
  });

  it.live("auto-confirms via SUPABASE_YES even without the --yes flag", () => {
    // The --yes flag itself stays false here, to isolate the env-var path.
    process.env["SUPABASE_YES"] = "1";
    const { layer, out, requests } = setupStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      routes: [{ method: "DELETE", match: DELETE_OBJECT("private"), body: [{ name: "a.pdf" }] }],
    });
    return Effect.gen(function* () {
      const exit = yield* storageRm({
        files: ["ss:///private/a.pdf"],
        recursive: false,
        linked: true,
        local: true,
        projectRef: Option.none(),
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stderrText).toContain("[y/N] y");
      expect(requests.some((r) => r.method === "DELETE")).toBe(true);
    });
  });

  it.live("auto-confirms from SUPABASE_YES in the project .env (Go loadNestedEnv)", () => {
    // SUPABASE_YES here lives only in supabase/.env, not the shell.
    const { layer, out, requests } = setupStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      files: { "supabase/.env": "SUPABASE_YES=true\n" },
      routes: [{ method: "DELETE", match: DELETE_OBJECT("private"), body: [{ name: "a.pdf" }] }],
    });
    return Effect.gen(function* () {
      const exit = yield* storageRm({
        files: ["ss:///private/a.pdf"],
        recursive: false,
        linked: true,
        local: true,
        projectRef: Option.none(),
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stderrText).toContain("[y/N] y");
      expect(requests.some((r) => r.method === "DELETE")).toBe(true);
    });
  });

  it.live(
    "surfaces not-linked guidance before a malformed project .env (Go LoadProjectRef-before-LoadConfig)",
    () => {
      // The malformed supabase/.env must never be read; ref resolution fails first.
      const { layer, requests } = setupStorage(tmp.current, {
        toml: 'project_id = "test"\n',
        linkedFails: true,
        files: { "supabase/.env": "!=\n" },
      });
      return Effect.gen(function* () {
        const exit = yield* storageRm({
          files: ["ss:///private/a.pdf"],
          recursive: false,
          linked: true,
          local: false,
          projectRef: Option.none(),
        }).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(JSON.stringify(exit)).toContain("Cannot find project ref");
        expect(JSON.stringify(exit)).not.toContain("failed to parse environment file");
        expect(requests).toHaveLength(0);
      });
    },
  );

  it.live("skips the bucket when the confirmation is declined", () => {
    const { layer, requests } = setupStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      confirm: [false],
      routes: [{ method: "DELETE", match: DELETE_OBJECT("private"), body: [] }],
    });
    return Effect.gen(function* () {
      const exit = yield* storageRm({
        files: ["ss:///private/a.pdf"],
        recursive: false,
        linked: true,
        local: true,
        projectRef: Option.none(),
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(requests.some((r) => r.method === "DELETE")).toBe(false);
    });
  });

  it.live("honors a piped 'y' on non-TTY stdin and deletes", () => {
    const { layer, requests, out } = setupStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      stdinIsTty: false,
      pipedAnswers: ["y"],
      routes: [{ method: "DELETE", match: DELETE_OBJECT("private"), body: [{ name: "a.pdf" }] }],
    });
    return Effect.gen(function* () {
      const exit = yield* storageRm({
        files: ["ss:///private/a.pdf"],
        recursive: false,
        linked: true,
        local: true,
        projectRef: Option.none(),
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(requests.some((r) => r.method === "DELETE")).toBe(true);
      expect(out.stderrText).toContain("[y/N] y");
    });
  });

  it.live("falls back to the default (no) on an unparseable piped answer", () => {
    const { layer, requests } = setupStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      stdinIsTty: false,
      pipedAnswers: ["maybe"],
      routes: [{ method: "DELETE", match: DELETE_OBJECT("private"), body: [] }],
    });
    return Effect.gen(function* () {
      const exit = yield* storageRm({
        files: ["ss:///private/a.pdf"],
        recursive: false,
        linked: true,
        local: true,
        projectRef: Option.none(),
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(requests.some((r) => r.method === "DELETE")).toBe(false);
    });
  });

  it.live("uses the default (no) when non-interactive and skips deletion", () => {
    const { layer, requests } = setupStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      format: "json",
      routes: [{ method: "DELETE", match: DELETE_OBJECT("private"), body: [] }],
    });
    return Effect.gen(function* () {
      const exit = yield* storageRm({
        files: ["ss:///private/a.pdf"],
        recursive: false,
        linked: true,
        local: true,
        projectRef: Option.none(),
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(requests.some((r) => r.method === "DELETE")).toBe(false);
    });
  });

  it.live("chunks explicit deletes by the storage API limit (1000)", () => {
    const files = Array.from({ length: 1001 }, (_, i) => `ss:///private/file-${i}.txt`);
    const { layer, requests } = setupStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      yes: true,
      routes: [
        {
          method: "DELETE",
          match: DELETE_OBJECT("private"),
          when: (b) => prefixCount(b) === 1000,
          body: [],
        },
        {
          method: "DELETE",
          match: DELETE_OBJECT("private"),
          when: (b) => prefixCount(b) === 1,
          body: [],
        },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* storageRm({
        files,
        recursive: false,
        linked: true,
        local: true,
        projectRef: Option.none(),
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      const deletes = requests.filter(
        (r) => r.method === "DELETE" && r.url.includes(DELETE_OBJECT("private")),
      );
      expect(deletes).toHaveLength(2);
      expect(prefixCount(deletes[0]?.body)).toBe(1000);
      expect(prefixCount(deletes[1]?.body)).toBe(1);
    });
  });

  it.live("fails with missing bucket when a path targets the root", () => {
    const { layer, requests } = setupStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
    });
    return Effect.gen(function* () {
      const exit = yield* storageRm({
        files: ["ss:///"],
        recursive: false,
        linked: true,
        local: true,
        projectRef: Option.none(),
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("You must specify a bucket to delete.");
      expect(requests).toHaveLength(0);
    });
  });

  it.live("requires -r to delete a directory prefix", () => {
    const { layer, requests } = setupStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
    });
    return Effect.gen(function* () {
      const exit = yield* storageRm({
        files: ["ss:///private/"],
        recursive: false,
        linked: true,
        local: true,
        projectRef: Option.none(),
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("You must specify -r flag to delete directories.");
      expect(requests).toHaveLength(0);
    });
  });

  it.live("requires -r when no paths are given", () => {
    const { layer } = setupStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
    });
    return Effect.gen(function* () {
      const exit = yield* storageRm({
        files: [],
        recursive: false,
        linked: true,
        local: true,
        projectRef: Option.none(),
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("You must specify -r flag to delete directories.");
    });
  });

  it.live("with -r and no paths, clears and deletes every bucket", () => {
    const { layer, out, requests } = setupStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      yes: true,
      routes: [
        { method: "GET", match: BUCKET, body: [{ name: "b1", id: "b1" }] },
        { method: "DELETE", match: DELETE_OBJECT("b1"), body: [] },
        { method: "POST", match: LIST("b1"), body: [] },
        { method: "DELETE", match: DELETE_BUCKET("b1"), body: { message: "Successfully deleted" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* storageRm({
        files: [],
        recursive: true,
        linked: true,
        local: true,
        projectRef: Option.none(),
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stderrText).toContain("Deleting bucket: b1");
      expect(
        requests.some((r) => r.method === "DELETE" && r.url.includes(DELETE_BUCKET("b1"))),
      ).toBe(true);
    });
  });

  it.live("recursively deletes a directory and tolerates a missing bucket on delete", () => {
    const { layer, out } = setupStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      yes: true,
      routes: [
        // explicit delete of the whole-bucket arg
        { method: "DELETE", match: DELETE_OBJECT("test"), body: [] },
        // recursive walk: empty
        { method: "POST", match: LIST("test"), body: [] },
        // delete the now-empty bucket → 404 tolerated
        {
          method: "DELETE",
          match: DELETE_BUCKET("test"),
          status: 404,
          body: { error: "Bucket not found" },
        },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* storageRm({
        files: ["ss:///test"],
        recursive: true,
        linked: true,
        local: true,
        projectRef: Option.none(),
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stderrText).toContain("Bucket not found: test");
    });
  });

  it.live("recursively deletes a nested directory tree", () => {
    const { layer, requests } = setupStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      yes: true,
      routes: [
        // explicit delete of the "dir" prefix → not removed (it's a directory)
        {
          method: "DELETE",
          match: DELETE_OBJECT("private"),
          when: (b) => prefixCount(b) === 1 && (b as { prefixes: string[] }).prefixes[0] === "dir",
          body: [],
        },
        // walk "dir/": a subdir + a file
        {
          method: "POST",
          match: LIST("private"),
          when: (b) => (b as { prefix?: string }).prefix === "dir/",
          body: [
            { name: "sub", id: null },
            { name: "f.txt", id: "fi" },
          ],
        },
        // delete the file at this level
        {
          method: "DELETE",
          match: DELETE_OBJECT("private"),
          when: (b) => (b as { prefixes: string[] }).prefixes.includes("dir/f.txt"),
          body: [{ name: "dir/f.txt" }],
        },
        // descend into dir/sub/
        {
          method: "POST",
          match: LIST("private"),
          when: (b) => (b as { prefix?: string }).prefix === "dir/sub/",
          body: [{ name: "g.txt", id: "gi" }],
        },
        {
          method: "DELETE",
          match: DELETE_OBJECT("private"),
          when: (b) => (b as { prefixes: string[] }).prefixes.includes("dir/sub/g.txt"),
          body: [{ name: "dir/sub/g.txt" }],
        },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* storageRm({
        files: ["ss:///private/dir"],
        recursive: true,
        linked: true,
        local: true,
        projectRef: Option.none(),
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(
        requests.some(
          (r) =>
            r.method === "DELETE" &&
            (r.body as { prefixes?: string[] }).prefixes?.includes("dir/sub/g.txt"),
        ),
      ).toBe(true);
    });
  });

  it.live("deletes a now-empty bucket and prints its success message", () => {
    const { layer, out } = setupStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      yes: true,
      routes: [
        { method: "DELETE", match: DELETE_OBJECT("test"), body: [] },
        { method: "POST", match: LIST("test"), body: [] },
        {
          method: "DELETE",
          match: DELETE_BUCKET("test"),
          body: { message: "Successfully deleted" },
        },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* storageRm({
        files: ["ss:///test"],
        recursive: true,
        linked: true,
        local: true,
        projectRef: Option.none(),
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stderrText).toContain("Deleting bucket: test");
      expect(out.stderrText).toContain("Successfully deleted");
    });
  });

  it.live("fails with Object not found for an empty recursive directory", () => {
    const { layer } = setupStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      yes: true,
      routes: [
        { method: "DELETE", match: DELETE_OBJECT("private"), body: [] },
        { method: "POST", match: LIST("private"), body: [] },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* storageRm({
        files: ["ss:///private/dir"],
        recursive: true,
        linked: true,
        local: true,
        projectRef: Option.none(),
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("Object not found: private/dir/");
    });
  });

  it.live("emits a { deleted, buckets_deleted } result in json mode", () => {
    const { layer, out } = setupStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      yes: true,
      format: "json",
      routes: [{ method: "DELETE", match: DELETE_OBJECT("private"), body: [{ name: "a.pdf" }] }],
    });
    return Effect.gen(function* () {
      const exit = yield* storageRm({
        files: ["ss:///private/a.pdf"],
        recursive: false,
        linked: true,
        local: true,
        projectRef: Option.none(),
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data?.["deleted"]).toEqual(["a.pdf"]);
      expect(success?.data?.["buckets_deleted"]).toEqual([]);
    });
  });

  it.live("propagates a 500 from the object DELETE", () => {
    // A non-404 status escapes the bucket-not-found tolerance and fails hard.
    const { layer } = setupStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      yes: true,
      routes: [
        {
          method: "DELETE",
          match: DELETE_OBJECT("private"),
          status: 500,
          body: { message: "internal error" },
        },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* storageRm({
        files: ["ss:///private/a.pdf"],
        recursive: false,
        linked: true,
        local: true,
        projectRef: Option.none(),
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("Error status 500");
    });
  });

  it.live("propagates a 503 from the bucket service when listing for -r", () => {
    const { layer, requests } = setupStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      yes: true,
      routes: [{ method: "GET", match: BUCKET, status: 503, body: { message: "unavailable" } }],
    });
    return Effect.gen(function* () {
      const exit = yield* storageRm({
        files: [],
        recursive: true,
        linked: true,
        local: true,
        projectRef: Option.none(),
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("Error status 503");
      expect(requests.some((r) => r.method === "DELETE")).toBe(false);
    });
  });

  it.live("targets the linked project's Storage host and flushes telemetry", () => {
    const { layer, requests, telemetry, linkedCache } = setupStorage(tmp.current, {
      // No `--local`, so the linked path resolves the ref + service-role key.
      yes: true,
      routes: [{ method: "DELETE", match: DELETE_OBJECT("private"), body: [{ name: "a.pdf" }] }],
    });
    return Effect.gen(function* () {
      const exit = yield* storageRm({
        files: ["ss:///private/a.pdf"],
        recursive: false,
        linked: true,
        local: false,
        projectRef: Option.none(),
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(requests.some((r) => r.url.startsWith(`https://${VALID_REF}.supabase.co`))).toBe(true);
      expect(telemetry.flushed).toBe(true);
      expect(linkedCache.cached).toBe(true);
      expect(linkedCache.cachedRef).toBe(VALID_REF);
    });
  });

  it.live("deletes from the project given via --project-ref, overriding VALID_REF", () => {
    // The fake's default projectRef is VALID_REF; the flag must win over it.
    const FLAG_REF = "flagflagflagflagflag";
    const { layer, requests, linkedCache } = setupStorage(tmp.current, {
      yes: true,
      routes: [{ method: "DELETE", match: DELETE_OBJECT("private"), body: [{ name: "a.pdf" }] }],
    });
    return Effect.gen(function* () {
      const exit = yield* storageRm({
        files: ["ss:///private/a.pdf"],
        recursive: false,
        linked: true,
        local: false,
        projectRef: Option.some(FLAG_REF),
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(requests.some((r) => r.url.startsWith(`https://${FLAG_REF}.supabase.co`))).toBe(true);
      expect(requests.some((r) => r.url.includes(VALID_REF))).toBe(false);
      expect(linkedCache.cached).toBe(true);
      expect(linkedCache.cachedRef).toBe(FLAG_REF);
    });
  });

  it.live("rejects --project-ref combined with --local", () => {
    const FLAG_REF = "flagflagflagflagflag";
    const { layer, requests, linkedCache } = setupStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      yes: true,
    });
    return Effect.gen(function* () {
      const exit = yield* storageRm({
        files: ["ss:///private/a.pdf"],
        recursive: false,
        linked: false,
        local: true,
        projectRef: Option.some(FLAG_REF),
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain(
        "--project-ref only applies when targeting the linked project; use it with --linked (not --local)",
      );
      expect(requests).toHaveLength(0);
      expect(linkedCache.cached).toBe(false);
    });
  });

  it.live(
    "does not delete anything when --workdir names a config-less subdirectory of a real ancestor project",
    () => {
      // An explicit --workdir must hard-fail rather than climb to an ancestor's
      // config.toml, which could point at a different (possibly running) local stack.
      writeAncestorConfig(tmp.current, 'project_id = "test"\n[api]\nport = 65432\n');
      const sub = join(tmp.current, "nested", "dir");
      mkdirSync(sub, { recursive: true });
      const { layer, requests } = setupStorage(sub, {
        local: true,
        yes: true,
        explicitWorkdir: true,
        routes: [{ method: "DELETE", match: DELETE_OBJECT("private"), body: [{ name: "a.pdf" }] }],
      });
      return Effect.gen(function* () {
        const exit = yield* storageRm({
          files: ["ss:///private/a.pdf"],
          recursive: false,
          linked: true,
          local: true,
          projectRef: Option.none(),
        }).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(JSON.stringify(exit)).toContain("StorageMissingProjectConfigError");
        expect(requests.some((r) => r.method === "DELETE")).toBe(false);
        expect(requests).toHaveLength(0);
      });
    },
  );

  it.live(
    "a defaulted workdir with no project anywhere still proceeds using the embedded default config",
    () => {
      const { layer, requests } = setupStorage(tmp.current, {
        local: true,
        yes: true,
        routes: [{ method: "DELETE", match: DELETE_OBJECT("private"), body: [{ name: "a.pdf" }] }],
      });
      return Effect.gen(function* () {
        const exit = yield* storageRm({
          files: ["ss:///private/a.pdf"],
          recursive: false,
          linked: true,
          local: true,
          projectRef: Option.none(),
        }).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isSuccess(exit)).toBe(true);
        expect(requests.some((r) => r.method === "DELETE")).toBe(true);
      });
    },
  );

  it.live(
    "an explicit --workdir naming a directory that does not exist at all fails before any credential resolution",
    () => {
      const missing = join(tmp.current, "does-not-exist");
      const { layer, requests } = setupStorage(missing, {
        local: true,
        yes: true,
        explicitWorkdir: true,
      });
      return Effect.gen(function* () {
        const exit = yield* storageRm({
          files: ["ss:///private/a.pdf"],
          recursive: false,
          linked: true,
          local: true,
          projectRef: Option.none(),
        }).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(JSON.stringify(exit)).toContain("StorageWorkdirError");
        expect(JSON.stringify(exit)).toContain("failed to change workdir: chdir");
        expect(requests).toHaveLength(0);
      });
    },
  );

  it.live("emits a { deleted, buckets_deleted } result in stream-json mode", () => {
    const { layer, out } = setupStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      yes: true,
      format: "stream-json",
      routes: [{ method: "DELETE", match: DELETE_OBJECT("private"), body: [{ name: "a.pdf" }] }],
    });
    return Effect.gen(function* () {
      const exit = yield* storageRm({
        files: ["ss:///private/a.pdf"],
        recursive: false,
        linked: true,
        local: true,
        projectRef: Option.none(),
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data?.["deleted"]).toEqual(["a.pdf"]);
      expect(success?.data?.["buckets_deleted"]).toEqual([]);
    });
  });
});
