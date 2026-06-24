import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";

import { setupLegacyStorage } from "../../../../../tests/helpers/legacy-storage.ts";
import {
  LEGACY_VALID_REF,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { legacyStorageCp } from "./cp.handler.ts";
import type { LegacyStorageCpFlags } from "./cp.command.ts";

const BUCKET = "/storage/v1/bucket";
const OBJECT = (p: string) => `/storage/v1/object/${p}`;
const LIST = (bucket: string) => `/storage/v1/object/list/${bucket}`;

function cpFlags(opts: {
  src: string;
  dst: string;
  recursive?: boolean;
  cacheControl?: string;
  contentType?: string;
  jobs?: number;
  local?: boolean;
}): LegacyStorageCpFlags {
  return {
    src: opts.src,
    dst: opts.dst,
    recursive: opts.recursive ?? false,
    cacheControl: opts.cacheControl === undefined ? Option.none() : Option.some(opts.cacheControl),
    contentType: opts.contentType === undefined ? Option.none() : Option.some(opts.contentType),
    jobs: opts.jobs === undefined ? Option.none() : Option.some(opts.jobs),
    linked: true,
    local: opts.local ?? true,
  };
}

function prefixOf(body: unknown): string {
  return typeof body === "object" &&
    body !== null &&
    typeof (body as { prefix?: unknown }).prefix === "string"
    ? (body as { prefix: string }).prefix
    : "";
}

describe("legacy storage cp", () => {
  const tmp = useLegacyTempWorkdir("supabase-storage-cp-");

  it.live("uploads a single local file with a sniffed content-type", () => {
    writeFileSync(join(tmp.current, "readme.md"), "hello world");
    const { layer, requests } = setupLegacyStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      routes: [{ method: "POST", match: OBJECT("private/readme.md"), body: {} }],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyStorageCp(
        cpFlags({ src: join(tmp.current, "readme.md"), dst: "ss:///private/readme.md" }),
      ).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      const upload = requests.find((r) => r.url.includes(OBJECT("private/readme.md")));
      expect(upload?.method).toBe("POST");
      // Single upload does NOT set x-upsert (Go's Overwrite stays false).
      expect(upload?.headers["x-upsert"]).toBeUndefined();
      expect(upload?.headers["cache-control"]).toBe("max-age=3600");
      expect(upload?.headers["content-type"]).toContain("text/plain");
    });
  });

  it.live("honors --content-type and --cache-control on upload", () => {
    writeFileSync(join(tmp.current, "data.bin"), "hello");
    const { layer, requests } = setupLegacyStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      routes: [{ method: "POST", match: OBJECT("private/data.bin"), body: {} }],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyStorageCp(
        cpFlags({
          src: join(tmp.current, "data.bin"),
          dst: "ss:///private/data.bin",
          contentType: "application/custom",
          cacheControl: "max-age=60",
        }),
      ).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      const upload = requests.find((r) => r.url.includes(OBJECT("private/data.bin")));
      expect(upload?.headers["content-type"]).toBe("application/custom");
      expect(upload?.headers["cache-control"]).toBe("max-age=60");
    });
  });

  it.live("recursively uploads a directory, auto-creating a missing bucket", () => {
    mkdirSync(join(tmp.current, "upload"), { recursive: true });
    writeFileSync(join(tmp.current, "upload", "readme.md"), "hello");
    const { layer, requests } = setupLegacyStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      routes: [
        // first upload → bucket missing
        {
          method: "POST",
          match: OBJECT("upload/readme.md"),
          status: 400,
          body: { error: "Bucket not found" },
        },
        // create the bucket
        { method: "POST", match: "/storage/v1/bucket", body: { name: "upload" } },
        // retry upload
        { method: "POST", match: OBJECT("upload/readme.md"), body: {} },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyStorageCp(
        cpFlags({ src: join(tmp.current, "upload"), dst: "ss://", recursive: true }),
      ).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      // Recursive uploads set x-upsert; bucket auto-created then upload retried.
      const uploads = requests.filter((r) => r.url.includes(OBJECT("upload/readme.md")));
      expect(uploads).toHaveLength(2);
      expect(uploads[1]?.headers["x-upsert"]).toBe("true");
      expect(
        requests.some((r) => r.method === "POST" && r.url.endsWith("/storage/v1/bucket")),
      ).toBe(true);
    });
  });

  it.live("downloads a single remote object to a new local file", () => {
    const dst = join(tmp.current, "out.md");
    const { layer } = setupLegacyStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      routes: [{ method: "GET", match: OBJECT("private/readme.md"), rawBody: "downloaded-bytes" }],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyStorageCp(cpFlags({ src: "ss:///private/readme.md", dst })).pipe(
        Effect.provide(layer),
        Effect.exit,
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(readFileSync(dst, "utf8")).toBe("downloaded-bytes");
    });
  });

  it.live("refuses to overwrite an existing local file on a single download", () => {
    const dst = join(tmp.current, "exists.md");
    writeFileSync(dst, "original");
    const { layer } = setupLegacyStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      routes: [{ method: "GET", match: OBJECT("private/readme.md"), rawBody: "new" }],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyStorageCp(cpFlags({ src: "ss:///private/readme.md", dst })).pipe(
        Effect.provide(layer),
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("failed to create file");
      // The existing file is untouched.
      expect(readFileSync(dst, "utf8")).toBe("original");
    });
  });

  it.live("recursively downloads nested objects, creating parent dirs", () => {
    const dst = join(tmp.current, "dl");
    const { layer } = setupLegacyStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      routes: [
        {
          method: "POST",
          match: LIST("private"),
          when: (b) => prefixOf(b) === "",
          body: [
            { name: "folder", id: null },
            { name: "a.txt", id: "ai" },
          ],
        },
        {
          method: "POST",
          match: LIST("private"),
          when: (b) => prefixOf(b) === "folder/",
          body: [{ name: "b.txt", id: "bi" }],
        },
        { method: "GET", match: OBJECT("private/a.txt"), rawBody: "a-content" },
        { method: "GET", match: OBJECT("private/folder/b.txt"), rawBody: "b-content" },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyStorageCp(
        cpFlags({ src: "ss:///private/", dst, recursive: true }),
      ).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(readFileSync(join(dst, "a.txt"), "utf8")).toBe("a-content");
      expect(readFileSync(join(dst, "folder", "b.txt"), "utf8")).toBe("b-content");
    });
  });

  it.live("recursively downloads into an existing directory (nests under the remote base)", () => {
    const dst = join(tmp.current, "existing");
    mkdirSync(dst, { recursive: true });
    const { layer } = setupLegacyStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      routes: [
        { method: "POST", match: LIST("private"), body: [{ name: "a.txt", id: "ai" }] },
        { method: "GET", match: OBJECT("private/a.txt"), rawBody: "a" },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyStorageCp(
        cpFlags({ src: "ss:///private/", dst, recursive: true }),
      ).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      // Existing dir → nest under base("/private/") = "private".
      expect(readFileSync(join(dst, "private", "a.txt"), "utf8")).toBe("a");
    });
  });

  it.live("creates a directory for an empty bucket on recursive download", () => {
    const dst = join(tmp.current, "dl-empty");
    const { layer } = setupLegacyStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      routes: [
        { method: "GET", match: BUCKET, body: [{ name: "empty", id: "empty" }] },
        { method: "POST", match: LIST("empty"), body: [] },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyStorageCp(cpFlags({ src: "ss:///", dst, recursive: true })).pipe(
        Effect.provide(layer),
        Effect.exit,
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      // Empty bucket reported as "empty/" → mkdir under the destination.
      expect(existsSync(join(dst, "empty"))).toBe(true);
    });
  });

  it.live("recursively uploads a nested subdirectory", () => {
    mkdirSync(join(tmp.current, "tree", "sub"), { recursive: true });
    writeFileSync(join(tmp.current, "tree", "top.txt"), "t");
    writeFileSync(join(tmp.current, "tree", "sub", "nested.txt"), "n");
    const { layer, requests } = setupLegacyStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      routes: [
        { method: "POST", match: LIST("private"), body: [{ name: "dir", id: null }] },
        { method: "POST", match: OBJECT("private/dir/tree/top.txt"), body: {} },
        { method: "POST", match: OBJECT("private/dir/tree/sub/nested.txt"), body: {} },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyStorageCp(
        cpFlags({ src: join(tmp.current, "tree"), dst: "ss:///private/dir/", recursive: true }),
      ).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(requests.some((r) => r.url.includes(OBJECT("private/dir/tree/sub/nested.txt")))).toBe(
        true,
      );
    });
  });

  it.live("auto-creates a bucket using its config from supabase/config.toml", () => {
    mkdirSync(join(tmp.current, "media"), { recursive: true });
    writeFileSync(join(tmp.current, "media", "a.png"), "x");
    const { layer, requests } = setupLegacyStorage(tmp.current, {
      toml: "[storage.buckets.media]\npublic = true\n",
      local: true,
      routes: [
        {
          method: "POST",
          match: OBJECT("media/a.png"),
          status: 400,
          body: { error: "Bucket not found" },
        },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "media" } },
        { method: "POST", match: OBJECT("media/a.png"), body: {} },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyStorageCp(
        cpFlags({ src: join(tmp.current, "media"), dst: "ss://", recursive: true }),
      ).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      const create = requests.find(
        (r) => r.method === "POST" && r.url.endsWith("/storage/v1/bucket"),
      );
      // The bucket is created with its configured `public` property.
      const createBody = create?.body as { public?: boolean } | undefined;
      expect(createBody?.public).toBe(true);
    });
  });

  it.live("fails with Object not found when a recursive download is empty", () => {
    const { layer } = setupLegacyStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      routes: [{ method: "POST", match: LIST("private"), body: [] }],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyStorageCp(
        cpFlags({ src: "ss:///private/empty/", dst: join(tmp.current, "dl"), recursive: true }),
      ).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("Object not found: /private/empty/");
    });
  });

  it.live("runs already-queued downloads when the walk errors partway (errors.Join parity)", () => {
    const dst = join(tmp.current, "partial");
    const { layer } = setupLegacyStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      routes: [
        // Root list queues a.txt (file) and discovers folder/ (recursed next).
        {
          method: "POST",
          match: LIST("private"),
          when: (b) => prefixOf(b) === "",
          body: [
            { name: "a.txt", id: "ai" },
            { name: "folder", id: null },
          ],
        },
        // The folder listing fails mid-walk, after a.txt is already queued.
        {
          method: "POST",
          match: LIST("private"),
          when: (b) => prefixOf(b) === "folder/",
          status: 500,
          body: { error: "boom" },
        },
        { method: "GET", match: OBJECT("private/a.txt"), rawBody: "a-content" },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyStorageCp(
        cpFlags({ src: "ss:///private/", dst, recursive: true }),
      ).pipe(Effect.provide(layer), Effect.exit);
      // Go's errors.Join(walkErr, jq.Collect()) runs the queued a.txt download
      // (file written) before the walk error surfaces — the command still fails.
      expect(Exit.isFailure(exit)).toBe(true);
      expect(readFileSync(join(dst, "a.txt"), "utf8")).toBe("a-content");
    });
  });

  it.live("rejects copying between buckets", () => {
    const { layer } = setupLegacyStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
    });
    return Effect.gen(function* () {
      const exit = yield* legacyStorageCp(cpFlags({ src: "ss:///a/x", dst: "ss:///b/y" })).pipe(
        Effect.provide(layer),
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("Copying between buckets is not supported");
    });
  });

  it.live("rejects a local-to-local copy with a cp -r suggestion", () => {
    const { layer } = setupLegacyStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
    });
    return Effect.gen(function* () {
      const exit = yield* legacyStorageCp(cpFlags({ src: "./a", dst: "./b" })).pipe(
        Effect.provide(layer),
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      const json = JSON.stringify(exit);
      expect(json).toContain("Unsupported operation");
      expect(json).toContain("to copy between local directories");
    });
  });

  it.live("fails on an invalid src url without any network call", () => {
    const { layer, requests } = setupLegacyStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
    });
    return Effect.gen(function* () {
      const exit = yield* legacyStorageCp(cpFlags({ src: ":", dst: "." })).pipe(
        Effect.provide(layer),
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      const json = JSON.stringify(exit);
      expect(json).toContain("failed to parse src url");
      expect(json).toContain("missing protocol scheme");
      expect(requests).toHaveLength(0);
    });
  });

  it.live("fails when the recursive upload source is missing", () => {
    const { layer } = setupLegacyStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
    });
    return Effect.gen(function* () {
      const exit = yield* legacyStorageCp(
        cpFlags({ src: join(tmp.current, "missing"), dst: "ss:///private", recursive: true }),
      ).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    });
  });

  it.live("emits an { uploaded, downloaded } result in json mode", () => {
    writeFileSync(join(tmp.current, "readme.md"), "hello");
    const { layer, out } = setupLegacyStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      format: "json",
      routes: [{ method: "POST", match: OBJECT("private/readme.md"), body: {} }],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyStorageCp(
        cpFlags({ src: join(tmp.current, "readme.md"), dst: "ss:///private/readme.md" }),
      ).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      const success = out.messages.find((m) => m.type === "success");
      const uploaded = success?.data?.["uploaded"] as Array<{ to: string }>;
      expect(uploaded?.[0]?.to).toBe("/private/readme.md");
      expect(existsSync(join(tmp.current, "readme.md"))).toBe(true);
    });
  });

  it.live("targets the linked project's Storage host and flushes telemetry on upload", () => {
    writeFileSync(join(tmp.current, "readme.md"), "hello world");
    const { layer, requests, telemetry, linkedCache } = setupLegacyStorage(tmp.current, {
      // No `--local`, so the linked path resolves the ref + service-role key.
      routes: [{ method: "POST", match: OBJECT("private/readme.md"), body: {} }],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyStorageCp(
        cpFlags({
          src: join(tmp.current, "readme.md"),
          dst: "ss:///private/readme.md",
          local: false,
        }),
      ).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(
        requests.some((r) => r.url.startsWith(`https://${LEGACY_VALID_REF}.supabase.co`)),
      ).toBe(true);
      expect(telemetry.flushed).toBe(true);
      expect(linkedCache.cached).toBe(true);
      expect(linkedCache.cachedRef).toBe(LEGACY_VALID_REF);
    });
  });

  it.live("propagates a non-200 from the gateway on upload", () => {
    writeFileSync(join(tmp.current, "readme.md"), "hello");
    const { layer } = setupLegacyStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      routes: [
        {
          method: "POST",
          match: OBJECT("private/readme.md"),
          status: 503,
          body: { message: "unavailable" },
        },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyStorageCp(
        cpFlags({ src: join(tmp.current, "readme.md"), dst: "ss:///private/readme.md" }),
      ).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("Error status 503");
    });
  });

  it.live("emits the uploaded result as a streamed event in stream-json mode", () => {
    writeFileSync(join(tmp.current, "readme.md"), "hello");
    const { layer, out } = setupLegacyStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      format: "stream-json",
      routes: [{ method: "POST", match: OBJECT("private/readme.md"), body: {} }],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyStorageCp(
        cpFlags({ src: join(tmp.current, "readme.md"), dst: "ss:///private/readme.md" }),
      ).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      const success = out.messages.find((m) => m.type === "success");
      const uploaded = success?.data?.["uploaded"] as Array<{ to: string }>;
      expect(uploaded?.[0]?.to).toBe("/private/readme.md");
    });
  });

  it.live("clamps --jobs below 1 to a single worker", () => {
    writeFileSync(join(tmp.current, "readme.md"), "hello");
    const { layer, requests } = setupLegacyStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      routes: [{ method: "POST", match: OBJECT("private/readme.md"), body: {} }],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyStorageCp(
        cpFlags({
          src: join(tmp.current, "readme.md"),
          dst: "ss:///private/readme.md",
          jobs: 0,
        }),
      ).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(requests.some((r) => r.url.includes(OBJECT("private/readme.md")))).toBe(true);
    });
  });

  it.live("downloads nested objects in parallel with --jobs 2", () => {
    const dst = join(tmp.current, "dl-parallel");
    const { layer } = setupLegacyStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      routes: [
        {
          method: "POST",
          match: LIST("private"),
          body: [
            { name: "a.txt", id: "ai" },
            { name: "b.txt", id: "bi" },
          ],
        },
        { method: "GET", match: OBJECT("private/a.txt"), rawBody: "a-content" },
        { method: "GET", match: OBJECT("private/b.txt"), rawBody: "b-content" },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyStorageCp(
        cpFlags({ src: "ss:///private/", dst, recursive: true, jobs: 2 }),
      ).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(readFileSync(join(dst, "a.txt"), "utf8")).toBe("a-content");
      expect(readFileSync(join(dst, "b.txt"), "utf8")).toBe("b-content");
    });
  });
});
