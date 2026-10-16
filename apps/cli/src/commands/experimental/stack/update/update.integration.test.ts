import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { readLock } from "@supabase/stack/effect";
import {
  artifactServiceKinds,
  catalogPins,
  type ServiceKind,
} from "@supabase/stack/internal/artifacts";
import { Effect, FileSystem, Layer, Option } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import { CommandPlatformApiFactory } from "../../../../auth/command-platform-api-factory.service.ts";
import {
  mockCommandSettings,
  mockTelemetryStateTracked,
  withConfigEnv,
} from "../../../../../tests/helpers/command-mocks.ts";
import { mockOutput, mockRuntimeInfo } from "../../../../../tests/helpers/mocks.ts";
import { selection } from "../../../../../tests/helpers/pins.ts";
import {
  publishRelease,
  releaseHostEnv,
  startReleaseFixture,
  type ReleaseFixture,
} from "../../../../../tests/helpers/release-fixture.ts";
import { seedLock, unbundled } from "../../../../../tests/helpers/stack-lock.ts";
import { ExperimentalFlag } from "../../../../command-internal/global-flags.ts";
import { StackCommandUpdateError } from "./update.errors.ts";
import { stackUpdate } from "./update.handler.ts";

const UPSTREAM = "v99.0.0";

const publish = (host: ReleaseFixture, kind: ServiceKind, revision: number) => {
  const producer = catalogPins().find(
    (entry) => entry.service === kind && entry.isDefault,
  )?.sourceService;
  if (producer === undefined) throw new Error(`no producer for ${kind}`);
  publishRelease(host, { producer, upstream: UPSTREAM, revision });
};

/** Every service follows the bundled pin except those named, which request a published release. */
const project = (requested: Partial<Record<ServiceKind, string>>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-update-" });
    yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
    yield* fs.writeFileString(
      `${root}/supabase/config.toml`,
      [
        'project_id = "stack-update"',
        '[local.services.default]\nversion = "bundled"',
        ...Object.entries(requested).map(
          ([kind, version]) => `[local.services.${kind}]\nversion = "${version}"`,
        ),
      ].join("\n\n"),
    );
    return root;
  });

const layer = (root: string, output: ReturnType<typeof mockOutput>) =>
  Layer.mergeAll(
    BunServices.layer,
    mockRuntimeInfo({ platform: "linux", arch: "x64" }),
    output.layer,
    mockTelemetryStateTracked().layer,
    mockCommandSettings({ workdir: root }),
    Layer.succeed(ExperimentalFlag, false),
    // No linked entry is re-resolved here, so nothing asks the hosted project.
    Layer.succeed(CommandPlatformApiFactory, { make: Effect.die("unused") }),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("unused")),
    ),
  );

const seed = (root: string, host: ReleaseFixture, edit?: Parameters<typeof seedLock>[1]) =>
  withConfigEnv(releaseHostEnv(host), seedLock(root, edit)).pipe(
    Effect.provide(layer(root, mockOutput())),
  );

const update = (
  root: string,
  host: ReleaseFixture,
  services: ReadonlyArray<string>,
  options: { readonly format?: "text" | "json"; readonly ci?: boolean } = {},
) => {
  const output = mockOutput({ format: options.format ?? "text" });
  const run = withConfigEnv(
    { CI: options.ci === true ? "true" : "", ...releaseHostEnv(host) },
    stackUpdate({ services }),
  ).pipe(Effect.provide(layer(root, output)));
  return { output, run };
};

const lockPath = (root: string) => `${root}/supabase/supabase.lock`;

const readServices = (root: string) =>
  readLock(root).pipe(
    Effect.map(Option.getOrThrow),
    Effect.map((lock) => lock.services),
  );

describe("experimental stack update", () => {
  it.live("moves the named service to its newest revision and keeps every other entry", () =>
    Effect.gen(function* () {
      const host = yield* startReleaseFixture;
      const root = yield* project({ auth: UPSTREAM, rest: UPSTREAM });
      publish(host, "auth", 0);
      publish(host, "rest", 0);
      yield* seed(root, host);
      const before = yield* readServices(root);
      publish(host, "auth", 1);
      publish(host, "rest", 1);
      host.requests.length = 0;

      const { output, run } = update(root, host, ["auth"]);
      yield* run;

      const after = yield* readServices(root);
      expect(after.auth.resolved.revision).toBe(1);
      const { auth: _updated, ...others } = after;
      const { auth: _previous, ...unchanged } = before;
      expect(others).toEqual(unchanged);
      expect(output.stdoutText).toContain("auth");
      expect(output.stdoutText).toContain(`${UPSTREAM}-r0 → ${UPSTREAM}-r1`);
      expect(output.stdoutText).toContain("1 changed, 11 unchanged");
      expect(host.requests.filter((path) => path.includes("/releases/rest-"))).toEqual([]);
      expect(host.requests.filter((path) => path.endsWith(".tar.zst"))).toEqual([]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live(
    "updates every service when none is named, moving bundled to this CLI and keeping an exact revision",
    () =>
      Effect.gen(function* () {
        const host = yield* startReleaseFixture;
        const root = yield* project({ auth: UPSTREAM, rest: UPSTREAM, storage: `${UPSTREAM}-r1` });
        for (const kind of ["auth", "rest"] as const) publish(host, kind, 0);
        for (const revision of [0, 1]) publish(host, "storage", revision);
        yield* seed(root, host, (services) => ({
          ...services,
          studio: { ...services.studio, resolved: unbundled(services.studio.resolved) },
        }));
        for (const kind of ["auth", "rest"] as const) publish(host, kind, 1);
        publish(host, "storage", 2);
        host.requests.length = 0;

        const { output, run } = update(root, host, [], { format: "json" });
        yield* run;

        const after = yield* readServices(root);
        expect(after.auth.resolved.revision).toBe(1);
        expect(after.rest.resolved.revision).toBe(1);
        expect(after.storage.resolved.revision).toBe(1);
        expect(after.studio.resolved).toMatchObject({
          upstreamVersion: selection.studio.upstreamVersion,
          revision: selection.studio.revision,
          image: selection.studio.image,
        });
        expect(host.requests.filter((path) => path.includes("/releases/storage-"))).toEqual([]);
        const result = output.messages.find((entry) => entry.type === "success");
        expect(result?.type === "success" ? result.data : undefined).toMatchObject({
          lock: {
            file: "supabase/supabase.lock",
            written: true,
            added: [],
            changed: [
              { service: "rest", from: `${UPSTREAM}-r0`, to: `${UPSTREAM}-r1` },
              { service: "auth", from: `${UPSTREAM}-r0`, to: `${UPSTREAM}-r1` },
              { service: "studio" },
            ],
          },
        });
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("rewrites the lock under CI, which does not freeze an explicit update", () =>
    Effect.gen(function* () {
      const host = yield* startReleaseFixture;
      const root = yield* project({ auth: UPSTREAM });
      publish(host, "auth", 0);
      yield* seed(root, host);
      publish(host, "auth", 1);

      yield* update(root, host, ["auth"], { ci: true }).run;

      expect((yield* readServices(root)).auth.resolved.revision).toBe(1);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("resolves every service when the project has no lock yet", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const host = yield* startReleaseFixture;
      const root = yield* project({ auth: UPSTREAM });
      publish(host, "auth", 0);

      yield* update(root, host, ["auth"]).run;

      const services = yield* readServices(root);
      expect(Object.keys(services).toSorted()).toEqual([...artifactServiceKinds()].toSorted());
      expect(services.auth.resolved.revision).toBe(0);
      expect(yield* fs.readFileString(`${root}/supabase/.gitignore`)).toContain(
        ".supabase.lock.lease",
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("leaves the lock byte for byte alone when every entry already answers the config", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const host = yield* startReleaseFixture;
      const root = yield* project({ auth: `${UPSTREAM}-r1` });
      publish(host, "auth", 1);
      yield* seed(root, host);
      const written = yield* fs.readFileString(lockPath(root));

      const { output, run } = update(root, host, ["auth"]);
      yield* run;

      expect(output.stdoutText).toContain("already up to date");
      expect(yield* fs.readFileString(lockPath(root))).toBe(written);
      const json = update(root, host, ["auth"], { format: "json" });
      yield* json.run;
      const result = json.output.messages.find((entry) => entry.type === "success");
      expect(result?.type === "success" ? result.data : undefined).toMatchObject({
        lock: { written: false, changed: [], stale: [] },
      });
    }).pipe(Effect.provide(BunServices.layer)),
  );

  describe("a service whose specifier changed since the lock was written", () => {
    const staleProject = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const host = yield* startReleaseFixture;
      const root = yield* project({ auth: UPSTREAM, rest: UPSTREAM });
      publish(host, "auth", 0);
      publish(host, "rest", 0);
      yield* seed(root, host);
      publish(host, "rest", 1);
      yield* fs.writeFileString(
        `${root}/supabase/config.toml`,
        `project_id = "stack-update"\n\n[local.services.default]\nversion = "bundled"\n\n[local.services.auth]\nversion = "${UPSTREAM}"\n\n[local.services.rest]\nversion = "${UPSTREAM}-r1"\n`,
      );
      return { fs, host, root };
    });

    it.live("is resolved again when named", () =>
      Effect.gen(function* () {
        const { host, root } = yield* staleProject;

        const { output, run } = update(root, host, ["rest"]);
        yield* run;

        expect((yield* readServices(root)).rest.resolved.revision).toBe(1);
        expect(output.stdoutText).toContain(`${UPSTREAM}-r0 → ${UPSTREAM}-r1`);
        expect(output.stdoutText).not.toContain("is stale");
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("is reported and left as written when another service is named", () =>
      Effect.gen(function* () {
        const { fs, host, root } = yield* staleProject;
        const written = yield* fs.readFileString(lockPath(root));

        const text = update(root, host, ["auth"]);
        yield* text.run;
        const json = update(root, host, ["auth"], { format: "json" });
        yield* json.run;

        expect(text.output.stdoutText).toContain("rest is stale (");
        expect(text.output.stdoutText).toContain("supabase stack update rest");
        expect(text.output.stdoutText).not.toContain("already up to date");
        expect(yield* fs.readFileString(lockPath(root))).toBe(written);
        const result = json.output.messages.find((entry) => entry.type === "success");
        const lock = result?.type === "success" ? result.data : undefined;
        expect(lock).toMatchObject({ lock: { written: false, stale: ["rest"] } });
        expect(lock).toEqual({
          lock: expect.objectContaining({ unchanged: expect.not.arrayContaining(["rest"]) }),
        });
      }).pipe(Effect.provide(BunServices.layer)),
    );
  });

  it.live("fails on an escaping function entrypoint, leaving the lock byte for byte alone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const host = yield* startReleaseFixture;
      const root = yield* project({ auth: UPSTREAM });
      publish(host, "auth", 0);
      yield* seed(root, host);
      publish(host, "auth", 1);
      const written = yield* fs.readFileString(lockPath(root));
      const config = yield* fs.readFileString(`${root}/supabase/config.toml`);
      yield* fs.writeFileString(
        `${root}/supabase/config.toml`,
        `${config}\n\n[functions.x]\nentrypoint = "../../outside.ts"\n`,
      );

      const error = yield* update(root, host, ["auth"]).run.pipe(Effect.flip);

      expect(error).toBeInstanceOf(StackCommandUpdateError);
      expect(error).toMatchObject({ reason: "invalid-config" });
      expect(error.message).toContain("must remain within the project directory");
      expect(yield* fs.readFileString(lockPath(root))).toBe(written);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("fails on an unknown service naming the valid ones, and writes nothing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const host = yield* startReleaseFixture;
      const root = yield* project({ auth: UPSTREAM });
      publish(host, "auth", 0);
      yield* seed(root, host);
      const written = yield* fs.readFileString(lockPath(root));
      host.requests.length = 0;

      const error = yield* update(root, host, ["auth", "nope"]).run.pipe(Effect.flip);

      expect(error).toBeInstanceOf(StackCommandUpdateError);
      expect(error).toMatchObject({ reason: "flags" });
      expect(error.message).toContain('"nope"');
      expect(error.message).toContain(artifactServiceKinds().join(", "));
      expect(yield* fs.readFileString(lockPath(root))).toBe(written);
      expect(host.requests).toEqual([]);
    }).pipe(Effect.provide(BunServices.layer)),
  );
});
