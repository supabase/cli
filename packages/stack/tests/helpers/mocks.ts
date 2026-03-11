import { Effect, Layer } from "effect";
import { BinaryResolver } from "../../src/BinaryResolver.ts";
import { BinaryNotFoundError } from "../../src/errors.ts";

export function mockBinaryResolver(
  opts: {
    binaries?: Record<string, string>;
    failServices?: string[];
  } = {},
) {
  const resolved: Array<{ service: string; version: string }> = [];
  const binaries = opts.binaries ?? {
    postgres: "/cache/postgres/17/darwin-arm64",
    postgrest: "/cache/postgrest/14.5/macos-aarch64",
    auth: "/cache/auth/2.187.0/arm64",
  };

  return {
    layer: Layer.succeed(BinaryResolver, {
      resolve: (spec) =>
        Effect.gen(function* () {
          if (opts.failServices?.includes(spec.service)) {
            return yield* new BinaryNotFoundError({
              service: spec.service,
              platform: "darwin-arm64",
            });
          }
          resolved.push({ service: spec.service, version: spec.version });
          const path = binaries[spec.service];
          if (!path) {
            return yield* new BinaryNotFoundError({
              service: spec.service,
              platform: "darwin-arm64",
            });
          }
          return path;
        }),
    }),
    resolved,
  };
}
