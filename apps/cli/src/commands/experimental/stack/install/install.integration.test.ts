import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { readLock } from "@supabase/stack/effect";
import {
  artifactServiceKinds,
  catalogPins,
  resolveArtifact,
  type ServiceKind,
} from "@supabase/stack/internal/artifacts";
import { Effect, FileSystem, Layer, Option } from "effect";
import {
  mockCommandSettings,
  mockTelemetryStateTracked,
  withConfigEnv,
} from "../../../../../tests/helpers/command-mocks.ts";
import { mockOutput, mockRuntimeInfo } from "../../../../../tests/helpers/mocks.ts";
import { releaseArchive } from "../../../../../tests/helpers/release-archive.ts";
import {
  publishRelease,
  releaseHostEnv,
  startReleaseFixture,
  type ReleaseFixture,
} from "../../../../../tests/helpers/release-fixture.ts";
import { selection } from "../../../../../tests/helpers/pins.ts";
import { ExperimentalFlag } from "../../../../command-internal/global-flags.ts";
import { StackCommandInstallError } from "./install.errors.ts";
import { stackInstall } from "./install.handler.ts";

const UPSTREAM = (kind: ServiceKind) => (kind === "database" ? "17.99.0.0" : "v99.0.0");

const requestedVersions = (upstream: (kind: ServiceKind) => string = UPSTREAM) =>
  artifactServiceKinds()
    .map((kind) => `[local.services.${kind}]\nversion = "${upstream(kind)}"\n`)
    .join("\n");

/** Publishes a release of every service, each with an archive holding what that service requires. */
const publishAll = (host: ReleaseFixture) =>
  Effect.forEach(artifactServiceKinds(), (kind) =>
    Effect.gen(function* () {
      const producer = catalogPins().find(
        (entry) => entry.service === kind && entry.isDefault,
      )?.sourceService;
      if (producer === undefined) return yield* Effect.die(`no producer for ${kind}`);
      const { requiredRuntimePaths, executablePath } = yield* resolveArtifact({
        service: kind,
        pin: selection[kind],
      });
      publishRelease(host, {
        producer,
        upstream: UPSTREAM(kind),
        revision: 0,
        provenanceSource: `docker.io/upstream/${producer}:${UPSTREAM(kind)}@sha256:${"a".repeat(64)}`,
        archive: releaseArchive([...new Set([...requiredRuntimePaths, executablePath])]),
      });
    }),
  );

const project = (config = requestedVersions()) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-install-" });
    yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
    yield* fs.writeFileString(
      `${root}/supabase/config.toml`,
      `project_id = "stack-install"\n${config}`,
    );
    return root;
  });

const lockPath = (root: string) => `${root}/supabase/supabase.lock`;
const leasePath = (root: string) => `${root}/supabase/.supabase.lock.lease`;

const install = (
  root: string,
  host: ReleaseFixture,
  options: {
    readonly format?: "text" | "json";
    readonly frozen?: boolean;
    readonly ci?: boolean;
    readonly platform?: "linux" | "darwin";
  } = {},
) => {
  const output = mockOutput({ format: options.format ?? "text" });
  const run = withConfigEnv(
    { CI: options.ci === true ? "true" : "", ...releaseHostEnv(host) },
    stackInstall({ runtime: "native", frozen: options.frozen ?? false }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        BunServices.layer,
        mockRuntimeInfo({ platform: options.platform ?? "linux", arch: "x64" }),
        output.layer,
        mockTelemetryStateTracked().layer,
        mockCommandSettings({ workdir: root }),
        Layer.succeed(ExperimentalFlag, false),
      ),
    ),
  );
  return { output, run };
};

const cachedFiles = (root: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.readDirectory(`${root}/.supabase/cache/stack`, { recursive: true }),
  ).pipe(Effect.map((entries) => entries.toSorted()));

const archiveRequests = (host: ReleaseFixture) =>
  host.requests.filter((path) => path.endsWith(".tar.zst"));

describe("experimental stack install", () => {
  it.live(
    "resolves the lock, downloads every native archive, and finds them all cached on the next run",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const host = yield* startReleaseFixture;
        yield* publishAll(host);
        const root = yield* project();

        const first = install(root, host);
        yield* first.run;

        const lock = yield* readLock(root).pipe(Effect.map(Option.getOrThrow));
        expect(lock.services.rest.resolved.upstreamVersion).toBe("v99.0.0");
        expect(lock.services.database.resolved.upstreamVersion).toBe("17.99.0.0");
        expect(
          first.output.messages.flatMap((entry) =>
            entry.type === "info" && entry.message.startsWith("Resolved service versions:")
              ? [entry.message]
              : [],
          ),
        ).toHaveLength(1);
        expect(first.output.stdoutText).toContain(
          "Downloaded 12 of 12 archives for the native runtime; 0 already present.",
        );
        expect(first.output.stdoutText).toContain("rest v99.0.0-r0 (downloaded)");
        expect(archiveRequests(host)).toHaveLength(12);
        expect(yield* cachedFiles(root)).not.toHaveLength(0);
        expect(yield* fs.readFileString(`${root}/supabase/.gitignore`)).toContain(
          ".supabase.lock.lease",
        );

        const written = yield* fs.readFileString(lockPath(root));
        const cached = yield* cachedFiles(root);
        host.requests.length = 0;
        const second = install(root, host, { format: "json" });
        yield* second.run;

        expect(yield* fs.readFileString(lockPath(root))).toBe(written);
        expect(yield* cachedFiles(root)).toEqual(cached);
        expect(archiveRequests(host)).toEqual([]);
        const result = second.output.messages.find((entry) => entry.type === "success");
        expect(result?.type === "success" ? result.data : undefined).toMatchObject({
          runtime: "native",
          lock: { file: "supabase/supabase.lock", written: false, added: [], changed: [] },
          downloaded: 0,
          cached: 12,
        });
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("fails a frozen install naming the stale service and leaves the project untouched", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const host = yield* startReleaseFixture;
      yield* publishAll(host);
      const root = yield* project();
      yield* install(root, host).run;
      const written = yield* fs.readFileString(lockPath(root));
      const cached = yield* cachedFiles(root);
      const ignored = yield* fs.readFileString(`${root}/supabase/.gitignore`);
      yield* fs.remove(leasePath(root));
      yield* fs.writeFileString(
        `${root}/supabase/config.toml`,
        `project_id = "stack-install"\n${requestedVersions((kind) => (kind === "rest" ? "v99.1.0" : UPSTREAM(kind)))}`,
      );
      host.requests.length = 0;

      const error = yield* install(root, host, { frozen: true }).run.pipe(Effect.flip);

      expect(error).toBeInstanceOf(StackCommandInstallError);
      expect(error).toMatchObject({ reason: "lock" });
      expect(error.message).toContain("rest");
      expect(yield* fs.readFileString(lockPath(root))).toBe(written);
      expect(yield* fs.readFileString(`${root}/supabase/.gitignore`)).toBe(ignored);
      expect(yield* fs.exists(leasePath(root))).toBe(false);
      expect(yield* cachedFiles(root)).toEqual(cached);
      expect(archiveRequests(host)).toEqual([]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("installs under a frozen lock without taking the lease or writing into the project", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const host = yield* startReleaseFixture;
      yield* publishAll(host);
      const root = yield* project();
      yield* install(root, host).run;
      const written = yield* fs.readFileString(lockPath(root));
      yield* fs.remove(`${root}/supabase/.gitignore`);
      yield* fs.remove(leasePath(root));

      yield* install(root, host, { frozen: true }).run;

      expect(yield* fs.readFileString(lockPath(root))).toBe(written);
      expect(yield* fs.exists(leasePath(root))).toBe(false);
      expect(yield* fs.exists(`${root}/supabase/.gitignore`)).toBe(false);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("fails a frozen install of a project without config.toml, downloading nothing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const host = yield* startReleaseFixture;
      yield* publishAll(host);
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-install-bare-" });

      const error = yield* install(root, host, { frozen: true }).run.pipe(Effect.flip);

      expect(error).toBeInstanceOf(StackCommandInstallError);
      expect(error).toMatchObject({
        reason: "lock",
        cause: { _tag: "LockResolutionError", reason: "frozen-missing" },
      });
      expect(yield* fs.readDirectory(root)).toEqual([]);
      expect(host.requests).toEqual([]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("fails an install in CI with a lock but no config.toml, downloading nothing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const host = yield* startReleaseFixture;
      yield* publishAll(host);
      const root = yield* project();
      yield* install(root, host).run;
      const written = yield* fs.readFileString(lockPath(root));
      yield* fs.remove(`${root}/supabase/config.toml`);
      host.requests.length = 0;

      const error = yield* install(root, host, { ci: true }).run.pipe(Effect.flip);

      expect(error).toBeInstanceOf(StackCommandInstallError);
      expect(error).toMatchObject({
        reason: "lock",
        cause: { _tag: "LockResolutionError", reason: "frozen-missing" },
      });
      expect(error.message).toContain("supabase/config.toml not found");
      expect(error.message).not.toContain("supabase.lock not found");
      expect(yield* fs.readFileString(lockPath(root))).toBe(written);
      expect(host.requests).toEqual([]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("fails a frozen install with a lock but no config.toml on the missing config", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const host = yield* startReleaseFixture;
      yield* publishAll(host);
      const root = yield* project();
      yield* install(root, host).run;
      const written = yield* fs.readFileString(lockPath(root));
      yield* fs.remove(`${root}/supabase/config.toml`);
      host.requests.length = 0;

      const error = yield* install(root, host, { frozen: true }).run.pipe(Effect.flip);

      expect(error).toBeInstanceOf(StackCommandInstallError);
      expect(error).toMatchObject({
        reason: "lock",
        cause: { _tag: "LockResolutionError", reason: "frozen-missing" },
      });
      expect(error.message).toContain("supabase/config.toml not found");
      expect(error.message).not.toContain("supabase.lock not found");
      expect(yield* fs.readFileString(lockPath(root))).toBe(written);
      expect(host.requests).toEqual([]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("ignores the lease file when it takes the lease for a lock that is already fresh", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const host = yield* startReleaseFixture;
      yield* publishAll(host);
      const root = yield* project();
      yield* install(root, host).run;
      const written = yield* fs.readFileString(lockPath(root));
      yield* fs.writeFileString(`${root}/supabase/.gitignore`, "node_modules\n");

      yield* install(root, host).run;

      expect(yield* fs.readFileString(lockPath(root))).toBe(written);
      const ignored = (yield* fs.readFileString(`${root}/supabase/.gitignore`)).split("\n");
      expect(ignored).toEqual(expect.arrayContaining(["node_modules", ".supabase.lock.lease"]));
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("fails with reason invalid-config on a malformed config.toml, writing no lock", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const host = yield* startReleaseFixture;
      yield* publishAll(host);
      const root = yield* project("this is = not [valid toml\n");

      const error = yield* install(root, host).run.pipe(Effect.flip);

      expect(error).toBeInstanceOf(StackCommandInstallError);
      expect(error).toMatchObject({ reason: "invalid-config" });
      expect(yield* fs.exists(lockPath(root))).toBe(false);
      expect(host.requests).toEqual([]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live(
    "fails with reason invalid-config on an escaping function entrypoint, writing no lock",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const host = yield* startReleaseFixture;
        yield* publishAll(host);
        const root = yield* project(
          `${requestedVersions()}\n[functions.x]\nentrypoint = "../../outside.ts"\n`,
        );

        const error = yield* install(root, host).run.pipe(Effect.flip);

        expect(error).toBeInstanceOf(StackCommandInstallError);
        expect(error).toMatchObject({ reason: "invalid-config" });
        expect(error.message).toContain("must remain within the project directory");
        expect(yield* fs.exists(lockPath(root))).toBe(false);
        expect(host.requests).toEqual([]);
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("fails with reason flags when the platform has no native artifacts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const host = yield* startReleaseFixture;
      yield* publishAll(host);
      const root = yield* project();

      const error = yield* install(root, host, { platform: "darwin" }).run.pipe(Effect.flip);

      expect(error).toBeInstanceOf(StackCommandInstallError);
      expect(error).toMatchObject({ reason: "flags" });
      expect(host.requests).toEqual([]);
      expect(yield* fs.exists(lockPath(root))).toBe(false);
    }).pipe(Effect.provide(BunServices.layer)),
  );
});
