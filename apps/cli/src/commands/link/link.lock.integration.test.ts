import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import type { V1ListAllBranchesOutput } from "@supabase/api/effect";
import { readLock, writeLock } from "@supabase/stack/effect";
import { catalogPins, postgresMajor, type ServiceKind } from "@supabase/stack/internal/artifacts";
import { Effect, FileSystem, Layer, Option, PlatformError } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import {
  VALID_REF,
  buildTestRuntime,
  mockCommandPlatformApiService,
  mockCommandSettings,
  mockTelemetryStateTracked,
  statusCodeFailure,
  transportFailure,
  useTempWorkdir,
  withConfigEnv,
} from "../../../tests/helpers/command-mocks.ts";
import { mockAnalytics, mockOutput, mockRuntimeInfo } from "../../../tests/helpers/mocks.ts";
import { selection } from "../../../tests/helpers/pins.ts";
import { seedProjectStack, unbundled } from "../../../tests/helpers/stack-lock.ts";
import {
  publishRelease,
  releaseHostEnv,
  startReleaseFixture,
  type ReleaseFixture,
} from "../../../tests/helpers/release-fixture.ts";
import { cliConfigValuesTestLayer } from "../../../tests/helpers/config-values-layer.ts";
import { projectStateModeLayer } from "../../shared/config/project-state-mode.ts";
import { ExperimentalFlag } from "../../command-internal/global-flags.ts";
import { stackUpdate } from "../experimental/stack/update/update.handler.ts";
import { link } from "./link.handler.ts";
import type { LinkFlags } from "./link.command.ts";

const BRANCH_REF = "branchprojectrefabcd";
const POOLER_URL = "postgresql://postgres.ref@pooler.example.co:5432/postgres";
const HOSTED = "v99.0.0";

const PROJECT = {
  id: VALID_REF,
  ref: VALID_REF,
  name: "My Project",
  organization_id: "org_123",
  organization_slug: "acme",
  status: "ACTIVE_HEALTHY",
  region: "us-east-1",
  created_at: "2026-01-01T00:00:00Z",
  database: {
    host: "db.example.co",
    version: "15.1.0.117",
    postgres_engine: "15",
    release_channel: "ga",
  },
};

const SERVICE_KEYS = [
  {
    name: "service_role",
    api_key: "service-role-key",
    type: "secret",
    secret_jwt_template: { role: "service_role" },
  },
  { name: "anon", api_key: "anon-key", type: "publishable" },
];

const POOLER = [
  {
    identifier: "primary",
    database_type: "PRIMARY",
    db_user: "postgres",
    db_host: "pooler.example.co",
    db_port: 6543,
    db_name: "postgres",
    connection_string: "postgresql://postgres.ref:[YOUR-PASSWORD]@pooler.example.co:6543/postgres",
    connectionString: "",
    default_pool_size: null,
    max_client_conn: null,
    pool_mode: "transaction",
  },
];

const FEATURE_BRANCH: (typeof V1ListAllBranchesOutput.Type)[number] = {
  id: "11111111-2222-4333-8444-555555555555",
  name: "feature-branch",
  project_ref: BRANCH_REF,
  parent_project_ref: VALID_REF,
  is_default: false,
  persistent: false,
  status: "MIGRATIONS_PASSED",
  created_at: "2026-05-27T01:02:03Z",
  updated_at: "2026-05-27T01:02:04Z",
  with_data: true,
};

type Reply = { readonly status: number; readonly body: string } | "fail";

/** What the hosted project's tenant endpoints answer; tests reassign a service to change it. */
interface Tenant {
  rest: Reply;
  auth: Reply;
  storage: Reply;
  readonly requests: Array<string>;
}

const hostedTenant = (): Tenant => ({
  rest: { status: 200, body: JSON.stringify({ info: { version: "99.0.0 (abc123)" } }) },
  auth: { status: 200, body: JSON.stringify({ version: HOSTED }) },
  storage: { status: 200, body: "99.0.0" },
  requests: [],
});

const tenantLayer = (tenant: Tenant) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      const { pathname } = new URL(request.url);
      tenant.requests.push(pathname);
      const reply = pathname.startsWith("/rest/")
        ? tenant.rest
        : pathname.startsWith("/auth/")
          ? tenant.auth
          : tenant.storage;
      return reply === "fail"
        ? Effect.fail(transportFailure(request))
        : Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response(reply.body, { status: reply.status })),
          );
    }),
  );

const producerOf = (kind: ServiceKind) => {
  const producer = catalogPins().find(
    (entry) => entry.service === kind && entry.isDefault,
  )?.sourceService;
  if (producer === undefined) throw new Error(`no producer for ${kind}`);
  return producer;
};

const publish = (host: ReleaseFixture, kind: ServiceKind, upstream: string) =>
  publishRelease(host, { producer: producerOf(kind), upstream, revision: 0 });

const tempRoot = useTempWorkdir("supabase-link-lock-int-");

interface World {
  readonly host: ReleaseFixture;
  readonly tenant: Tenant;
  readonly workdir: string;
  /** Switches the link target between the project and its feature branch, and sets the hosted database version. */
  readonly target: { onBranch: boolean; database: string };
}

const startWorld = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const host = yield* startReleaseFixture;
  for (const kind of ["rest", "auth", "storage"] as const) publish(host, kind, HOSTED);
  const workdir = tempRoot.current;
  yield* fs.makeDirectory(`${workdir}/supabase`, { recursive: true });
  yield* fs.writeFileString(`${workdir}/supabase/config.toml`, 'project_id = "link-lock"\n');
  return {
    host,
    tenant: hostedTenant(),
    workdir,
    target: { onBranch: false, database: PROJECT.database.version },
  } satisfies World;
});

const layerFor = (
  world: World,
  out: ReturnType<typeof mockOutput>,
  fileSystem?: Layer.Layer<FileSystem.FileSystem>,
) => {
  const apiMock = mockCommandPlatformApiService({
    v1: {
      getProject: () =>
        world.target.onBranch
          ? Effect.fail(statusCodeFailure(404))
          : Effect.succeed({
              ...PROJECT,
              database: { ...PROJECT.database, version: world.target.database },
            }),
      getABranchConfig: () =>
        Effect.succeed({ postgres_version: "15.1.0.117", postgres_engine: "15" }),
      getProjectApiKeys: () => Effect.succeed(SERVICE_KEYS),
      getPoolerConfig: () => Effect.succeed(POOLER),
      listAllBranches: () => Effect.succeed(world.target.onBranch ? [FEATURE_BRANCH] : []),
    },
  });
  return Layer.mergeAll(
    buildTestRuntime({
      out,
      api: { layer: apiMock.layer, httpClientLayer: tenantLayer(world.tenant) },
      cliSettings: mockCommandSettings({ workdir: world.workdir, projectId: Option.none() }),
      analytics: mockAnalytics(),
      telemetry: mockTelemetryStateTracked().layer,
      ...(fileSystem === undefined ? {} : { fileSystem }),
    }),
    cliConfigValuesTestLayer,
    projectStateModeLayer("stack"),
    mockRuntimeInfo({ platform: "linux", arch: "x64" }),
    Layer.succeed(ExperimentalFlag, false),
  );
};

const flags = (overrides: Partial<LinkFlags> = {}): LinkFlags => ({
  refOrBranch: Option.none(),
  projectRef: Option.some(VALID_REF),
  password: Option.none(),
  skipPooler: false,
  frozen: false,
  ...overrides,
});

const toBranch = (world: World, overrides: Partial<LinkFlags> = {}) => {
  world.target.onBranch = true;
  return flags({
    refOrBranch: Option.some("feature-branch"),
    projectRef: Option.none(),
    ...overrides,
  });
};

const env = (world: World) => ({ CI: "", ...releaseHostEnv(world.host) });

/** Runs `supabase link` against the world and returns what it printed. */
const runLink = (
  world: World,
  linkFlags: LinkFlags = flags(),
  format: "text" | "json" = "text",
) => {
  const out = mockOutput({ format });
  return withConfigEnv(env(world), link(linkFlags)).pipe(
    Effect.provide(layerFor(world, out)),
    Effect.as(out),
  );
};

const lockWriteFails = Layer.effect(
  FileSystem.FileSystem,
  Effect.map(
    FileSystem.FileSystem,
    (real) =>
      new Proxy<FileSystem.FileSystem>(real, {
        get(target, property, receiver) {
          const value: unknown = Reflect.get(target, property, receiver);
          if (property !== "rename" || typeof value !== "function") return value;
          return (from: string, to: string) =>
            to.endsWith("supabase/supabase.lock")
              ? Effect.fail(
                  PlatformError.systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "rename",
                    description: `EACCES: permission denied, rename '${from}' -> '${to}'`,
                    pathOrDescriptor: to,
                  }),
                )
              : Reflect.apply(value, target, [from, to]);
        },
      }),
  ),
).pipe(Layer.provide(BunServices.layer));

const runLinkWithLockWriteFailing = (world: World, linkFlags: LinkFlags) => {
  const out = mockOutput({ format: "text" });
  return withConfigEnv(env(world), link(linkFlags)).pipe(
    Effect.provide(layerFor(world, out, lockWriteFails)),
  );
};

const runUpdate = (world: World) => {
  const out = mockOutput({ format: "text" });
  return withConfigEnv(env(world), stackUpdate({ services: [] })).pipe(
    Effect.provide(layerFor(world, out)),
    Effect.as(out),
  );
};

const warnings = (out: ReturnType<typeof mockOutput>) =>
  out.messages.filter(({ type }) => type === "warn").map(({ message }) => message);

const readServices = (workdir: string) =>
  readLock(workdir).pipe(
    Effect.map(Option.getOrThrow),
    Effect.map((lock) => lock.services),
  );

const writeConfig = (world: World, services: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(
      `${world.workdir}/supabase/config.toml`,
      `project_id = "link-lock"\n${services}`,
    );
  });

const lockText = (workdir: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(`${workdir}/supabase/supabase.lock`)),
  );

describe("link records hosted versions in the stack lock", () => {
  it.live("observes the hosted services and resolves linked entries to their releases", () =>
    Effect.gen(function* () {
      const world = yield* startWorld;

      const out = yield* runLink(world);

      const lock = yield* readLock(world.workdir).pipe(Effect.map(Option.getOrThrow));
      expect(lock.linked).toEqual({
        project: VALID_REF,
        branch: { ref: VALID_REF, isDefault: true },
        observedAt: expect.any(String),
      });
      for (const kind of ["rest", "auth", "storage"] as const) {
        expect(lock.services[kind]).toMatchObject({
          specifier: "linked",
          resolution: "resolved",
          linked: { version: HOSTED },
          resolved: { upstreamVersion: HOSTED, revision: 0 },
        });
      }
      expect(
        yield* FileSystem.FileSystem.pipe(
          Effect.flatMap((fs) => fs.exists(`${world.workdir}/supabase/.link.json`)),
        ),
      ).toBe(true);
      expect(out.messages.map(({ message }) => message).join("\n")).toContain(
        "Updated supabase/supabase.lock",
      );
      expect(lock.services.realtime.resolution).toBe("unobserved");
      expect(warnings(out)).toEqual([
        expect.stringMatching(/^database: hosted Postgres 15\.1\.0\.117/),
      ]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("takes the bundled pin as unobserved for a service the platform does not report", () =>
    Effect.gen(function* () {
      const world = yield* startWorld;
      world.tenant.storage = { status: 404, body: "" };

      const out = yield* runLink(world, flags(), "json");

      const services = yield* readServices(world.workdir);
      expect(services.storage).toMatchObject({
        resolution: "unobserved",
        resolved: {
          upstreamVersion: selection.storage.upstreamVersion,
          revision: selection.storage.revision,
        },
      });
      expect(services.storage.linked).toBeUndefined();
      expect(services.rest.resolution).toBe("resolved");
      expect(warnings(out).join("\n")).toContain("storage: the platform does not report");
      const success = out.messages.find(({ type }) => type === "success");
      expect(success?.data).toMatchObject({
        project_ref: VALID_REF,
        lock: {
          file: "supabase/supabase.lock",
          written: true,
          services: expect.arrayContaining([
            { service: "rest", hosted: "99.0.0", locked: `${HOSTED}-r0`, resolution: "resolved" },
            {
              service: "storage",
              hosted: null,
              locked: `${selection.storage.upstreamVersion}-r${selection.storage.revision}`,
              resolution: "unobserved",
            },
          ]),
        },
      });
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("does not rewrite the lock when linking again changes nothing", () =>
    Effect.gen(function* () {
      const world = yield* startWorld;
      yield* runLink(world);
      const written = yield* lockText(world.workdir);

      const out = yield* runLink(world);

      expect(yield* lockText(world.workdir)).toBe(written);
      const printed = out.messages.map(({ message }) => message).join("\n");
      expect(printed).toContain("supabase/supabase.lock is already up to date");
      expect(printed).not.toContain("Updated supabase/supabase.lock");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("keeps a fallback entry's pin when linking again changes nothing", () =>
    Effect.gen(function* () {
      const world = yield* startWorld;
      world.tenant.storage = { status: 404, body: "" };
      yield* runLink(world);
      const lock = yield* readLock(world.workdir).pipe(Effect.map(Option.getOrThrow));
      const pinned = unbundled(lock.services.storage.resolved);
      yield* writeLock(world.workdir, {
        ...lock,
        services: { ...lock.services, storage: { ...lock.services.storage, resolved: pinned } },
      });

      yield* runLink(world);

      expect((yield* readServices(world.workdir)).storage).toMatchObject({
        resolution: "unobserved",
        resolved: pinned,
      });
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("records the same branch identity whether it was linked by ref or by name", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const world = yield* startWorld;
      const branchOf = () =>
        readLock(world.workdir).pipe(Effect.map((lock) => Option.getOrThrow(lock).linked?.branch));

      yield* runLink(world);
      yield* runLink(world, toBranch(world));
      const byName = yield* branchOf();
      yield* fs.remove(`${world.workdir}/supabase/supabase.lock`);
      yield* fs.remove(`${world.workdir}/supabase/.link.json`);
      yield* runLink(world, flags({ projectRef: Option.some(BRANCH_REF) }));

      expect(byName).toEqual({ ref: BRANCH_REF, isDefault: false });
      expect(yield* branchOf()).toEqual(byName);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("fails the link, leaving no lock or link, when an explicit pin is not published", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const world = yield* startWorld;
      yield* writeConfig(world, '[local.services.rest]\nversion = "v98.0.0"\n');

      const error = yield* runLink(world).pipe(Effect.flip);

      expect(error).toMatchObject({ _tag: "LockResolutionError", reason: "unpublished" });
      expect(yield* fs.exists(`${world.workdir}/supabase/supabase.lock`)).toBe(false);
      expect(yield* fs.exists(`${world.workdir}/supabase/.link.json`)).toBe(false);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("keeps the previous entry when a hosted probe fails and nothing else changed", () =>
    Effect.gen(function* () {
      const world = yield* startWorld;
      yield* runLink(world);
      const before = yield* readServices(world.workdir);
      world.tenant.rest = "fail";

      const out = yield* runLink(world);

      const after = yield* readServices(world.workdir);
      expect(after.rest).toEqual(before.rest);
      expect(warnings(out).join("\n")).toContain(`rest: the hosted version could not be read`);
      expect(warnings(out).join("\n")).toContain(`kept ${HOSTED}-r0`);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("takes nothing from the old remote when a probe fails after the link moved", () =>
    Effect.gen(function* () {
      const world = yield* startWorld;
      yield* runLink(world);
      world.tenant.rest = "fail";

      const out = yield* runLink(world, toBranch(world));

      const lock = yield* readLock(world.workdir).pipe(Effect.map(Option.getOrThrow));
      expect(lock.linked?.branch).toEqual({ ref: BRANCH_REF, isDefault: false });
      expect(out.messages.map(({ message }) => message).join("\n")).toContain(
        `now observing ${lock.linked?.project}/${BRANCH_REF}`,
      );
      expect(lock.services.rest).toMatchObject({
        resolution: "unobserved",
        resolved: {
          upstreamVersion: selection.rest.upstreamVersion,
          revision: selection.rest.revision,
        },
      });
      expect(lock.services.rest.linked).toBeUndefined();
      expect(lock.services.auth.linked?.version).toBe(HOSTED);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("targets the new remote in .link.json when the lock cannot be written", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const world = yield* startWorld;
      yield* runLink(world);
      const written = yield* lockText(world.workdir);

      const error = yield* runLinkWithLockWriteFailing(world, toBranch(world)).pipe(Effect.flip);

      expect(error).toMatchObject({ _tag: "LockResolutionError", reason: "io" });
      const document = yield* fs.readFileString(`${world.workdir}/supabase/.link.json`);
      expect(document).toContain(BRANCH_REF);
      expect(yield* lockText(world.workdir)).toBe(written);

      yield* runLink(world, toBranch(world));

      const lock = yield* readLock(world.workdir).pipe(Effect.map(Option.getOrThrow));
      expect(lock.linked?.branch.ref).toBe(BRANCH_REF);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("a frozen link records the target in .link.json and leaves the lock untouched", () =>
    Effect.gen(function* () {
      const world = yield* startWorld;
      yield* runLink(world, flags({ skipPooler: true }));
      const written = yield* lockText(world.workdir);
      world.tenant.rest = { status: 200, body: '{"info":{"version":"98.0.0"}}' };

      const out = yield* runLink(world, flags({ frozen: true }));

      expect(yield* lockText(world.workdir)).toBe(written);
      const document = yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.readFileString(`${world.workdir}/supabase/.link.json`)),
      );
      expect(document).toContain(POOLER_URL);
      expect(warnings(out).join("\n")).toContain(
        "Hosted versions differ from supabase/supabase.lock",
      );
      expect(out.messages.map(({ message }) => message).join("\n")).toContain(
        "supabase/supabase.lock was left untouched",
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );
});

describe("stack update follows the recorded observations", () => {
  it.live("stack update asks the linked project again and moves linked entries", () =>
    Effect.gen(function* () {
      const world = yield* startWorld;
      yield* runLink(world);
      publish(world.host, "rest", "v99.1.0");
      world.tenant.rest = { status: 200, body: '{"info":{"version":"99.1.0"}}' };

      yield* runUpdate(world);

      const services = yield* readServices(world.workdir);
      expect(services.rest).toMatchObject({
        linked: { version: "v99.1.0" },
        resolved: { upstreamVersion: "v99.1.0", revision: 0 },
      });
      expect(services.auth.resolved.upstreamVersion).toBe(HOSTED);
    }).pipe(Effect.provide(BunServices.layer)),
  );
});

describe("link warns when a saved stack would refuse the versions it locks", () => {
  const HOSTED_DATABASE = `${postgresMajor(selection.database.upstreamVersion)}.99.0.001`;
  const BUILT = selection.database.upstreamVersion;

  const seed = (
    world: World,
    data: Omit<Parameters<typeof seedProjectStack>[0], "projectRoot" | "supabaseHome">,
  ) =>
    seedProjectStack({
      ...data,
      projectRoot: world.workdir,
      supabaseHome: `${world.workdir}/.supabase`,
    });

  const hostDatabase = (world: World) => {
    publish(world.host, "database", HOSTED_DATABASE);
    world.target.database = HOSTED_DATABASE;
  };

  const stackWarnings = (out: ReturnType<typeof mockOutput>) =>
    warnings(out).filter((message) => message.startsWith("stack "));

  const destroy = (stackId: string) =>
    `run \`supabase stack destroy --stack-id ${stackId}\` to recreate the stack — this permanently deletes its local database data`;

  it.live(
    "offers pinning the recorded build when linking moves off the build that initialized the data",
    () =>
      Effect.gen(function* () {
        const world = yield* startWorld;
        hostDatabase(world);
        const stackId = yield* seed(world, { built: BUILT });

        const out = yield* runLink(world);

        expect(stackWarnings(out)).toEqual([
          `stack ${stackId}: the next supabase start refuses these pins: PostgreSQL data was initialized by stock PostgreSQL build ${BUILT}, but stock PostgreSQL build ${HOSTED_DATABASE} was requested; keep this data by pinning \`[local.services.database] version = "${BUILT}"\` in supabase/config.toml, or ${destroy(stackId)}`,
        ]);
        expect((yield* readServices(world.workdir)).database.resolved.upstreamVersion).toBe(
          HOSTED_DATABASE,
        );
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("stays quiet when the data was built by the version the link locks", () =>
    Effect.gen(function* () {
      const world = yield* startWorld;
      hostDatabase(world);
      yield* seed(world, {
        built: HOSTED_DATABASE,
        composed: ["auth"],
        migrated: { auth: HOSTED },
      });

      const out = yield* runLink(world);

      expect(stackWarnings(out)).toEqual([]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("leaves a frozen link silent about saved stacks", () =>
    Effect.gen(function* () {
      const world = yield* startWorld;
      yield* runLink(world);
      hostDatabase(world);
      yield* seed(world, { built: BUILT });

      const out = yield* runLink(world, flags({ frozen: true }));

      expect(stackWarnings(out)).toEqual([]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("still links when the saved stacks cannot be read", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const world = yield* startWorld;
      yield* fs.makeDirectory(`${world.workdir}/.supabase`, { recursive: true });
      yield* fs.writeFileString(`${world.workdir}/.supabase/stacks`, "not a directory");

      const out = yield* runLink(world);

      expect(stackWarnings(out)).toEqual([]);
      expect((yield* readServices(world.workdir)).auth.resolved.upstreamVersion).toBe(HOSTED);
    }).pipe(Effect.provide(BunServices.layer)),
  );
});
