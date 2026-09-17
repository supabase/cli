import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Option, Path } from "effect";

import { setupStorage } from "../../../../tests/helpers/storage.ts";
import { VALID_REF, useTempWorkdir } from "../../../../tests/helpers/command-mocks.ts";
import { StackStorageCapabilityError } from "../../../command-internal/stack-storage.ts";
import { StorageUnsupportedOperationError } from "../storage.errors.ts";
import { storageCp } from "./cp.handler.ts";
import type { StorageCpFlags } from "./cp.command.ts";

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
}): StorageCpFlags {
  return {
    src: opts.src,
    dst: opts.dst,
    recursive: opts.recursive ?? false,
    cacheControl: opts.cacheControl === undefined ? Option.none() : Option.some(opts.cacheControl),
    contentType: opts.contentType === undefined ? Option.none() : Option.some(opts.contentType),
    jobs: opts.jobs === undefined ? Option.none() : Option.some(opts.jobs),
    linked: true,
    local: opts.local ?? true,
    projectRef: Option.none(),
  };
}

function prefixOf(body: unknown): string {
  return typeof body === "object" &&
    body !== null &&
    typeof (body as { prefix?: unknown }).prefix === "string"
    ? (body as { prefix: string }).prefix
    : "";
}

function failureErrors<A, E>(exit: Exit.Exit<A, E>): ReadonlyArray<E> {
  if (!Exit.isFailure(exit)) return [];
  expect(exit.cause.reasons.every(Cause.isFailReason)).toBe(true);
  return exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error);
}

describe("storage cp", () => {
  const tmp = useTempWorkdir("supabase-storage-cp-");

  it.live("uploads a single local file with a sniffed content-type", () => {
    const { layer, requests } = setupStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      routes: [{ method: "POST", match: OBJECT("private/readme.md"), body: {} }],
    });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.writeFileString(path.join(tmp.current, "readme.md"), "hello world");
      const exit = yield* storageCp(
        cpFlags({ src: path.join(tmp.current, "readme.md"), dst: "ss:///private/readme.md" }),
      ).pipe(Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      const upload = requests.find((r) => r.url.includes(OBJECT("private/readme.md")));
      expect(upload?.method).toBe("POST");
      // Single upload doesn't set x-upsert (overwrite stays false).
      expect(upload?.headers["x-upsert"]).toBeUndefined();
      expect(upload?.headers["cache-control"]).toBe("max-age=3600");
      expect(upload?.headers["content-type"]).toContain("text/plain");
    }).pipe(Effect.provide(layer));
  });

  it.live("honors --content-type and --cache-control on upload", () => {
    const { layer, requests } = setupStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      routes: [{ method: "POST", match: OBJECT("private/data.bin"), body: {} }],
    });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.writeFileString(path.join(tmp.current, "data.bin"), "hello");
      const exit = yield* storageCp(
        cpFlags({
          src: path.join(tmp.current, "data.bin"),
          dst: "ss:///private/data.bin",
          contentType: "application/custom",
          cacheControl: "max-age=60",
        }),
      ).pipe(Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      const upload = requests.find((r) => r.url.includes(OBJECT("private/data.bin")));
      expect(upload?.headers["content-type"]).toBe("application/custom");
      expect(upload?.headers["cache-control"]).toBe("max-age=60");
    }).pipe(Effect.provide(layer));
  });

  it.live("recursively uploads a directory, auto-creating a missing bucket", () => {
    const { layer, requests } = setupStorage(tmp.current, {
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
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.join(tmp.current, "upload"), { recursive: true });
      yield* fs.writeFileString(path.join(tmp.current, "upload", "readme.md"), "hello");
      const exit = yield* storageCp(
        cpFlags({ src: path.join(tmp.current, "upload"), dst: "ss://", recursive: true }),
      ).pipe(Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      // Recursive uploads set x-upsert; bucket auto-created then upload retried.
      const uploads = requests.filter((r) => r.url.includes(OBJECT("upload/readme.md")));
      expect(uploads).toHaveLength(2);
      expect(uploads[1]?.headers["x-upsert"]).toBe("true");
      expect(
        requests.some((r) => r.method === "POST" && r.url.endsWith("/storage/v1/bucket")),
      ).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("downloads a single remote object to a new local file", () => {
    const { layer } = setupStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      routes: [{ method: "GET", match: OBJECT("private/readme.md"), rawBody: "downloaded-bytes" }],
    });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dst = path.join(tmp.current, "out.md");
      const exit = yield* storageCp(cpFlags({ src: "ss:///private/readme.md", dst })).pipe(
        Effect.exit,
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(yield* fs.readFileString(dst)).toBe("downloaded-bytes");
    }).pipe(Effect.provide(layer));
  });

  it.live("refuses to overwrite an existing local file on a single download", () => {
    const { layer } = setupStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      routes: [{ method: "GET", match: OBJECT("private/readme.md"), rawBody: "new" }],
    });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dst = path.join(tmp.current, "exists.md");
      yield* fs.writeFileString(dst, "original");
      const exit = yield* storageCp(cpFlags({ src: "ss:///private/readme.md", dst })).pipe(
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("failed to create file");
      }
      // The existing file is untouched.
      expect(yield* fs.readFileString(dst)).toBe("original");
    }).pipe(Effect.provide(layer));
  });

  it.live("recursively downloads nested objects, creating parent dirs", () => {
    const { layer } = setupStorage(tmp.current, {
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
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dst = path.join(tmp.current, "dl");
      const exit = yield* storageCp(cpFlags({ src: "ss:///private/", dst, recursive: true })).pipe(
        Effect.exit,
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(yield* fs.readFileString(path.join(dst, "a.txt"))).toBe("a-content");
      expect(yield* fs.readFileString(path.join(dst, "folder", "b.txt"))).toBe("b-content");
    }).pipe(Effect.provide(layer));
  });

  it.live("recursively downloads into an existing directory (nests under the remote base)", () => {
    const { layer } = setupStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      routes: [
        { method: "POST", match: LIST("private"), body: [{ name: "a.txt", id: "ai" }] },
        { method: "GET", match: OBJECT("private/a.txt"), rawBody: "a" },
      ],
    });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dst = path.join(tmp.current, "existing");
      yield* fs.makeDirectory(dst, { recursive: true });
      const exit = yield* storageCp(cpFlags({ src: "ss:///private/", dst, recursive: true })).pipe(
        Effect.exit,
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      // Existing dir → nest under base("/private/") = "private".
      expect(yield* fs.readFileString(path.join(dst, "private", "a.txt"))).toBe("a");
    }).pipe(Effect.provide(layer));
  });

  it.live("creates a directory for an empty bucket on recursive download", () => {
    const { layer } = setupStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      routes: [
        { method: "GET", match: BUCKET, body: [{ name: "empty", id: "empty" }] },
        { method: "POST", match: LIST("empty"), body: [] },
      ],
    });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dst = path.join(tmp.current, "dl-empty");
      const exit = yield* storageCp(cpFlags({ src: "ss:///", dst, recursive: true })).pipe(
        Effect.exit,
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      // Empty bucket reported as "empty/" → mkdir under the destination.
      expect(yield* fs.exists(path.join(dst, "empty"))).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("recursively uploads a nested subdirectory", () => {
    const { layer, requests } = setupStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      routes: [
        { method: "POST", match: LIST("private"), body: [{ name: "dir", id: null }] },
        { method: "POST", match: OBJECT("private/dir/tree/top.txt"), body: {} },
        { method: "POST", match: OBJECT("private/dir/tree/sub/nested.txt"), body: {} },
      ],
    });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.join(tmp.current, "tree", "sub"), { recursive: true });
      yield* fs.writeFileString(path.join(tmp.current, "tree", "top.txt"), "t");
      yield* fs.writeFileString(path.join(tmp.current, "tree", "sub", "nested.txt"), "n");
      const exit = yield* storageCp(
        cpFlags({
          src: path.join(tmp.current, "tree"),
          dst: "ss:///private/dir/",
          recursive: true,
        }),
      ).pipe(Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(requests.some((r) => r.url.includes(OBJECT("private/dir/tree/sub/nested.txt")))).toBe(
        true,
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("auto-creates a bucket using its config from supabase/config.toml", () => {
    const { layer, requests } = setupStorage(tmp.current, {
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
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.join(tmp.current, "media"), { recursive: true });
      yield* fs.writeFileString(path.join(tmp.current, "media", "a.png"), "x");
      const exit = yield* storageCp(
        cpFlags({ src: path.join(tmp.current, "media"), dst: "ss://", recursive: true }),
      ).pipe(Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      const create = requests.find(
        (r) => r.method === "POST" && r.url.endsWith("/storage/v1/bucket"),
      );
      // The bucket is created with its configured `public` property.
      const createBody = create?.body as { public?: boolean } | undefined;
      expect(createBody?.public).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with Object not found when a recursive download is empty", () => {
    const { layer } = setupStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      routes: [{ method: "POST", match: LIST("private"), body: [] }],
    });
    return Effect.gen(function* () {
      const path = yield* Path.Path;
      const exit = yield* storageCp(
        cpFlags({
          src: "ss:///private/empty/",
          dst: path.join(tmp.current, "dl"),
          recursive: true,
        }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("Object not found: /private/empty/");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("runs already-queued downloads when the walk errors partway (errors.Join parity)", () => {
    const { layer } = setupStorage(tmp.current, {
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
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dst = path.join(tmp.current, "partial");
      const exit = yield* storageCp(cpFlags({ src: "ss:///private/", dst, recursive: true })).pipe(
        Effect.exit,
      );
      // The queued a.txt download runs (file written) before the walk error
      // surfaces — the command still fails.
      expect(Exit.isFailure(exit)).toBe(true);
      expect(yield* fs.readFileString(path.join(dst, "a.txt"))).toBe("a-content");
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects copying between buckets", () => {
    const { layer } = setupStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
    });
    return Effect.gen(function* () {
      const exit = yield* storageCp(cpFlags({ src: "ss:///a/x", dst: "ss:///b/y" })).pipe(
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("Copying between buckets is not supported");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects a local-to-local copy with a cp -r suggestion", () => {
    const { layer } = setupStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
    });
    return Effect.gen(function* () {
      const exit = yield* storageCp(cpFlags({ src: "./a", dst: "./b" })).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      const unsupported = failureErrors(exit).find(
        (error) => error instanceof StorageUnsupportedOperationError,
      );
      expect(unsupported).toBeInstanceOf(StorageUnsupportedOperationError);
      expect(unsupported?.message).toContain("Unsupported operation");
      expect(unsupported?.suggestion).toContain("to copy between local directories");
    }).pipe(Effect.provide(layer));
  });

  it.live("fails on an invalid src url without any network call", () => {
    const { layer, requests } = setupStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
    });
    return Effect.gen(function* () {
      const exit = yield* storageCp(cpFlags({ src: ":", dst: "." })).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("failed to parse src url");
        expect(causeText).toContain("missing protocol scheme");
      }
      expect(requests).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when the recursive upload source is missing", () => {
    const { layer } = setupStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
    });
    return Effect.gen(function* () {
      const path = yield* Path.Path;
      const exit = yield* storageCp(
        cpFlags({ src: path.join(tmp.current, "missing"), dst: "ss:///private", recursive: true }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("emits an { uploaded, downloaded } result in json mode", () => {
    const { layer, out } = setupStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      format: "json",
      routes: [{ method: "POST", match: OBJECT("private/readme.md"), body: {} }],
    });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.writeFileString(path.join(tmp.current, "readme.md"), "hello");
      const exit = yield* storageCp(
        cpFlags({ src: path.join(tmp.current, "readme.md"), dst: "ss:///private/readme.md" }),
      ).pipe(Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      const success = out.messages.find((m) => m.type === "success");
      const uploaded = success?.data?.["uploaded"] as Array<{ to: string }>;
      expect(uploaded?.[0]?.to).toBe("/private/readme.md");
      expect(yield* fs.exists(path.join(tmp.current, "readme.md"))).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("targets the linked project's Storage host and flushes telemetry on upload", () => {
    const { layer, requests, telemetry, linkedCache } = setupStorage(tmp.current, {
      // No `--local`, so the linked path resolves the ref + service-role key.
      routes: [{ method: "POST", match: OBJECT("private/readme.md"), body: {} }],
    });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.writeFileString(path.join(tmp.current, "readme.md"), "hello world");
      const exit = yield* storageCp(
        cpFlags({
          src: path.join(tmp.current, "readme.md"),
          dst: "ss:///private/readme.md",
          local: false,
        }),
      ).pipe(Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(requests.some((r) => r.url.startsWith(`https://${VALID_REF}.supabase.co`))).toBe(true);
      expect(telemetry.flushed).toBe(true);
      expect(linkedCache.cached).toBe(true);
      expect(linkedCache.cachedRef).toBe(VALID_REF);
    }).pipe(Effect.provide(layer));
  });

  it.live("uploads to the project given via --project-ref, overriding VALID_REF", () => {
    // The fake's own fallback stays at its default (VALID_REF); the flag must win and drive
    // the gateway host.
    const FLAG_REF = "flagflagflagflagflag";
    const { layer, requests, linkedCache } = setupStorage(tmp.current, {
      routes: [{ method: "POST", match: OBJECT("private/readme.md"), body: {} }],
    });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.writeFileString(path.join(tmp.current, "readme.md"), "hello world");
      const exit = yield* storageCp({
        ...cpFlags({ src: path.join(tmp.current, "readme.md"), dst: "ss:///private/readme.md" }),
        local: false,
        projectRef: Option.some(FLAG_REF),
      }).pipe(Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(requests.some((r) => r.url.startsWith(`https://${FLAG_REF}.supabase.co`))).toBe(true);
      expect(requests.some((r) => r.url.includes(VALID_REF))).toBe(false);
      expect(linkedCache.cached).toBe(true);
      expect(linkedCache.cachedRef).toBe(FLAG_REF);
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects --project-ref combined with --local", () => {
    const FLAG_REF = "flagflagflagflagflag";
    const { layer, requests, linkedCache } = setupStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
    });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.writeFileString(path.join(tmp.current, "readme.md"), "hello world");
      const exit = yield* storageCp({
        ...cpFlags({ src: path.join(tmp.current, "readme.md"), dst: "ss:///private/readme.md" }),
        local: true,
        projectRef: Option.some(FLAG_REF),
      }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain(
          "--project-ref only applies when targeting the linked project; use it with --linked (not --local)",
        );
      }
      expect(requests).toHaveLength(0);
      expect(linkedCache.cached).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("propagates a non-200 from the gateway on upload", () => {
    const { layer } = setupStorage(tmp.current, {
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
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.writeFileString(path.join(tmp.current, "readme.md"), "hello");
      const exit = yield* storageCp(
        cpFlags({ src: path.join(tmp.current, "readme.md"), dst: "ss:///private/readme.md" }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("Error status 503");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("emits the uploaded result as a streamed event in stream-json mode", () => {
    const { layer, out } = setupStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      format: "stream-json",
      routes: [{ method: "POST", match: OBJECT("private/readme.md"), body: {} }],
    });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.writeFileString(path.join(tmp.current, "readme.md"), "hello");
      const exit = yield* storageCp(
        cpFlags({ src: path.join(tmp.current, "readme.md"), dst: "ss:///private/readme.md" }),
      ).pipe(Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      const success = out.messages.find((m) => m.type === "success");
      const uploaded = success?.data?.["uploaded"] as Array<{ to: string }>;
      expect(uploaded?.[0]?.to).toBe("/private/readme.md");
    }).pipe(Effect.provide(layer));
  });

  it.live("clamps --jobs below 1 to a single worker", () => {
    const { layer, requests } = setupStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      routes: [{ method: "POST", match: OBJECT("private/readme.md"), body: {} }],
    });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.writeFileString(path.join(tmp.current, "readme.md"), "hello");
      const exit = yield* storageCp(
        cpFlags({
          src: path.join(tmp.current, "readme.md"),
          dst: "ss:///private/readme.md",
          jobs: 0,
        }),
      ).pipe(Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(requests.some((r) => r.url.includes(OBJECT("private/readme.md")))).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("downloads nested objects in parallel with --jobs 2", () => {
    const { layer } = setupStorage(tmp.current, {
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
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dst = path.join(tmp.current, "dl-parallel");
      const exit = yield* storageCp(
        cpFlags({ src: "ss:///private/", dst, recursive: true, jobs: 2 }),
      ).pipe(Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(yield* fs.readFileString(path.join(dst, "a.txt"))).toBe("a-content");
      expect(yield* fs.readFileString(path.join(dst, "b.txt"))).toBe("b-content");
    }).pipe(Effect.provide(layer));
  });
});

describe("stack backend", () => {
  const tmp = useTempWorkdir("supabase-storage-cp-stack-");

  it.live("uploads through the stack's api endpoint and JWT", () => {
    const { layer, requests } = setupStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      stackBackend: true,
      stackApi: { apiEndpoint: "http://127.0.0.1:59999", serviceRoleJwt: "stack-jwt" },
      routes: [{ method: "POST", match: OBJECT("private/readme.md"), body: {} }],
    });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.writeFileString(path.join(tmp.current, "readme.md"), "hello world");
      const exit = yield* storageCp(
        cpFlags({ src: path.join(tmp.current, "readme.md"), dst: "ss:///private/readme.md" }),
      ).pipe(Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url.startsWith("http://127.0.0.1:59999")).toBe(true);
      expect(requests[0]?.headers["apikey"]).toBe("stack-jwt");
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "fails with StackStorageCapabilityError when Storage is disabled, before any request",
    () => {
      const { layer, requests } = setupStorage(tmp.current, {
        toml: 'project_id = "test"\n',
        local: true,
        stackBackend: true,
        stackApi: { storageState: "disabled" },
      });
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.writeFileString(path.join(tmp.current, "readme.md"), "hello world");
        const exit = yield* storageCp(
          cpFlags({ src: path.join(tmp.current, "readme.md"), dst: "ss:///private/readme.md" }),
        ).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        const capability = failureErrors(exit).find(
          (error) => error instanceof StackStorageCapabilityError,
        );
        expect(capability).toBeInstanceOf(StackStorageCapabilityError);
        expect(capability?.suggestion).toContain("-x storage");
        expect(requests).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "recursively uploads a directory through the stack, auto-creating a missing bucket",
    () => {
      const { layer, requests } = setupStorage(tmp.current, {
        toml: 'project_id = "test"\n',
        local: true,
        stackBackend: true,
        routes: [
          {
            method: "POST",
            match: OBJECT("upload/readme.md"),
            status: 400,
            body: { error: "Bucket not found" },
          },
          { method: "POST", match: "/storage/v1/bucket", body: { name: "upload" } },
          { method: "POST", match: OBJECT("upload/readme.md"), body: {} },
        ],
      });
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.makeDirectory(path.join(tmp.current, "upload"), { recursive: true });
        yield* fs.writeFileString(path.join(tmp.current, "upload", "readme.md"), "hello");
        const exit = yield* storageCp(
          cpFlags({ src: path.join(tmp.current, "upload"), dst: "ss://", recursive: true }),
        ).pipe(Effect.exit);
        expect(Exit.isSuccess(exit)).toBe(true);
        const uploads = requests.filter((r) => r.url.includes(OBJECT("upload/readme.md")));
        expect(uploads).toHaveLength(2);
        expect(uploads[1]?.headers["x-upsert"]).toBe("true");
        expect(
          requests.some((r) => r.method === "POST" && r.url.endsWith("/storage/v1/bucket")),
        ).toBe(true);
      }).pipe(Effect.provide(layer));
    },
  );
});
