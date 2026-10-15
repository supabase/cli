import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Path } from "effect";

import {
  mockCommandPlatformApiService,
  mockCommandSettings,
} from "../../tests/helpers/command-mocks.ts";
import { mockOutput } from "../../tests/helpers/mocks.ts";
import { ProjectRefResolver } from "../config/project-ref.service.ts";
import type { ProjectRefSource } from "../config/project-ref.service.ts";
import { commandTargetLayer } from "../shared/output/command-target.layer.ts";
import {
  configTargetErrorsFor,
  mintConfigTargetErrors,
  resolveConfigTarget,
} from "./project-target.ts";

const PARENT_REF = "parentparentparentpa";
const BRANCH_REF = "branchbranchbranchbr";
const BRANCH_UUID = "11111111-2222-4333-8444-555555555555";

const minted = mintConfigTargetErrors("ProjectTargetTest");
const errors = configTargetErrorsFor({
  notLinked: minted.BranchNotLinkedError,
  parentRefInvalid: minted.ParentRefInvalidError,
  branchNotFound: minted.BranchNotFoundError,
  branchNotReady: minted.BranchNotReadyError,
});

const resolverFor = (source: ProjectRefSource, matchesLinkedRef: boolean) =>
  Layer.succeed(ProjectRefResolver, {
    resolveRef: (flagValue) =>
      Effect.succeed({
        ref: Option.getOrElse(flagValue, () => PARENT_REF),
        source,
        matchesLinkedRef,
      }),
    resolve: () => Effect.die("resolve is not used by resolveConfigTarget"),
    resolveForLink: () => Effect.die("resolveForLink is not used by resolveConfigTarget"),
    resolveOptional: () => Effect.die("resolveOptional is not used by resolveConfigTarget"),
    promptProjectRef: () => Effect.die("promptProjectRef is not used by resolveConfigTarget"),
  });

const run = (
  requested: Option.Option<string>,
  options: { readonly savedRef?: string; readonly source?: ProjectRefSource } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "project-target-" });
    if (options.savedRef !== undefined) {
      yield* fs.makeDirectory(path.join(dir, "supabase", ".temp"), { recursive: true });
      yield* fs.writeFileString(
        path.join(dir, "supabase", ".temp", "project-ref"),
        options.savedRef,
      );
    }
    const out = mockOutput();
    const api = mockCommandPlatformApiService({
      v1: { getABranchConfig: () => Effect.succeed({ ref: BRANCH_REF }) },
    });
    return yield* resolveConfigTarget(requested, errors, () => Effect.die("unexpected")).pipe(
      Effect.provide(
        Layer.mergeAll(
          out.layer,
          commandTargetLayer.pipe(Layer.provide(out.layer)),
          resolverFor(options.source ?? "flag", options.savedRef === PARENT_REF),
          api.layer,
          mockCommandSettings({ workdir: dir, projectId: Option.none() }),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer));

describe("resolveConfigTarget linked target", () => {
  it.effect("carries the source and linked-ref match the ref chain resolved", () =>
    Effect.gen(function* () {
      const flag = yield* run(Option.some(PARENT_REF), { savedRef: PARENT_REF });
      expect(flag.linked).toEqual({
        kind: "linked",
        ref: PARENT_REF,
        source: "flag",
        matchesLinkedRef: true,
      });
      const file = yield* run(Option.none(), { source: "file", savedRef: PARENT_REF });
      expect(file.linked).toMatchObject({ source: "file", matchesLinkedRef: true });
    }),
  );

  it.effect("marks a branch resolved from a UUID as a flag source", () =>
    Effect.gen(function* () {
      const target = yield* run(Option.some(BRANCH_UUID));
      expect(target).toMatchObject({ ref: BRANCH_REF, branch: BRANCH_UUID });
      expect(target.linked).toEqual({
        kind: "linked",
        ref: BRANCH_REF,
        source: "flag",
        matchesLinkedRef: false,
      });
    }),
  );

  it.effect("matches the linked ref when the branch's own ref is the saved one", () =>
    Effect.gen(function* () {
      const target = yield* run(Option.some(BRANCH_UUID), { savedRef: BRANCH_REF });
      expect(target.linked.matchesLinkedRef).toBe(true);
    }),
  );
});
