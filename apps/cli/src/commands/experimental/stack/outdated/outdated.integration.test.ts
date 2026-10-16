import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { holdLock } from "@supabase/stack/effect";
import { catalogPins, type ServiceKind } from "@supabase/stack/internal/artifacts";
import { Effect, FileSystem, Layer } from "effect";
import {
  mockCommandSettings,
  mockTelemetryStateTracked,
  withConfigEnv,
} from "../../../../../tests/helpers/command-mocks.ts";
import { mockOutput, mockRuntimeInfo } from "../../../../../tests/helpers/mocks.ts";
import {
  publishRelease,
  releaseHostEnv,
  startReleaseFixture,
  type ReleaseFixture,
} from "../../../../../tests/helpers/release-fixture.ts";
import { seedLock } from "../../../../../tests/helpers/stack-lock.ts";
import { ExperimentalFlag } from "../../../../command-internal/global-flags.ts";
import { StackCommandOutdatedError } from "./outdated.errors.ts";
import { stackOutdated } from "./outdated.handler.ts";

const UPSTREAM = "v99.0.0";

const publish = (host: ReleaseFixture, kind: ServiceKind, revision: number) => {
  const producer = catalogPins().find(
    (entry) => entry.service === kind && entry.isDefault,
  )?.sourceService;
  if (producer === undefined) throw new Error(`no producer for ${kind}`);
  publishRelease(host, { producer, upstream: UPSTREAM, revision });
};

const configToml = (requested: Partial<Record<ServiceKind, string>>) =>
  [
    'project_id = "stack-outdated"',
    '[local.services.default]\nversion = "bundled"',
    ...Object.entries(requested).map(
      ([kind, version]) => `[local.services.${kind}]\nversion = "${version}"`,
    ),
  ].join("\n\n");

const project = (requested: Partial<Record<ServiceKind, string>>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-outdated-" });
    yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
    yield* fs.writeFileString(`${root}/supabase/config.toml`, configToml(requested));
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
  );

const seed = (root: string, host: ReleaseFixture) =>
  withConfigEnv(releaseHostEnv(host), seedLock(root)).pipe(
    Effect.provide(layer(root, mockOutput())),
  );

const outdated = (root: string, host: ReleaseFixture, format: "text" | "json") => {
  const output = mockOutput({ format });
  const run = withConfigEnv(releaseHostEnv(host), stackOutdated()).pipe(
    Effect.provide(layer(root, output)),
  );
  return { output, run };
};

const lockPath = (root: string) => `${root}/supabase/supabase.lock`;
const leasePath = (root: string) => `${root}/supabase/.supabase.lock.lease`;

describe("experimental stack outdated", () => {
  it.live(
    "reports a newer revision and a stale entry without writing, waiting on the lease or downloading",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const host = yield* startReleaseFixture;
        const root = yield* project({ auth: UPSTREAM, rest: UPSTREAM });
        publish(host, "auth", 0);
        publish(host, "rest", 0);
        yield* seed(root, host);
        publish(host, "auth", 1);
        yield* fs.writeFileString(
          `${root}/supabase/config.toml`,
          configToml({ auth: UPSTREAM, rest: "v98.0.0" }),
        );
        yield* holdLock(leasePath(root), "1 second", "test lock");
        const written = yield* fs.readFileString(lockPath(root));
        host.requests.length = 0;

        const { output, run } = outdated(root, host, "json");
        yield* run;

        const result = output.messages.find((entry) => entry.type === "success");
        const data = result?.type === "success" ? result.data : undefined;
        expect(data).toMatchObject({
          file: "supabase/supabase.lock",
          updatable: 1,
          stale: 1,
          failed: 0,
        });
        expect(data).toMatchObject({
          services: expect.arrayContaining([
            {
              service: "auth",
              specifier: UPSTREAM,
              resolution: "resolved",
              locked: `${UPSTREAM}-r0`,
              update: `${UPSTREAM}-r1`,
              bundled: expect.stringMatching(/-r\d+$/u),
              stale: null,
              error: null,
            },
            expect.objectContaining({
              service: "rest",
              update: null,
              stale: expect.stringContaining("v98.0.0"),
            }),
          ]),
        });
        expect(yield* fs.readFileString(lockPath(root))).toBe(written);
        expect(host.requests.filter((path) => path.endsWith(".tar.zst"))).toEqual([]);
        expect(host.requests.filter((path) => path.includes("/releases/rest-"))).toEqual([]);
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("reports a transient release failure on its row and still succeeds", () =>
    Effect.gen(function* () {
      const host = yield* startReleaseFixture;
      const root = yield* project({ auth: UPSTREAM, rest: UPSTREAM });
      publish(host, "auth", 0);
      publish(host, "rest", 0);
      yield* seed(root, host);
      publish(host, "rest", 1);
      host.failing.set("/releases/auth-v99.0.0-r0/SHA256SUMS", 503);

      const { output, run } = outdated(root, host, "text");
      yield* run;

      expect(output.stdoutText).toContain("probe failed");
      expect(output.stdoutText).toContain("auth:");
      expect(output.stdoutText).toContain(`${UPSTREAM}-r1`);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("fails with guidance when the project has no lock yet", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const host = yield* startReleaseFixture;
      const root = yield* project({});

      const error = yield* outdated(root, host, "text").run.pipe(Effect.flip);

      expect(error).toBeInstanceOf(StackCommandOutdatedError);
      expect(error).toMatchObject({ reason: "lock" });
      expect(yield* fs.exists(lockPath(root))).toBe(false);
      expect(yield* fs.exists(leasePath(root))).toBe(false);
    }).pipe(Effect.provide(BunServices.layer)),
  );
});
