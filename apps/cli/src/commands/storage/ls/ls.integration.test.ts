import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { VALID_REF } from "../../../../tests/helpers/command-mocks.ts";
import { setupStorage } from "../../../../tests/helpers/storage.ts";
import { useTempWorkdir } from "../../../../tests/helpers/command-mocks.ts";
import { storageLs } from "./ls.handler.ts";
import type { StorageLsFlags } from "./ls.command.ts";

const BUCKET = "/storage/v1/bucket";
const LIST = (bucket: string) => `/storage/v1/object/list/${bucket}`;

function writeAncestorConfig(root: string, toml: string): void {
  const dir = join(root, "supabase");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.toml"), toml);
}

function lsFlags(
  opts: { path?: string; recursive?: boolean; local?: boolean } = {},
): StorageLsFlags {
  // `local` drives routing (default true here — most tests use the local stack).
  return {
    path: opts.path === undefined ? Option.none() : Option.some(opts.path),
    recursive: opts.recursive ?? false,
    linked: true,
    local: opts.local ?? true,
    projectRef: Option.none(),
  };
}

describe("legacy storage ls", () => {
  const tmp = useTempWorkdir("supabase-storage-ls-");

  it.live("lists buckets at the root, filtered by the bucket prefix", () => {
    const { layer, out } = setupStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      routes: [
        {
          method: "GET",
          match: BUCKET,
          body: [
            { name: "test", id: "test" },
            { name: "private", id: "private" },
          ],
        },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* storageLs(lsFlags({ path: "ss:///te" })).pipe(
        Effect.provide(layer),
        Effect.exit,
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      // Only the prefix-matching bucket is printed, with a trailing slash.
      expect(out.stdoutText).toBe("test/\n");
    });
  });

  it.live("lists objects under a prefix, dirs get a trailing slash", () => {
    const { layer, out } = setupStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      routes: [
        {
          method: "POST",
          match: LIST("bucket"),
          body: [
            { name: "folder", id: null },
            { name: "abstract.pdf", id: "9b7f9f48" },
          ],
        },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* storageLs(lsFlags({ path: "ss:///bucket/" })).pipe(
        Effect.provide(layer),
        Effect.exit,
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stdoutText).toBe("folder/\nabstract.pdf\n");
    });
  });

  it.live("paginates past PAGE_LIMIT and reports Loading page on stderr", () => {
    const page0 = Array.from({ length: 100 }, (_, i) => ({ name: `f${i}`, id: `${i}` }));
    const { layer, out, requests } = setupStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      routes: [
        { method: "POST", match: LIST("bucket"), when: (b) => !hasOffset(b), body: page0 },
        { method: "POST", match: LIST("bucket"), when: (b) => hasOffset(b), body: [] },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* storageLs(lsFlags({ path: "ss:///bucket/dir/" })).pipe(
        Effect.provide(layer),
        Effect.exit,
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stderrText).toContain("Loading page: 1");
      expect(out.stdoutText.split("\n").filter(Boolean)).toHaveLength(100);
      // Two list calls: page 0 (offset omitted) then page 1 (offset 100).
      const lists = requests.filter((r) => r.url.includes(LIST("bucket")));
      expect(lists).toHaveLength(2);
      const secondBody = lists[1]?.body as { offset?: number } | undefined;
      expect(secondBody?.offset).toBe(100);
    });
  });

  it.live("recursively walks nested dirs and reports an empty bucket", () => {
    const { layer, out } = setupStorage(tmp.current, {
      local: true,
      toml: 'project_id = "test"\n',
      routes: [
        // root → buckets
        {
          method: "GET",
          match: BUCKET,
          body: [
            { name: "test", id: "test" },
            { name: "private", id: "private" },
          ],
        },
        // empty bucket "test"
        { method: "POST", match: LIST("test"), body: [] },
        // "private" → a folder
        {
          method: "POST",
          match: LIST("private"),
          when: (b) => prefixOf(b) === "",
          body: [{ name: "folder", id: null }],
        },
        // "private/folder/" → a file
        {
          method: "POST",
          match: LIST("private"),
          when: (b) => prefixOf(b) === "folder/",
          body: [{ name: "abstract.pdf", id: "id" }],
        },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* storageLs(lsFlags({ recursive: true })).pipe(
        Effect.provide(layer),
        Effect.exit,
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      const lines = out.stdoutText.split("\n").filter(Boolean);
      // Default path is `ss:///` → remotePath `/`, so basePath is `/` and file
      // paths get a leading slash; an empty bucket is reported bare as `<bucket>/`.
      expect(lines).toContain("test/");
      expect(lines).toContain("/private/folder/abstract.pdf");
    });
  });

  it.live("fails on an invalid url without any network call", () => {
    const { layer, requests } = setupStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
    });
    return Effect.gen(function* () {
      const exit = yield* storageLs(lsFlags({ path: "ss://bucket" })).pipe(
        Effect.provide(layer),
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("URL must match pattern ss:///bucket/[prefix]");
      expect(requests).toHaveLength(0);
    });
  });

  it.live("surfaces a url-parse error (missing protocol scheme)", () => {
    const { layer } = setupStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
    });
    return Effect.gen(function* () {
      const exit = yield* storageLs(lsFlags({ path: ":" })).pipe(
        Effect.provide(layer),
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      const json = JSON.stringify(exit);
      expect(json).toContain("failed to parse storage url");
      expect(json).toContain("missing protocol scheme");
    });
  });

  it.live("propagates a 503 from the bucket service", () => {
    const { layer } = setupStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      routes: [{ method: "GET", match: BUCKET, status: 503, body: { message: "unavailable" } }],
    });
    return Effect.gen(function* () {
      const exit = yield* storageLs(lsFlags()).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("Error status 503");
    });
  });

  it.live("targets the linked project's Storage host and flushes telemetry", () => {
    const { layer, requests, telemetry, linkedCache } = setupStorage(tmp.current, {
      // No `--local`, so the linked path resolves the ref + service-role key.
      routes: [
        {
          method: "GET",
          match: BUCKET,
          body: [{ name: "remote", id: "remote" }],
        },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* storageLs(lsFlags({ local: false })).pipe(
        Effect.provide(layer),
        Effect.exit,
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(requests.some((r) => r.url.startsWith(`https://${VALID_REF}.supabase.co`))).toBe(true);
      expect(telemetry.flushed).toBe(true);
      expect(linkedCache.cached).toBe(true);
      expect(linkedCache.cachedRef).toBe(VALID_REF);
    });
  });

  it.live("lists the project given via --project-ref, overriding VALID_REF", () => {
    // `opts.projectRef` (the fake's own fallback) is left at its default
    // (VALID_REF) — the flag must win over it and drive the gateway host.
    const FLAG_REF = "flagflagflagflagflag";
    const { layer, requests, linkedCache } = setupStorage(tmp.current, {
      routes: [{ method: "GET", match: BUCKET, body: [{ name: "remote", id: "remote" }] }],
    });
    return Effect.gen(function* () {
      const exit = yield* storageLs({
        ...lsFlags({ local: false }),
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
    });
    return Effect.gen(function* () {
      const exit = yield* storageLs({
        ...lsFlags({ local: true }),
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

  it.live("emits a { paths } result in json mode", () => {
    const { layer, out } = setupStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      format: "json",
      routes: [{ method: "GET", match: BUCKET, body: [{ name: "test", id: "test" }] }],
    });
    return Effect.gen(function* () {
      const exit = yield* storageLs(lsFlags()).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      // No streamed stdout lines in json mode; a single result carries the paths.
      expect(out.stdoutText).toBe("");
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data?.["paths"]).toEqual(["test/"]);
    });
  });

  it.live("paginates without the Loading page line in json mode", () => {
    const page0 = Array.from({ length: 100 }, (_, i) => ({ name: `f${i}`, id: `${i}` }));
    const { layer, out } = setupStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      format: "stream-json",
      routes: [
        { method: "POST", match: LIST("bucket"), when: (b) => !hasOffset(b), body: page0 },
        { method: "POST", match: LIST("bucket"), when: (b) => hasOffset(b), body: [] },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* storageLs(lsFlags({ path: "ss:///bucket/dir/" })).pipe(
        Effect.provide(layer),
        Effect.exit,
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      // json/stream-json suppress the pagination notice.
      expect(out.stderrText).not.toContain("Loading page");
    });
  });

  it.live(
    "fails with a missing-project error when --workdir names a config-less subdirectory of a real ancestor project",
    () => {
      // CLI-2285 regression, `loadStorageConfig`'s shared path: the
      // ancestor project genuinely has a valid config.toml, and the
      // subdirectory genuinely has none of its own — an EXPLICIT --workdir
      // must never silently climb to the ancestor's config.
      writeAncestorConfig(tmp.current, 'project_id = "test"\n[api]\nport = 65432\n');
      const sub = join(tmp.current, "nested", "dir");
      mkdirSync(sub, { recursive: true });
      const { layer, requests } = setupStorage(sub, {
        local: true,
        explicitWorkdir: true,
        routes: [{ method: "GET", match: BUCKET, body: [{ name: "test", id: "test" }] }],
      });
      return Effect.gen(function* () {
        const exit = yield* storageLs(lsFlags()).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(JSON.stringify(exit)).toContain("StorageMissingProjectConfigError");
        expect(requests).toHaveLength(0);
      });
    },
  );

  it.live(
    "a remote (--linked) target with the same config-less explicit workdir still succeeds",
    () => {
      // The missing-project hard-fail is LOCAL-only: `resolveStorageCredentials`
      // never reads local config on the remote path (Management API credentials
      // only), so a config-less explicit workdir poses none of the "retargets a
      // different local stack" risk the local-target hard-fail guards against.
      writeAncestorConfig(tmp.current, 'project_id = "test"\n[api]\nport = 65432\n');
      const sub = join(tmp.current, "nested", "dir");
      mkdirSync(sub, { recursive: true });
      const { layer, requests } = setupStorage(sub, {
        explicitWorkdir: true,
        routes: [{ method: "GET", match: BUCKET, body: [{ name: "remote", id: "remote" }] }],
      });
      return Effect.gen(function* () {
        const exit = yield* storageLs(lsFlags({ local: false })).pipe(
          Effect.provide(layer),
          Effect.exit,
        );
        expect(Exit.isSuccess(exit)).toBe(true);
        expect(requests.some((r) => r.url.startsWith(`https://${VALID_REF}.supabase.co`))).toBe(
          true,
        );
      });
    },
  );

  it.live(
    "hints at the ancestor's --workdir when it genuinely has a project (shared helper propagation)",
    () => {
      // Confirms `missingProjectConfigMessageEffect`'s "Did you mean"
      // hint is not `config diff`-specific wiring — the full regression and
      // its negative counterpart are pinned in
      // config/diff/diff.integration.test.ts; this only proves the shared
      // helper reaches storage's own missing-project message too.
      writeAncestorConfig(tmp.current, 'project_id = "test"\n[api]\nport = 65432\n');
      const sub = join(tmp.current, "nested", "dir");
      mkdirSync(sub, { recursive: true });
      const { layer, requests } = setupStorage(sub, {
        local: true,
        explicitWorkdir: true,
      });
      return Effect.gen(function* () {
        const exit = yield* storageLs(lsFlags()).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(JSON.stringify(exit)).toContain(`Did you mean --workdir ${tmp.current}?`);
        expect(requests).toHaveLength(0);
      });
    },
  );

  it.live(
    "an explicit --workdir naming a directory that does not exist at all fails before any config load",
    () => {
      const missing = join(tmp.current, "does-not-exist");
      const { layer, requests } = setupStorage(missing, {
        local: true,
        explicitWorkdir: true,
      });
      return Effect.gen(function* () {
        const exit = yield* storageLs(lsFlags()).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(JSON.stringify(exit)).toContain("StorageWorkdirError");
        expect(JSON.stringify(exit)).toContain("failed to change workdir: chdir");
        expect(requests).toHaveLength(0);
      });
    },
  );
});

function hasOffset(body: unknown): boolean {
  return typeof body === "object" && body !== null && "offset" in body;
}

function prefixOf(body: unknown): string {
  return typeof body === "object" &&
    body !== null &&
    typeof (body as { prefix?: unknown }).prefix === "string"
    ? (body as { prefix: string }).prefix
    : "";
}
