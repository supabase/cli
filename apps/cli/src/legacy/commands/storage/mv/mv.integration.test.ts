import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";

import { setupLegacyStorage } from "../../../../../tests/helpers/legacy-storage.ts";
import {
  LEGACY_VALID_REF,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { legacyStorageMv } from "./mv.handler.ts";
import type { LegacyStorageMvFlags } from "./mv.command.ts";

const MOVE = "/storage/v1/object/move";
const LIST = (bucket: string) => `/storage/v1/object/list/${bucket}`;

function mvFlags(opts: {
  src: string;
  dst: string;
  recursive?: boolean;
  local?: boolean;
}): LegacyStorageMvFlags {
  return {
    src: opts.src,
    dst: opts.dst,
    recursive: opts.recursive ?? false,
    linked: true,
    local: opts.local ?? true,
  };
}

describe("legacy storage mv", () => {
  const tmp = useLegacyTempWorkdir("supabase-storage-mv-");

  it.live("moves a single object and prints the response message", () => {
    const { layer, out, requests } = setupLegacyStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      routes: [{ method: "POST", match: MOVE, body: { message: "Successfully moved" } }],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyStorageMv(
        mvFlags({ src: "ss:///private/readme.md", dst: "ss:///private/docs/file" }),
      ).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stderrText).toContain("Moving object: /private/readme.md => /private/docs/file");
      expect(out.stderrText).toContain("Successfully moved");
      const move = requests.find((r) => r.url.includes(MOVE));
      expect(move?.body).toEqual({
        bucketId: "private",
        sourceKey: "readme.md",
        destinationKey: "docs/file",
      });
    });
  });

  it.live("fails with missing path when both sides are bucket roots", () => {
    const { layer, requests } = setupLegacyStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
    });
    return Effect.gen(function* () {
      const exit = yield* legacyStorageMv(mvFlags({ src: "ss:///", dst: "ss:///" })).pipe(
        Effect.provide(layer),
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("You must specify an object path");
      expect(requests).toHaveLength(0);
    });
  });

  it.live("rejects moving between buckets", () => {
    const { layer, requests } = setupLegacyStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
    });
    return Effect.gen(function* () {
      const exit = yield* legacyStorageMv(
        mvFlags({ src: "ss:///bucket/docs", dst: "ss:///private" }),
      ).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("Moving between buckets is unsupported");
      expect(requests).toHaveLength(0);
    });
  });

  it.live("falls back to a recursive move when the direct move is not_found", () => {
    const { layer, requests } = setupLegacyStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      routes: [
        // direct move of the directory → not_found
        {
          method: "POST",
          match: MOVE,
          when: (b) => (b as { destinationKey?: string }).destinationKey === "docs",
          status: 404,
          body: { error: "not_found" },
        },
        // list the source dir → one object
        { method: "POST", match: LIST("private"), body: [{ name: "abstract.pdf", id: "id" }] },
        // per-object move
        {
          method: "POST",
          match: MOVE,
          when: (b) => (b as { sourceKey?: string }).sourceKey === "abstract.pdf",
          body: { message: "ok" },
        },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyStorageMv(
        mvFlags({ src: "ss:///private", dst: "ss:///private/docs", recursive: true }),
      ).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      const perObject = requests.find(
        (r) =>
          r.url.includes(MOVE) && (r.body as { sourceKey?: string }).sourceKey === "abstract.pdf",
      );
      expect(perObject?.body).toEqual({
        bucketId: "private",
        sourceKey: "abstract.pdf",
        destinationKey: "docs/abstract.pdf",
      });
    });
  });

  it.live("recursively moves a nested directory tree", () => {
    const { layer, requests } = setupLegacyStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      routes: [
        {
          method: "POST",
          match: MOVE,
          when: (b) => (b as { sourceKey?: string }).sourceKey === "",
          status: 404,
          body: { error: "not_found" },
        },
        // top level: a subdir + a file
        {
          method: "POST",
          match: LIST("private"),
          when: (b) => (b as { prefix?: string }).prefix === "",
          body: [
            { name: "sub", id: null },
            { name: "a.txt", id: "ai" },
          ],
        },
        {
          method: "POST",
          match: MOVE,
          when: (b) => (b as { sourceKey?: string }).sourceKey === "a.txt",
          body: { message: "ok" },
        },
        // descend into sub/
        {
          method: "POST",
          match: LIST("private"),
          when: (b) => (b as { prefix?: string }).prefix === "sub/",
          body: [{ name: "b.txt", id: "bi" }],
        },
        {
          method: "POST",
          match: MOVE,
          when: (b) => (b as { sourceKey?: string }).sourceKey === "sub/b.txt",
          body: { message: "ok" },
        },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyStorageMv(
        mvFlags({ src: "ss:///private", dst: "ss:///private/docs", recursive: true }),
      ).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      // Nested file moved with the sub/ prefix rewritten under docs/.
      const nested = requests.find(
        (r) => r.url.includes(MOVE) && (r.body as { sourceKey?: string }).sourceKey === "sub/b.txt",
      );
      expect(nested?.body).toEqual({
        bucketId: "private",
        sourceKey: "sub/b.txt",
        destinationKey: "docs/sub/b.txt",
      });
    });
  });

  it.live("propagates a not_found error when not recursive", () => {
    const { layer } = setupLegacyStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      routes: [{ method: "POST", match: MOVE, status: 404, body: { error: "not_found" } }],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyStorageMv(
        mvFlags({ src: "ss:///private/a", dst: "ss:///private/b" }),
      ).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("not_found");
    });
  });

  it.live("fails with Object not found when the recursive move is empty", () => {
    const { layer } = setupLegacyStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      routes: [
        {
          method: "POST",
          match: MOVE,
          status: 404,
          body: { error: "not_found" },
        },
        { method: "POST", match: LIST("private"), body: [] },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyStorageMv(
        mvFlags({ src: "ss:///private/dir", dst: "ss:///private/other", recursive: true }),
      ).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("Object not found: /private/dir/");
    });
  });

  it.live("emits a { message } result in json mode", () => {
    const { layer, out } = setupLegacyStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      format: "json",
      routes: [{ method: "POST", match: MOVE, body: { message: "Successfully moved" } }],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyStorageMv(
        mvFlags({ src: "ss:///private/a", dst: "ss:///private/b" }),
      ).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data?.["message"]).toBe("Successfully moved");
    });
  });

  it.live("targets the linked project's Storage host and flushes telemetry", () => {
    const { layer, requests, telemetry, linkedCache } = setupLegacyStorage(tmp.current, {
      // No `--local`, so the linked path resolves the ref + service-role key.
      routes: [{ method: "POST", match: MOVE, body: { message: "Successfully moved" } }],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyStorageMv(
        mvFlags({ src: "ss:///private/a", dst: "ss:///private/b", local: false }),
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

  it.live("propagates a 503 from the move endpoint even when recursive", () => {
    // Only a `not_found` body triggers the recursive fallback; a 503 must surface.
    const { layer } = setupLegacyStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      routes: [{ method: "POST", match: MOVE, status: 503, body: { message: "unavailable" } }],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyStorageMv(
        mvFlags({ src: "ss:///private/a", dst: "ss:///private/b", recursive: true }),
      ).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("Error status 503");
    });
  });

  it.live(
    'emits a { message: "", moved } result for the recursive fallback in stream-json mode',
    () => {
      const { layer, out } = setupLegacyStorage(tmp.current, {
        toml: 'project_id = "test"\n',
        local: true,
        format: "stream-json",
        routes: [
          {
            method: "POST",
            match: MOVE,
            when: (b) => (b as { destinationKey?: string }).destinationKey === "docs",
            status: 404,
            body: { error: "not_found" },
          },
          { method: "POST", match: LIST("private"), body: [{ name: "abstract.pdf", id: "id" }] },
          {
            method: "POST",
            match: MOVE,
            when: (b) => (b as { sourceKey?: string }).sourceKey === "abstract.pdf",
            body: { message: "ok" },
          },
        ],
      });
      return Effect.gen(function* () {
        const exit = yield* legacyStorageMv(
          mvFlags({ src: "ss:///private", dst: "ss:///private/docs", recursive: true }),
        ).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isSuccess(exit)).toBe(true);
        const success = out.messages.find((m) => m.type === "success");
        expect(success?.data?.["message"]).toBe("");
        expect(success?.data?.["moved"]).toBe(1);
      });
    },
  );

  it.live("recursively moves on the linked path when the direct move is not_found", () => {
    const { layer, requests, telemetry, linkedCache } = setupLegacyStorage(tmp.current, {
      routes: [
        {
          method: "POST",
          match: MOVE,
          when: (b) => (b as { destinationKey?: string }).destinationKey === "docs",
          status: 404,
          body: { error: "not_found" },
        },
        { method: "POST", match: LIST("private"), body: [{ name: "abstract.pdf", id: "id" }] },
        {
          method: "POST",
          match: MOVE,
          when: (b) => (b as { sourceKey?: string }).sourceKey === "abstract.pdf",
          body: { message: "ok" },
        },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacyStorageMv(
        mvFlags({ src: "ss:///private", dst: "ss:///private/docs", recursive: true, local: false }),
      ).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      const perObject = requests.find(
        (r) =>
          r.url.includes(MOVE) && (r.body as { sourceKey?: string }).sourceKey === "abstract.pdf",
      );
      expect(perObject?.url.startsWith(`https://${LEGACY_VALID_REF}.supabase.co`)).toBe(true);
      expect(telemetry.flushed).toBe(true);
      expect(linkedCache.cached).toBe(true);
    });
  });
});
