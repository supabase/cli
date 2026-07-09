import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { afterEach } from "vitest";

import { setupLegacyStorage } from "../../../../../tests/helpers/legacy-storage.ts";
import {
  LEGACY_VALID_REF,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { legacyStorageRm } from "./rm.handler.ts";

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

describe("legacy storage rm", () => {
  const tmp = useLegacyTempWorkdir("supabase-storage-rm-");

  afterEach(() => {
    delete process.env["SUPABASE_YES"];
  });

  it.live("deletes multiple objects after confirmation", () => {
    const { layer, requests } = setupLegacyStorage(tmp.current, {
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
      const exit = yield* legacyStorageRm({
        files: ["ss:///private/abstract.pdf", "ss:///private/docs/readme.md"],
        recursive: false,
        linked: true,
        local: true,
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      const del = requests.find(
        (r) => r.method === "DELETE" && r.url.includes(DELETE_OBJECT("private")),
      );
      expect(del?.body).toEqual({ prefixes: ["abstract.pdf", "docs/readme.md"] });
    });
  });

  it.live("echoes the confirmation and deletes with --yes", () => {
    const { layer, out } = setupLegacyStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      yes: true,
      routes: [{ method: "DELETE", match: DELETE_OBJECT("private"), body: [{ name: "a.pdf" }] }],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyStorageRm({
        files: ["ss:///private/a.pdf"],
        recursive: false,
        linked: true,
        local: true,
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stderrText).toContain("Confirm deleting files in bucket");
      expect(out.stderrText).toContain("[y/N] y");
      expect(out.stderrText).toContain("Deleting objects: [a.pdf]");
    });
  });

  it.live("auto-confirms via SUPABASE_YES even without the --yes flag", () => {
    // viper AutomaticEnv (root.go:318-320) means `SUPABASE_YES` is equivalent to
    // `--yes`; the flag layer is left at its default `false` to prove the env path.
    process.env["SUPABASE_YES"] = "1";
    const { layer, out, requests } = setupLegacyStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      routes: [{ method: "DELETE", match: DELETE_OBJECT("private"), body: [{ name: "a.pdf" }] }],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyStorageRm({
        files: ["ss:///private/a.pdf"],
        recursive: false,
        linked: true,
        local: true,
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stderrText).toContain("[y/N] y");
      expect(requests.some((r) => r.method === "DELETE")).toBe(true);
    });
  });

  it.live("auto-confirms from SUPABASE_YES in the project .env (Go loadNestedEnv)", () => {
    // SUPABASE_YES lives only in supabase/.env, not the shell — both the `--local` and
    // (default) `--linked` branches of Go's `ParseDatabaseConfig` load the project `.env`
    // files before `rm.Run`'s confirmation prompt (root.go:118), so the deletion
    // auto-confirms with no --yes flag and no env var set in the shell (CLI-1878).
    const { layer, out, requests } = setupLegacyStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      files: { "supabase/.env": "SUPABASE_YES=true\n" },
      routes: [{ method: "DELETE", match: DELETE_OBJECT("private"), body: [{ name: "a.pdf" }] }],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyStorageRm({
        files: ["ss:///private/a.pdf"],
        recursive: false,
        linked: true,
        local: true,
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stderrText).toContain("[y/N] y");
      expect(requests.some((r) => r.method === "DELETE")).toBe(true);
    });
  });

  it.live(
    "surfaces not-linked guidance before a malformed project .env (Go LoadProjectRef-before-LoadConfig)",
    () => {
      // Go's `ParseDatabaseConfig` `case linked:` (db_url.go:87-93) calls `LoadProjectRef`
      // strictly before `LoadConfig` (which reads the project `.env` files), so an unlinked
      // workdir must fail with the not-linked guidance even when `supabase/.env` is malformed
      // — the malformed file must never be reached (CLI-1878).
      const { layer, requests } = setupLegacyStorage(tmp.current, {
        toml: 'project_id = "test"\n',
        linkedFails: true,
        files: { "supabase/.env": "!=\n" },
      });
      return Effect.gen(function* () {
        const exit = yield* legacyStorageRm({
          files: ["ss:///private/a.pdf"],
          recursive: false,
          linked: true,
          local: false,
        }).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(JSON.stringify(exit)).toContain("Cannot find project ref");
        expect(JSON.stringify(exit)).not.toContain("failed to parse environment file");
        expect(requests).toHaveLength(0);
      });
    },
  );

  it.live("skips the bucket when the confirmation is declined", () => {
    const { layer, requests } = setupLegacyStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      confirm: [false],
      routes: [{ method: "DELETE", match: DELETE_OBJECT("private"), body: [] }],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyStorageRm({
        files: ["ss:///private/a.pdf"],
        recursive: false,
        linked: true,
        local: true,
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(requests.some((r) => r.method === "DELETE")).toBe(false);
    });
  });

  it.live("honors a piped 'y' on non-TTY stdin and deletes", () => {
    // Go scans piped stdin before defaulting (`console.go:74-82`); a piped `y`
    // overrides the `n` default and deletes, even on a non-terminal.
    const { layer, requests, out } = setupLegacyStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      stdinIsTty: false,
      pipedAnswers: ["y"],
      routes: [{ method: "DELETE", match: DELETE_OBJECT("private"), body: [{ name: "a.pdf" }] }],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyStorageRm({
        files: ["ss:///private/a.pdf"],
        recursive: false,
        linked: true,
        local: true,
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(requests.some((r) => r.method === "DELETE")).toBe(true);
      // The consumed answer is echoed after the label (Go's non-TTY `PromptText`).
      expect(out.stderrText).toContain("[y/N] y");
    });
  });

  it.live("falls back to the default (no) on an unparseable piped answer", () => {
    // Go's `parseYesNo` returns nil for unrecognized input (`console.go:84-93`), so
    // `PromptYesNo` keeps the `n` default and the deletion is skipped.
    const { layer, requests } = setupLegacyStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      stdinIsTty: false,
      pipedAnswers: ["maybe"],
      routes: [{ method: "DELETE", match: DELETE_OBJECT("private"), body: [] }],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyStorageRm({
        files: ["ss:///private/a.pdf"],
        recursive: false,
        linked: true,
        local: true,
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(requests.some((r) => r.method === "DELETE")).toBe(false);
    });
  });

  it.live("uses the default (no) when non-interactive and skips deletion", () => {
    const { layer, requests } = setupLegacyStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      format: "json",
      routes: [{ method: "DELETE", match: DELETE_OBJECT("private"), body: [] }],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyStorageRm({
        files: ["ss:///private/a.pdf"],
        recursive: false,
        linked: true,
        local: true,
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(requests.some((r) => r.method === "DELETE")).toBe(false);
    });
  });

  it.live("chunks explicit deletes by the storage API limit (1000)", () => {
    const files = Array.from({ length: 1001 }, (_, i) => `ss:///private/file-${i}.txt`);
    const { layer, requests } = setupLegacyStorage(tmp.current, {
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
      const exit = yield* legacyStorageRm({
        files,
        recursive: false,
        linked: true,
        local: true,
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
    const { layer, requests } = setupLegacyStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
    });
    return Effect.gen(function* () {
      const exit = yield* legacyStorageRm({
        files: ["ss:///"],
        recursive: false,
        linked: true,
        local: true,
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("You must specify a bucket to delete.");
      expect(requests).toHaveLength(0);
    });
  });

  it.live("requires -r to delete a directory prefix", () => {
    const { layer, requests } = setupLegacyStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
    });
    return Effect.gen(function* () {
      const exit = yield* legacyStorageRm({
        files: ["ss:///private/"],
        recursive: false,
        linked: true,
        local: true,
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("You must specify -r flag to delete directories.");
      expect(requests).toHaveLength(0);
    });
  });

  it.live("requires -r when no paths are given", () => {
    const { layer } = setupLegacyStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
    });
    return Effect.gen(function* () {
      const exit = yield* legacyStorageRm({
        files: [],
        recursive: false,
        linked: true,
        local: true,
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("You must specify -r flag to delete directories.");
    });
  });

  it.live("with -r and no paths, clears and deletes every bucket", () => {
    const { layer, out, requests } = setupLegacyStorage(tmp.current, {
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
      const exit = yield* legacyStorageRm({
        files: [],
        recursive: true,
        linked: true,
        local: true,
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stderrText).toContain("Deleting bucket: b1");
      expect(
        requests.some((r) => r.method === "DELETE" && r.url.includes(DELETE_BUCKET("b1"))),
      ).toBe(true);
    });
  });

  it.live("recursively deletes a directory and tolerates a missing bucket on delete", () => {
    const { layer, out } = setupLegacyStorage(tmp.current, {
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
      const exit = yield* legacyStorageRm({
        files: ["ss:///test"],
        recursive: true,
        linked: true,
        local: true,
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stderrText).toContain("Bucket not found: test");
    });
  });

  it.live("recursively deletes a nested directory tree", () => {
    const { layer, requests } = setupLegacyStorage(tmp.current, {
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
      const exit = yield* legacyStorageRm({
        files: ["ss:///private/dir"],
        recursive: true,
        linked: true,
        local: true,
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
    const { layer, out } = setupLegacyStorage(tmp.current, {
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
      const exit = yield* legacyStorageRm({
        files: ["ss:///test"],
        recursive: true,
        linked: true,
        local: true,
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stderrText).toContain("Deleting bucket: test");
      expect(out.stderrText).toContain("Successfully deleted");
    });
  });

  it.live("fails with Object not found for an empty recursive directory", () => {
    const { layer } = setupLegacyStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      yes: true,
      routes: [
        { method: "DELETE", match: DELETE_OBJECT("private"), body: [] },
        { method: "POST", match: LIST("private"), body: [] },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyStorageRm({
        files: ["ss:///private/dir"],
        recursive: true,
        linked: true,
        local: true,
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("Object not found: private/dir/");
    });
  });

  it.live("emits a { deleted, buckets_deleted } result in json mode", () => {
    const { layer, out } = setupLegacyStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      yes: true,
      format: "json",
      routes: [{ method: "DELETE", match: DELETE_OBJECT("private"), body: [{ name: "a.pdf" }] }],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyStorageRm({
        files: ["ss:///private/a.pdf"],
        recursive: false,
        linked: true,
        local: true,
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data?.["deleted"]).toEqual(["a.pdf"]);
      expect(success?.data?.["buckets_deleted"]).toEqual([]);
    });
  });

  it.live("propagates a 500 from the object DELETE", () => {
    // A non-404 status escapes the bucket-not-found tolerance and fails hard.
    const { layer } = setupLegacyStorage(tmp.current, {
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
      const exit = yield* legacyStorageRm({
        files: ["ss:///private/a.pdf"],
        recursive: false,
        linked: true,
        local: true,
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("Error status 500");
    });
  });

  it.live("propagates a 503 from the bucket service when listing for -r", () => {
    const { layer, requests } = setupLegacyStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      yes: true,
      routes: [{ method: "GET", match: BUCKET, status: 503, body: { message: "unavailable" } }],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyStorageRm({
        files: [],
        recursive: true,
        linked: true,
        local: true,
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("Error status 503");
      // The command fails before any delete is attempted.
      expect(requests.some((r) => r.method === "DELETE")).toBe(false);
    });
  });

  it.live("targets the linked project's Storage host and flushes telemetry", () => {
    const { layer, requests, telemetry, linkedCache } = setupLegacyStorage(tmp.current, {
      // No `--local`, so the linked path resolves the ref + service-role key.
      yes: true,
      routes: [{ method: "DELETE", match: DELETE_OBJECT("private"), body: [{ name: "a.pdf" }] }],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyStorageRm({
        files: ["ss:///private/a.pdf"],
        recursive: false,
        linked: true,
        local: false,
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(
        requests.some((r) => r.url.startsWith(`https://${LEGACY_VALID_REF}.supabase.co`)),
      ).toBe(true);
      expect(telemetry.flushed).toBe(true);
      expect(linkedCache.cached).toBe(true);
      expect(linkedCache.cachedRef).toBe(LEGACY_VALID_REF);
    });
  });

  it.live("emits a { deleted, buckets_deleted } result in stream-json mode", () => {
    const { layer, out } = setupLegacyStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      yes: true,
      format: "stream-json",
      routes: [{ method: "DELETE", match: DELETE_OBJECT("private"), body: [{ name: "a.pdf" }] }],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyStorageRm({
        files: ["ss:///private/a.pdf"],
        recursive: false,
        linked: true,
        local: true,
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data?.["deleted"]).toEqual(["a.pdf"]);
      expect(success?.data?.["buckets_deleted"]).toEqual([]);
    });
  });
});
