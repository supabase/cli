import { Effect, Layer } from "effect";
import {
  BinaryResolver,
  type BinarySpec,
  type ResolveBinaryOptions,
} from "../../src/BinaryResolver.ts";
import { BinaryNotFoundError } from "../../src/errors.ts";
import { DEFAULT_VERSIONS } from "../../src/versions.ts";

export function mockBinaryResolver(
  opts: {
    binaries?: Record<string, string>;
    downloadedServices?: string[];
    downloadDelayMs?: number;
    downloadGates?: Partial<Record<string, Effect.Effect<void>>>;
    failServices?: string[];
  } = {},
) {
  const resolved: Array<{ service: string; version: string }> = [];
  const binaries = opts.binaries ?? {
    postgres: `/cache/postgres/${DEFAULT_VERSIONS.postgres}/darwin-arm64`,
    postgrest: `/cache/postgrest/${DEFAULT_VERSIONS.postgrest}/macos-aarch64`,
    auth: `/cache/auth/${DEFAULT_VERSIONS.auth}/arm64`,
    "edge-runtime": `/cache/edge-runtime/${DEFAULT_VERSIONS["edge-runtime"]}/aarch64-darwin`,
  };
  const resolveWithMetadata = (spec: BinarySpec, options?: ResolveBinaryOptions) =>
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
      const downloaded = opts.downloadedServices?.includes(spec.service) ?? false;
      if (downloaded) {
        yield* options?.onDownloadStart ?? Effect.void;
        const gate = opts.downloadGates?.[spec.service];
        if (gate) {
          yield* gate;
        } else if (opts.downloadDelayMs && opts.downloadDelayMs > 0) {
          yield* Effect.sleep(`${opts.downloadDelayMs} millis`);
        }
      }
      return { path, downloaded };
    });

  return {
    layer: Layer.succeed(BinaryResolver, {
      resolveWithMetadata,
      resolve: (spec) => Effect.map(resolveWithMetadata(spec), ({ path }) => path),
    }),
    resolved,
  };
}
