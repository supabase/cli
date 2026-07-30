import { describe, expect, test } from "vitest";
import { Effect } from "effect";
import { mockBinaryResolver } from "../tests/helpers/mocks.ts";
import { BinaryResolver } from "./BinaryResolver.ts";
import { toStackError } from "./errors.ts";
import { resolveService } from "./resolve.ts";
import { DEFAULT_VERSIONS } from "./versions.ts";

const run = <A, E>(
  effect: Effect.Effect<A, E, BinaryResolver>,
  layer: ReturnType<typeof mockBinaryResolver>["layer"],
) => Effect.runPromise(effect.pipe(Effect.provide(layer)));

describe("resolveService", () => {
  test("native mode propagates BinaryNotFoundError instead of resolving to Docker", async () => {
    const resolver = mockBinaryResolver({ failServices: ["auth"] });
    const error = await run(
      Effect.gen(function* () {
        const service = yield* BinaryResolver;
        return yield* resolveService(service, "auth", DEFAULT_VERSIONS.auth, "native").pipe(
          Effect.flip,
        );
      }),
      resolver.layer,
    );
    expect(error._tag).toBe("BinaryNotFoundError");
    // The surfaced failure must be actionable, not a bare tag name — this is
    // what the CLI renders (both `Error.message` and `toStackError` read it).
    expect(error.message).toContain("No native auth binary is available");
    expect(error.message).toContain('use mode "auto" or "docker"');
    expect(toStackError(error).message).toBe(error.message);
  });

  test("native mode propagates DownloadError instead of resolving to Docker", async () => {
    const resolver = mockBinaryResolver({ downloadErrorServices: ["postgres"] });
    const error = await run(
      Effect.gen(function* () {
        const service = yield* BinaryResolver;
        return yield* resolveService(service, "postgres", DEFAULT_VERSIONS.postgres, "native").pipe(
          Effect.flip,
        );
      }),
      resolver.layer,
    );
    expect(error._tag).toBe("DownloadError");
    expect(error.message).toContain("Failed to download https://releases.invalid/postgres/");
    expect(error.message).toContain("404 Not Found");
    expect(toStackError(error).message).toBe(error.message);
  });

  test("auto mode (the default) still falls back to a Docker image", async () => {
    const resolver = mockBinaryResolver({ failServices: ["auth"] });
    const resolution = await run(
      Effect.gen(function* () {
        const service = yield* BinaryResolver;
        return yield* resolveService(service, "auth", DEFAULT_VERSIONS.auth);
      }),
      resolver.layer,
    );
    expect(resolution).toEqual({
      type: "docker",
      image: `public.ecr.aws/supabase/gotrue:v${DEFAULT_VERSIONS.auth}`,
    });
  });
});
