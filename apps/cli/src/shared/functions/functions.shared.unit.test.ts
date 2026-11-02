import { BunServices } from "@effect/platform-bun";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";
import { vi } from "vitest";

import { projectStateModeLayer } from "../config/project-state-mode.ts";
import { mockCommandSettings } from "../../../tests/helpers/command-mocks.ts";
import { seedLock } from "../../../tests/helpers/stack-lock.ts";
import { runtimeInfoLayer } from "../runtime/runtime-info.layer.ts";
import { dockerfileServiceImageRaw } from "../services/dockerfile-images.ts";
import {
  expectedPinnedImage,
  GHCR_SLIM_IMAGE_PATTERN,
} from "../../../tests/helpers/slim-images.ts";
import {
  DENO1_EDGE_RUNTIME_VERSION,
  edgeRuntimeImage,
  resolveEdgeRuntimeVersionPin,
} from "./functions.shared.ts";

const rawEdgeRuntimeImage = dockerfileServiceImageRaw("edgeruntime");
const currentEdgeRuntimeTag = rawEdgeRuntimeImage.slice(rawEdgeRuntimeImage.lastIndexOf(":") + 1);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("edgeRuntimeImage", () => {
  it("keeps the deno1 tag on the docker.io image even when the slim flag is on", () => {
    expect(edgeRuntimeImage(DENO1_EDGE_RUNTIME_VERSION, true)).toBe(
      `supabase/edge-runtime:${DENO1_EDGE_RUNTIME_VERSION}`,
    );
  });

  it("rewrites the current Dockerfile tag onto the catalog-pinned slim ghcr.io image when the flag is on", () => {
    const pinned = expectedPinnedImage("edgeruntime", rawEdgeRuntimeImage);
    expect(pinned).toMatch(GHCR_SLIM_IMAGE_PATTERN);
    expect(edgeRuntimeImage(currentEdgeRuntimeTag, true)).toBe(pinned);
  });

  it("keeps a historical pin on docker.io when the flag is on", () => {
    expect(edgeRuntimeImage("v1.73.0", true)).toBe("supabase/edge-runtime:v1.73.0");
  });
});

describe("resolveEdgeRuntimeVersionPin", () => {
  it.effect(
    "falls back to the Dockerfile tag, not the ghcr host, when slim is on and no pin file exists",
    () =>
      Effect.gen(function* () {
        vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "true");
        const tag = yield* resolveEdgeRuntimeVersionPin("/no-such-supabase-dir");
        expect(tag).toBe(currentEdgeRuntimeTag);
        expect(tag.includes("/")).toBe(false);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            BunServices.layer,
            runtimeInfoLayer,
            mockCommandSettings({ workdir: "/no-such-supabase-dir" }),
          ),
        ),
      ),
  );

  it.effect("pins the locked slim image revision in stack mode only when slim images are on", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "edge-runtime-pin-" });
      yield* fs.makeDirectory(path.join(root, "supabase"), { recursive: true });
      yield* fs.writeFileString(
        path.join(root, "supabase", "config.toml"),
        'project_id = "test-project"\n',
      );
      const lockedImage = `ghcr.io/supabase/cli/edge-runtime:v1.99.0-r1@sha256:${"a".repeat(64)}`;
      yield* seedLock(root, (services) => ({
        ...services,
        functions: {
          ...services.functions,
          resolved: {
            ...services.functions.resolved,
            upstreamVersion: "v1.99.0",
            revision: 1,
            image: lockedImage,
            upstreamImage: "supabase/edge-runtime:v1.99.0",
          },
        },
      })).pipe(
        Effect.provide(
          Layer.mergeAll(
            runtimeInfoLayer,
            mockCommandSettings({ workdir: root, supabaseHome: root }),
          ),
        ),
      );

      vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "");
      const upstreamPin = yield* resolveEdgeRuntimeVersionPin(root);
      expect(edgeRuntimeImage(upstreamPin, false)).toBe("supabase/edge-runtime:v1.99.0");

      vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "true");
      const slimPin = yield* resolveEdgeRuntimeVersionPin(root);
      expect(edgeRuntimeImage(slimPin, true)).toBe(lockedImage);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(BunServices.layer, projectStateModeLayer("stack"))),
    ),
  );

  it.effect("fails with a typed error when the stack lock is unreadable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "edge-runtime-pin-" });
      yield* fs.makeDirectory(path.join(root, "supabase"), { recursive: true });
      yield* fs.writeFileString(path.join(root, "supabase", "supabase.lock"), "not a lock");

      const error = yield* resolveEdgeRuntimeVersionPin(root).pipe(Effect.flip);

      expect(error).toMatchObject({ _tag: "LockResolutionError", reason: "invalid-lock" });
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(BunServices.layer, projectStateModeLayer("stack"))),
    ),
  );
});
