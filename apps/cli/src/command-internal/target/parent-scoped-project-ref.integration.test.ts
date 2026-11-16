import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Option, Path } from "effect";

import {
  buildTestRuntime,
  jsonResponse,
  mockCommandPlatformApi,
  mockCommandSettings,
  unverifiedTargetBanner,
  useTempWorkdir,
} from "../../../tests/helpers/command-mocks.ts";
import { mockOutput } from "../../../tests/helpers/mocks.ts";
import { assertBlockDrift } from "../../../tests/helpers/permission-drift.ts";
import { branchRow } from "../../../tests/helpers/remote-selection.ts";
import { branchesParentTarget } from "../../commands/branches/branches.target.ts";
import type { RemoteValue } from "./remote-value.ts";
import { resolveProjectTarget } from "./resolve-project-target.ts";

const CACHED_PARENT = "cachedparentprojecta";
const LINKED_REF = "linkedprojectrefabcd";
const OTHER_BRANCH_REF = "otherbranchrefabcdef";
const ENV_REF = "envprojectrefaaaaaaa";
const FLAG_REF = "flagprojectrefabcdef";
const API = "https://api.supabase.com";

const tempRoot = useTempWorkdir("supabase-parent-scoped-ref-int-");

interface Listing {
  readonly status: number;
  readonly body: unknown;
}

const parentBranch = (projectRef: string) =>
  branchRow(`branch-${projectRef}`, { project_ref: projectRef, parent_project_ref: CACHED_PARENT });

const branches = (...refs: ReadonlyArray<string>): Listing => ({
  status: 200,
  body: refs.map(parentBranch),
});

const failure = (status: number): Listing => ({ status, body: { message: "failed" } });

const listingRequest = (projectRef: string) => `GET ${API}/v1/projects/${projectRef}/branches`;

interface LinkState {
  readonly file?: string;
  readonly cache?: string;
  readonly env?: string;
  readonly remote?: RemoteValue;
}

interface DifferingCacheCase {
  readonly name: string;
  readonly listings: Readonly<Record<string, Listing>>;
  readonly expected: { readonly ref: string; readonly requests: string[]; readonly banner: string };
}

interface NoCheckCase {
  readonly name: string;
  readonly state: LinkState;
  readonly ref: string;
}

function resolveParent(state: LinkState, listings: Readonly<Record<string, Listing>>) {
  const out = mockOutput();
  const api = mockCommandPlatformApi({
    handler: (request) => {
      const projectRef = /\/v1\/projects\/([a-z]{20})\/branches$/.exec(request.url)?.[1];
      const listing = projectRef === undefined ? undefined : listings[projectRef];
      return Effect.succeed(
        listing === undefined
          ? jsonResponse(request, 404, { message: "unexpected request" })
          : jsonResponse(request, listing.status, listing.body),
      );
    },
  });
  const layer = buildTestRuntime({
    out,
    api,
    cliSettings: mockCommandSettings({
      workdir: tempRoot.current,
      projectId: Option.fromNullishOr(state.env),
    }),
  });
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tempDir = path.join(tempRoot.current, "supabase", ".temp");
    yield* fs.makeDirectory(tempDir, { recursive: true });
    if (state.file !== undefined) {
      yield* fs.writeFileString(path.join(tempDir, "project-ref"), state.file);
    }
    if (state.cache !== undefined) {
      yield* fs.writeFileString(
        path.join(tempDir, "linked-project.json"),
        `{"ref":"${state.cache}","name":"Parent Project","organization_id":"org_1","organization_slug":"acme"}`,
      );
    }
    const ref = yield* resolveProjectTarget(
      { remote: Option.fromNullishOr(state.remote), projectRef: Option.none() },
      { parent: true },
    );
    assertBlockDrift(branchesParentTarget, { requests: api.requests });
    return {
      ref,
      requests: api.requests.map(({ method, url }) => `${method} ${url}`),
      banner: out.stderrText,
    };
  }).pipe(Effect.provide(layer));
}

describe("a parent-scoped command whose cached parent differs from the linked project", () => {
  const cachedParentBanner = `Target: project Parent Project (${CACHED_PARENT}) · production\n`;

  const differingCacheCases: ReadonlyArray<DifferingCacheCase> = [
    {
      name: "keeps the cached parent while it lists the linked project as a branch",
      listings: { [CACHED_PARENT]: branches(OTHER_BRANCH_REF, LINKED_REF) },
      expected: {
        ref: CACHED_PARENT,
        requests: [listingRequest(CACHED_PARENT)],
        banner: cachedParentBanner,
      },
    },
    {
      name: "switches to the linked project, announced without the cache's name, once the cached parent no longer lists it",
      listings: { [CACHED_PARENT]: branches(OTHER_BRANCH_REF), [LINKED_REF]: branches() },
      expected: {
        ref: LINKED_REF,
        requests: [listingRequest(CACHED_PARENT), listingRequest(LINKED_REF)],
        banner: unverifiedTargetBanner(LINKED_REF),
      },
    },
    {
      name: "keeps the cached parent when the linked project's own branches cannot be listed",
      listings: { [CACHED_PARENT]: branches(OTHER_BRANCH_REF), [LINKED_REF]: failure(403) },
      expected: {
        ref: CACHED_PARENT,
        requests: [listingRequest(CACHED_PARENT), listingRequest(LINKED_REF)],
        banner: cachedParentBanner,
      },
    },
    {
      name: "keeps the cached parent when its own branches cannot be listed",
      listings: { [CACHED_PARENT]: failure(500), [LINKED_REF]: branches() },
      expected: {
        ref: CACHED_PARENT,
        requests: [listingRequest(CACHED_PARENT)],
        banner: cachedParentBanner,
      },
    },
  ];

  it.effect.each(differingCacheCases)("$name", ({ listings, expected }) =>
    Effect.gen(function* () {
      const resolved = yield* resolveParent({ file: LINKED_REF, cache: CACHED_PARENT }, listings);
      expect(resolved).toEqual(expected);
    }),
  );

  const noCheckCases: ReadonlyArray<NoCheckCase> = [
    {
      name: "there is no cache",
      state: { file: LINKED_REF },
      ref: LINKED_REF,
    },
    {
      name: "the cache names the linked project itself",
      state: { file: CACHED_PARENT, cache: CACHED_PARENT },
      ref: CACHED_PARENT,
    },
    {
      name: "SUPABASE_PROJECT_ID names the project",
      state: { file: LINKED_REF, cache: CACHED_PARENT, env: ENV_REF },
      ref: ENV_REF,
    },
    {
      name: "--remote=<ref> names the project",
      state: { file: LINKED_REF, cache: CACHED_PARENT, remote: { _tag: "Ref", ref: FLAG_REF } },
      ref: FLAG_REF,
    },
  ];

  it.effect.each(noCheckCases)(
    "lists no branches to check the cache when $name",
    ({ state, ref }) =>
      Effect.gen(function* () {
        const resolved = yield* resolveParent(state, {});
        expect(resolved).toMatchObject({ ref, requests: [] });
      }),
  );
});
