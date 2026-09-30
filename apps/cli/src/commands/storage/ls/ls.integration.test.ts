import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Option, Path } from "effect";

import { VALID_REF, useTempWorkdir, withEnvVar } from "../../../../tests/helpers/command-mocks.ts";
import { setupStorage, STORAGE_TEST_JWT_SECRET } from "../../../../tests/helpers/storage.ts";
import {
  StackStorageCapabilityError,
  StackStorageUnavailableError,
} from "../../../command-internal/stack-storage.ts";
import { StorageGatewayStatusError } from "../../../command-internal/storage-gateway.errors.ts";
import { storageLs } from "./ls.handler.ts";
import type { StorageLsFlags } from "./ls.command.ts";
import { generateGoJwt } from "../../../command-internal/go-jwt.ts";

const BUCKET = "/storage/v1/bucket";
const LIST = (bucket: string) => `/storage/v1/object/list/${bucket}`;

const writeAncestorConfig = Effect.fnUntraced(function* (root: string, toml: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.join(root, "supabase");
  yield* fs.makeDirectory(dir, { recursive: true });
  yield* fs.writeFileString(path.join(dir, "config.toml"), toml);
});

function failureErrors<A, E>(exit: Exit.Exit<A, E>): ReadonlyArray<E> {
  if (!Exit.isFailure(exit)) return [];
  expect(exit.cause.reasons.every(Cause.isFailReason)).toBe(true);
  return exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error);
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

describe("storage ls", () => {
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
      // Default path `ss:///` → remotePath `/`, so paths get a leading slash and an empty
      // bucket is reported bare as `<bucket>/`.
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
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("URL must match pattern ss:///bucket/[prefix]");
      }
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
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("failed to parse storage url");
        expect(causeText).toContain("missing protocol scheme");
      }
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
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("Error status 503");
      }
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
    // The fake's own fallback stays at its default (VALID_REF); the flag must win and drive
    // the gateway host.
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
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain(
          "--project-ref only applies when targeting the linked project; use it with --linked (not --local)",
        );
      }
      expect(requests).toHaveLength(0);
      expect(linkedCache.cached).toBe(false);
    });
  });

  it.live("signs --local requests with a SUPABASE_AUTH_SERVICE_ROLE_KEY from supabase/.env", () => {
    // The storage frame loads the project dotenv itself, so the auth override must reach the
    // resolver from that walk. Pin the ambient var away so only the dotenv value counts.
    const { layer, requests } = setupStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      files: { "supabase/.env": "SUPABASE_AUTH_SERVICE_ROLE_KEY=sb_secret_dotenv_only_key\n" },
      routes: [{ method: "GET", match: BUCKET, body: [{ name: "test", id: "test" }] }],
    });
    return withEnvVar(
      "SUPABASE_AUTH_SERVICE_ROLE_KEY",
      undefined,
      Effect.gen(function* () {
        const exit = yield* storageLs(lsFlags()).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isSuccess(exit)).toBe(true);
        expect(requests.length).toBeGreaterThan(0);
        expect(requests.every((r) => r.headers["apikey"] === "sb_secret_dotenv_only_key")).toBe(
          true,
        );
      }),
    );
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
      expect(out.stderrText).not.toContain("Loading page");
    });
  });

  it.live(
    "fails with a missing-project error when --workdir names a config-less subdirectory of a real ancestor project",
    () => {
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* writeAncestorConfig(tmp.current, 'project_id = "test"\n[api]\nport = 65432\n');
        const sub = path.join(tmp.current, "nested", "dir");
        yield* fs.makeDirectory(sub, { recursive: true });
        const { layer, requests } = setupStorage(sub, {
          local: true,
          explicitWorkdir: true,
          routes: [{ method: "GET", match: BUCKET, body: [{ name: "test", id: "test" }] }],
        });
        const exit = yield* storageLs(lsFlags()).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.pretty(exit.cause)).toContain("StorageMissingProjectConfigError");
        }
        expect(requests).toHaveLength(0);
      }).pipe(Effect.provide(BunServices.layer));
    },
  );

  it.live(
    "a remote (--linked) target with the same config-less explicit workdir still succeeds",
    () => {
      // The missing-project hard-fail is local-only: `resolveStorageCredentials` never reads
      // local config on the remote path, so a config-less workdir poses none of the risk the
      // local-target hard-fail guards against.
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* writeAncestorConfig(tmp.current, 'project_id = "test"\n[api]\nport = 65432\n');
        const sub = path.join(tmp.current, "nested", "dir");
        yield* fs.makeDirectory(sub, { recursive: true });
        const { layer, requests } = setupStorage(sub, {
          explicitWorkdir: true,
          routes: [{ method: "GET", match: BUCKET, body: [{ name: "remote", id: "remote" }] }],
        });
        const exit = yield* storageLs(lsFlags({ local: false })).pipe(
          Effect.provide(layer),
          Effect.exit,
        );
        expect(Exit.isSuccess(exit)).toBe(true);
        expect(requests.some((r) => r.url.startsWith(`https://${VALID_REF}.supabase.co`))).toBe(
          true,
        );
      }).pipe(Effect.provide(BunServices.layer));
    },
  );

  it.live(
    "hints at the ancestor's --workdir when it genuinely has a project (shared helper propagation)",
    () => {
      // Confirms `missingProjectConfigMessageEffect`'s "Did you mean" hint isn't `config
      // diff`-specific — the full regression is pinned in config/diff/diff.integration.test.ts;
      // this only proves the shared helper reaches storage's message too.
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* writeAncestorConfig(tmp.current, 'project_id = "test"\n[api]\nport = 65432\n');
        const sub = path.join(tmp.current, "nested", "dir");
        yield* fs.makeDirectory(sub, { recursive: true });
        const { layer, requests } = setupStorage(sub, {
          local: true,
          explicitWorkdir: true,
        });
        const exit = yield* storageLs(lsFlags()).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.pretty(exit.cause)).toContain(`Did you mean --workdir ${tmp.current}?`);
        }
        expect(requests).toHaveLength(0);
      }).pipe(Effect.provide(BunServices.layer));
    },
  );

  it.live(
    "an explicit --workdir naming a directory that does not exist at all fails before any config load",
    () => {
      return Effect.gen(function* () {
        const path = yield* Path.Path;
        const missing = path.join(tmp.current, "does-not-exist");
        const { layer, requests } = setupStorage(missing, {
          local: true,
          explicitWorkdir: true,
        });
        const exit = yield* storageLs(lsFlags()).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const causeText = Cause.pretty(exit.cause);
          expect(causeText).toContain("StorageWorkdirError");
          expect(causeText).toContain("failed to change workdir: chdir");
        }
        expect(requests).toHaveLength(0);
      }).pipe(Effect.provide(BunServices.layer));
    },
  );
});

describe("stack backend", () => {
  const tmp = useTempWorkdir("supabase-storage-ls-stack-");

  it.live("routes local requests through the stack's api endpoint and JWT", () => {
    const { layer, requests } = setupStorage(tmp.current, {
      toml: 'project_id = "test"\n[api]\nport = 65000\n',
      local: true,
      stackBackend: true,
      routes: [{ method: "GET", match: BUCKET, body: [{ name: "test", id: "test" }] }],
    });
    return Effect.gen(function* () {
      const exit = yield* storageLs(lsFlags()).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url.startsWith("http://127.0.0.1:59999")).toBe(true);
      const serviceRoleJwt = generateGoJwt(STORAGE_TEST_JWT_SECRET, "service_role");
      expect(requests[0]?.headers["apikey"]).toBe(serviceRoleJwt);
      expect(requests[0]?.headers["authorization"]).toBe(`Bearer ${serviceRoleJwt}`);
    });
  });

  it.live(
    "ignores every legacy config/env input (port, external_url, jwt secret, hostname)",
    () => {
      const { layer, requests } = setupStorage(tmp.current, {
        toml: 'project_id = "test"\n[api]\nport = 65000\n',
        local: true,
        stackBackend: true,
        files: {
          "supabase/.env":
            "SUPABASE_API_PORT=65001\n" +
            "SUPABASE_API_EXTERNAL_URL=http://legacy.invalid:1\n" +
            "SUPABASE_AUTH_JWT_SECRET=abcdefghijklmnopqrstuvwxyzabcdef\n" +
            "SUPABASE_SERVICES_HOSTNAME=legacy.invalid\n",
        },
        routes: [{ method: "GET", match: BUCKET, body: [{ name: "test", id: "test" }] }],
      });
      return Effect.gen(function* () {
        const exit = yield* storageLs(lsFlags()).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isSuccess(exit)).toBe(true);
        expect(requests).toHaveLength(1);
        const url = requests[0]?.url ?? "";
        expect(url).not.toContain("65001");
        expect(url).not.toContain("legacy.invalid");
        expect(url.startsWith("http://127.0.0.1:59999")).toBe(true);
        expect(requests[0]?.headers["apikey"]).toBe(
          generateGoJwt(STORAGE_TEST_JWT_SECRET, "service_role"),
        );
      });
    },
  );

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
        const exit = yield* storageLs(lsFlags()).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        const capability = failureErrors(exit).find(
          (error) => error instanceof StackStorageCapabilityError,
        );
        expect(capability).toBeInstanceOf(StackStorageCapabilityError);
        expect(capability?.suggestion).toContain("--exclude storage");
        expect(requests).toHaveLength(0);
      });
    },
  );

  it.live(
    "fails with StackStorageUnavailableError when no stack is registered for the project",
    () => {
      const { layer, requests } = setupStorage(tmp.current, {
        toml: 'project_id = "test"\n',
        local: true,
        stackBackend: true,
        stackApi: { found: false },
      });
      return Effect.gen(function* () {
        const exit = yield* storageLs(lsFlags()).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        const unavailable = failureErrors(exit).find(
          (error) => error instanceof StackStorageUnavailableError,
        );
        expect(unavailable).toBeInstanceOf(StackStorageUnavailableError);
        expect(unavailable?.suggestion).toContain("supabase start");
        expect(requests).toHaveLength(0);
      });
    },
  );

  it.live("fails with StackStorageUnavailableError when the stack is stopped", () => {
    const { layer, requests } = setupStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      stackBackend: true,
      stackApi: { lifecycle: "stopped" },
    });
    return Effect.gen(function* () {
      const exit = yield* storageLs(lsFlags()).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      const unavailable = failureErrors(exit).find(
        (error) => error instanceof StackStorageUnavailableError,
      );
      expect(unavailable).toBeInstanceOf(StackStorageUnavailableError);
      expect(unavailable?.suggestion).toContain("supabase start");
      expect(requests).toHaveLength(0);
    });
  });

  it.live("fails when the required StackApi service is unavailable", () => {
    const { layer, requests } = setupStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      stackBackend: true,
      stackApi: { present: false },
    });
    return Effect.gen(function* () {
      const exit = yield* storageLs(lsFlags()).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("Service not found: supabase/stack/StackApi");
      }
      expect(requests).toHaveLength(0);
    });
  });

  it.live(
    "derives Storage credentials from the primary database when Auth credentials are unavailable",
    () => {
      const { layer, requests } = setupStorage(tmp.current, {
        toml: 'project_id = "test"\n',
        local: true,
        stackBackend: true,
        routes: [{ method: "GET", match: BUCKET, body: [{ name: "test", id: "test" }] }],
      });
      return Effect.gen(function* () {
        const exit = yield* storageLs(lsFlags()).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isSuccess(exit)).toBe(true);
        expect(requests).toHaveLength(1);
        expect(requests[0]?.headers["apikey"]).toBe(
          generateGoJwt(STORAGE_TEST_JWT_SECRET, "service_role"),
        );
      });
    },
  );

  it.live("fails with StackStorageCapabilityError when the stack exposes no api endpoint", () => {
    const { layer, requests } = setupStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      stackBackend: true,
      stackApi: { storageEndpoint: false },
    });
    return Effect.gen(function* () {
      const exit = yield* storageLs(lsFlags()).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("StackStorageCapabilityError");
      }
      expect(requests).toHaveLength(0);
    });
  });

  it.live("surfaces the capability error message when Storage failed to start", () => {
    const { layer } = setupStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      stackBackend: true,
      stackApi: { storageState: "failed", storageError: "boom" },
    });
    return Effect.gen(function* () {
      const exit = yield* storageLs(lsFlags()).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("StackStorageCapabilityError");
        expect(causeText).toContain("boom");
      }
    });
  });

  it.live("proceeds to the gateway when Storage is dormant (lazy-activated)", () => {
    const { layer, out } = setupStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      stackBackend: true,
      stackApi: { storageState: "dormant" },
      routes: [{ method: "GET", match: BUCKET, body: [{ name: "test", id: "test" }] }],
    });
    return Effect.gen(function* () {
      const exit = yield* storageLs(lsFlags()).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stdoutText).toBe("test/\n");
    });
  });

  it.live("proceeds to the gateway while Storage is stopping with wake retained", () => {
    const { layer, out } = setupStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      stackBackend: true,
      stackApi: { storageState: "stopping" },
      routes: [{ method: "GET", match: BUCKET, body: [{ name: "test", id: "test" }] }],
    });
    return Effect.gen(function* () {
      const exit = yield* storageLs(lsFlags()).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stdoutText).toBe("test/\n");
    });
  });

  it.live("fails when Storage is stopping after a manual stop disabled wake", () => {
    const { layer, requests } = setupStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      stackBackend: true,
      stackApi: { storageState: "stopping", storageWakeEnabled: false },
    });
    return Effect.gen(function* () {
      const exit = yield* storageLs(lsFlags()).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("Storage is stopped");
      }
      expect(requests).toHaveLength(0);
    });
  });

  it.live(
    "maps a gateway 503 (Storage still activating) to StackStorageCapabilityError under the stack backend",
    () => {
      const { layer } = setupStorage(tmp.current, {
        toml: 'project_id = "test"\n',
        local: true,
        stackBackend: true,
        routes: [{ method: "GET", match: BUCKET, status: 503, body: { message: "unavailable" } }],
      });
      return Effect.gen(function* () {
        const exit = yield* storageLs(lsFlags()).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.pretty(exit.cause)).toContain("StackStorageCapabilityError");
        }
      });
    },
  );

  it.live("leaves a gateway 503 as StorageGatewayStatusError under the legacy backend", () => {
    const { layer } = setupStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      routes: [{ method: "GET", match: BUCKET, status: 503, body: { message: "unavailable" } }],
    });
    return Effect.gen(function* () {
      const exit = yield* storageLs(lsFlags()).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("StorageGatewayStatusError");
      }
    });
  });

  it.live(
    "uses the api-keys path for --linked and never calls findStack, even with the stack backend enabled",
    () => {
      const { layer, requests, stackCalls } = setupStorage(tmp.current, {
        stackBackend: true,
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
        expect(stackCalls.findStack).toHaveLength(0);
      });
    },
  );

  it.live(
    "leaves a --linked gateway 503 as StorageGatewayStatusError even under the stack backend",
    () => {
      const { layer, stackCalls } = setupStorage(tmp.current, {
        stackBackend: true,
        routes: [{ method: "GET", match: BUCKET, status: 503, body: { message: "unavailable" } }],
      });
      return Effect.gen(function* () {
        const exit = yield* storageLs(lsFlags({ local: false })).pipe(
          Effect.provide(layer),
          Effect.exit,
        );
        expect(Exit.isFailure(exit)).toBe(true);
        const errors = failureErrors(exit);
        expect(errors.some((error) => error instanceof StorageGatewayStatusError)).toBe(true);
        expect(errors.some((error) => error instanceof StackStorageCapabilityError)).toBe(false);
        expect(stackCalls.findStack).toHaveLength(0);
      });
    },
  );

  it.live(
    "sanitizes a failed capability's error message, stripping control characters from the stack",
    () => {
      const { layer } = setupStorage(tmp.current, {
        toml: 'project_id = "test"\n',
        local: true,
        stackBackend: true,
        stackApi: { storageState: "failed", storageError: "\u001b[31mboom\u001b[0m" },
      });
      return Effect.gen(function* () {
        const exit = yield* storageLs(lsFlags()).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (!Exit.isFailure(exit)) return;
        const error = Cause.squash(exit.cause);
        expect(error).toBeInstanceOf(StackStorageCapabilityError);
        if (!(error instanceof StackStorageCapabilityError)) return;
        expect(error.message).toContain("Storage failed to start for this stack");
        expect(error.message).toContain("boom");
        expect(error.message).not.toContain("\u001b");
      });
    },
  );

  it.live("suggests starting without excluding Storage when it is disabled", () => {
    const { layer } = setupStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      stackBackend: true,
      stackApi: { storageState: "disabled" },
    });
    return Effect.gen(function* () {
      const exit = yield* storageLs(lsFlags()).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      const capability = failureErrors(exit).find(
        (error) => error instanceof StackStorageCapabilityError,
      );
      expect(capability).toBeInstanceOf(StackStorageCapabilityError);
      expect(capability?.suggestion).toContain("supabase start without --exclude storage");
      expect(capability?.suggestion).not.toContain("supabase stack restart");
    });
  });

  it.live("suggests waiting for the stack to finish stopping", () => {
    const { layer } = setupStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      stackBackend: true,
      stackApi: { lifecycle: "stopping" },
    });
    return Effect.gen(function* () {
      const exit = yield* storageLs(lsFlags()).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      const unavailable = failureErrors(exit).find(
        (error) => error instanceof StackStorageUnavailableError,
      );
      expect(unavailable).toBeInstanceOf(StackStorageUnavailableError);
      expect(unavailable?.suggestion).toContain("run supabase start once it has stopped");
    });
  });

  it.live(
    "surfaces the gateway's status and body on a local 503, without suggesting reactivation",
    () => {
      const { layer } = setupStorage(tmp.current, {
        toml: 'project_id = "test"\n',
        local: true,
        stackBackend: true,
        routes: [{ method: "GET", match: BUCKET, status: 503, body: { message: "upstream down" } }],
      });
      return Effect.gen(function* () {
        const exit = yield* storageLs(lsFlags()).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        const capability = failureErrors(exit).find(
          (error) => error instanceof StackStorageCapabilityError,
        );
        expect(capability).toBeInstanceOf(StackStorageCapabilityError);
        expect(capability?.message).toContain("HTTP 503");
        expect(capability?.message).toContain("upstream down");
        expect(capability?.message).not.toContain("activate");
        expect(capability?.suggestion).not.toContain("activate");
      });
    },
  );

  it.live("suggests retrying shortly while the stack lifecycle is starting", () => {
    const { layer } = setupStorage(tmp.current, {
      toml: 'project_id = "test"\n',
      local: true,
      stackBackend: true,
      stackApi: { lifecycle: "starting" },
    });
    return Effect.gen(function* () {
      const exit = yield* storageLs(lsFlags()).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      const unavailable = failureErrors(exit).find(
        (error) => error instanceof StackStorageUnavailableError,
      );
      expect(unavailable).toBeInstanceOf(StackStorageUnavailableError);
      expect(unavailable?.suggestion).toContain("retry shortly");
    });
  });

  it.live("legacy default still derives the gateway URL from [api] port", () => {
    const { layer, requests } = setupStorage(tmp.current, {
      toml: 'project_id = "test"\n[api]\nport = 65432\n',
      local: true,
      routes: [{ method: "GET", match: BUCKET, body: [{ name: "test", id: "test" }] }],
    });
    return Effect.gen(function* () {
      const exit = yield* storageLs(lsFlags()).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(requests[0]?.url.includes(":65432")).toBe(true);
    });
  });
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
