import { describe, expect, it } from "@effect/vitest";
import type { V1ListAllBranchesOutput } from "@supabase/api/effect";
import { holdLock } from "@supabase/stack/effect";
import { Effect, FileSystem, Layer, Option, Path } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import { TestClock } from "effect/testing";

import { mockAnalytics, mockOutput } from "../../../tests/helpers/mocks.ts";
import {
  legacyStateAccesses,
  recordingFileSystem,
  seedLegacyStateDecoys,
} from "../../../tests/helpers/legacy-state-guard.ts";
import {
  VALID_REF,
  buildTestRuntime,
  mockCommandPlatformApiService,
  mockCommandSettings,
  mockTelemetryStateTracked,
  statusCodeFailure,
  useTempWorkdir,
} from "../../../tests/helpers/command-mocks.ts";
import { projectStateModeLayer } from "../../command-internal/project-state-mode.ts";
import {
  ProjectLinkIoError,
  ProjectLinkMalformedError,
  readProjectLink,
  writeProjectLink,
} from "../../command-internal/project-link.ts";
import { RemoteTarget } from "../../config/remote-target.service.ts";
import { link } from "./link.handler.ts";
import type { LinkFlags } from "./link.command.ts";

const BRANCH_REF = "branchprojectrefabcd";
const POOLER_URL = "postgresql://postgres.ref@pooler.example.co:5432/postgres";

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

// These projects have no supabase/config.toml, so there is no lock to record and no tenant probe.
const noTenantHttp = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make(() =>
    Effect.die("stack-mode link without a config must not call tenant endpoints"),
  ),
);

const tempRoot = useTempWorkdir("supabase-link-stack-int-");

interface SetupOpts {
  readonly projectFails?: boolean;
  readonly branches?: typeof V1ListAllBranchesOutput.Type;
}

function setup(opts: SetupOpts = {}) {
  const recorder = recordingFileSystem();
  const out = mockOutput({ format: "text" });
  const apiMock = mockCommandPlatformApiService({
    v1: {
      getProject: () =>
        opts.projectFails === true ? Effect.fail(statusCodeFailure(404)) : Effect.succeed(PROJECT),
      getProjectApiKeys: () => Effect.succeed(SERVICE_KEYS),
      getPoolerConfig: () => Effect.succeed(POOLER),
      listAllBranches: () => Effect.succeed(opts.branches ?? []),
    },
  });
  const layer = Layer.mergeAll(
    buildTestRuntime({
      out,
      api: { layer: apiMock.layer, httpClientLayer: noTenantHttp },
      cliSettings: mockCommandSettings({ workdir: tempRoot.current, projectId: Option.none() }),
      analytics: mockAnalytics(),
      telemetry: mockTelemetryStateTracked().layer,
      fileSystem: recorder.layer,
    }),
    projectStateModeLayer("stack"),
  );
  return { layer, workdir: tempRoot.current, accessed: recorder.accessed };
}

const flags = (overrides: Partial<LinkFlags> = {}): LinkFlags => ({
  refOrBranch: Option.none(),
  projectRef: Option.some(VALID_REF),
  password: Option.none(),
  skipPooler: false,
  frozen: false,
  ...overrides,
});

const readSupabaseFile = Effect.fnUntraced(function* (workdir: string, ...segments: string[]) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fs.readFileString(path.join(workdir, "supabase", ...segments));
});

const tempDirExists = Effect.fnUntraced(function* (workdir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fs.exists(path.join(workdir, "supabase", ".temp"));
});

const seedLink = writeProjectLink;

describe("link integration in stack mode", () => {
  it.effect("writes the whole link into supabase/.link.json and nothing under .temp", () => {
    const { layer, workdir } = setup();
    return Effect.gen(function* () {
      yield* link(flags());

      const document = yield* readProjectLink(workdir);
      expect(Option.getOrUndefined(document)).toEqual({
        project: {
          ref: VALID_REF,
          name: "My Project",
          organization_id: "org_123",
          organization_slug: "acme",
        },
        active_branch: { ref: VALID_REF, pooler_url: POOLER_URL },
        fetchedAt: expect.any(String),
      });
      expect(yield* tempDirExists(workdir)).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect("never reads or writes supabase/.temp and ignores a legacy link left there", () => {
    const { layer, workdir, accessed } = setup();
    return Effect.andThen(
      seedLegacyStateDecoys(workdir),
      Effect.gen(function* () {
        yield* link(flags());

        const document = yield* readProjectLink(workdir);
        expect(Option.map(document, (value) => value.project.ref)).toEqual(Option.some(VALID_REF));
        expect(accessed.some((entry) => entry.includes(".link.json"))).toBe(true);
        expect(legacyStateAccesses(accessed)).toEqual([]);
      }).pipe(Effect.provide(layer)),
    );
  });

  it.effect("keeps the link, its staged writes, and the stack lease out of version control", () => {
    const { layer, workdir } = setup();
    return Effect.gen(function* () {
      yield* link(flags());
      const ignored = (yield* readSupabaseFile(workdir, ".gitignore")).split("\n");
      expect(ignored).toContain(".link.json");
      expect(ignored).toContain("..link.json.*.tmp");
      expect(ignored).toContain(".supabase.lock.lease");
      expect(ignored).toContain(".supabase.lock.*.tmp");
    }).pipe(Effect.provide(layer));
  });

  it.effect("leaves a symlinked supabase/.gitignore and its target untouched", () => {
    const { layer, workdir } = setup();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const outside = path.join(workdir, "outside-gitconfig");
      yield* fs.writeFileString(outside, "[user]\n\tname = kept\n");
      yield* fs.makeDirectory(path.join(workdir, "supabase"), { recursive: true });
      const gitignore = path.join(workdir, "supabase", ".gitignore");
      yield* fs.symlink(outside, gitignore);

      yield* link(flags());

      expect(yield* fs.readFileString(outside)).toBe("[user]\n\tname = kept\n");
      expect(yield* fs.readLink(gitignore)).toBe(outside);
      expect(Option.isSome(yield* readProjectLink(workdir))).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails on a busy project lease without replacing the existing link", () => {
    const { layer, workdir } = setup();
    return Effect.gen(function* () {
      const path = yield* Path.Path;
      yield* seedLink(workdir, {
        project: { ref: "previousprojectrefabc" },
        active_branch: { ref: "previousprojectrefabc" },
        fetchedAt: "2026-01-01T00:00:00.000Z",
      });
      yield* holdLock(
        path.join(workdir, "supabase", ".supabase.lock.lease"),
        "1 hour",
        "supabase.lock",
      );

      // The lease wait runs on the test clock; the lock stays held, so the outcome is fixed.
      const error = yield* link(flags()).pipe(
        Effect.flip,
        Effect.raceFirst(
          TestClock.adjust("61 seconds").pipe(Effect.andThen(Effect.yieldNow), Effect.forever),
        ),
      );

      expect(error).toMatchObject({ _tag: "LockResolutionError", reason: "lease-busy" });
      const document = yield* readProjectLink(workdir);
      expect(Option.map(document, (value) => value.project.ref)).toEqual(
        Option.some("previousprojectrefabc"),
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("omits the pooler URL with --skip-pooler", () => {
    const { layer, workdir } = setup();
    return Effect.gen(function* () {
      yield* link(flags({ skipPooler: true }));
      const document = yield* readProjectLink(workdir);
      expect(Option.map(document, (value) => value.active_branch)).toEqual(
        Option.some({ ref: VALID_REF }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("records a name-resolved branch as the active branch of its parent", () => {
    const { layer, workdir } = setup({ projectFails: true, branches: [FEATURE_BRANCH] });
    return Effect.gen(function* () {
      yield* seedLink(workdir, {
        project: { ref: VALID_REF, name: "My Project", organization_id: "org_123" },
        active_branch: { ref: VALID_REF },
        fetchedAt: "2026-01-01T00:00:00.000Z",
      });

      yield* link(flags({ refOrBranch: Option.some("feature-branch"), projectRef: Option.none() }));

      const document = yield* readProjectLink(workdir);
      expect(Option.getOrUndefined(document)).toEqual({
        project: { ref: VALID_REF, name: "My Project", organization_id: "org_123" },
        active_branch: {
          ref: BRANCH_REF,
          name: "feature-branch",
          is_default: false,
          pooler_url: POOLER_URL,
        },
        fetchedAt: expect.any(String),
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("treats a raw branch ref unknown to the previous project as its own project", () => {
    const { layer, workdir } = setup({ projectFails: true, branches: [] });
    return Effect.gen(function* () {
      yield* seedLink(workdir, {
        project: { ref: VALID_REF },
        active_branch: { ref: VALID_REF },
        fetchedAt: "2026-01-01T00:00:00.000Z",
      });

      yield* link(flags({ projectRef: Option.some(BRANCH_REF) }));

      const document = yield* readProjectLink(workdir);
      expect(Option.map(document, (value) => value.project.ref)).toEqual(Option.some(BRANCH_REF));
      expect(Option.map(document, (value) => value.active_branch.ref)).toEqual(
        Option.some(BRANCH_REF),
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps the previous project for a raw branch ref the project still lists", () => {
    const { layer, workdir } = setup({ projectFails: true, branches: [FEATURE_BRANCH] });
    return Effect.gen(function* () {
      yield* seedLink(workdir, {
        project: { ref: VALID_REF },
        active_branch: { ref: VALID_REF },
        fetchedAt: "2026-01-01T00:00:00.000Z",
      });

      yield* link(flags({ projectRef: Option.some(BRANCH_REF) }));

      const document = yield* readProjectLink(workdir);
      expect(Option.map(document, (value) => value.project.ref)).toEqual(Option.some(VALID_REF));
      expect(Option.map(document, (value) => value.active_branch.ref)).toEqual(
        Option.some(BRANCH_REF),
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("later commands resolve the linked ref from the active branch", () => {
    const { layer, workdir } = setup();
    return Effect.gen(function* () {
      yield* seedLink(workdir, {
        project: { ref: VALID_REF },
        active_branch: { ref: BRANCH_REF },
        fetchedAt: "2026-01-01T00:00:00.000Z",
      });

      const resolver = yield* RemoteTarget;

      expect((yield* resolver.resolve(Option.none())).ref).toBe(BRANCH_REF);
    }).pipe(Effect.provide(layer));
  });

  it.effect("a malformed link document fails ref resolution with the relink hint", () => {
    const { layer, workdir } = setup();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.join(workdir, "supabase"), { recursive: true });
      yield* fs.writeFileString(path.join(workdir, "supabase", ".link.json"), "{not json");
      const resolver = yield* RemoteTarget;

      const error = yield* resolver.resolve(Option.none()).pipe(Effect.flip);

      expect(error).toBeInstanceOf(ProjectLinkMalformedError);
      expect(error).toHaveProperty("suggestion", expect.stringContaining("supabase link"));
    }).pipe(Effect.provide(layer));
  });

  it.effect("an unreadable link document fails ref resolution with an I/O error", () => {
    const { layer, workdir } = setup();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.join(workdir, "supabase", ".link.json"), { recursive: true });
      const resolver = yield* RemoteTarget;

      const error = yield* resolver.resolve(Option.none()).pipe(Effect.flip);

      expect(error).toBeInstanceOf(ProjectLinkIoError);
    }).pipe(Effect.provide(layer));
  });
});
