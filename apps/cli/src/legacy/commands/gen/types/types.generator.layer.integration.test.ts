import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, Exit, Layer } from "effect";

import {
  LegacyPgDeltaSslProbe,
  LegacyPgDeltaSslProbeError,
} from "../../../shared/legacy-pgdelta-ssl-probe.service.ts";
import { legacyGenTypesGeneratorLayer } from "./types.generator.layer.ts";
import { LegacyGenTypesGenerator } from "./types.generator.ts";

function failingProbeLayer(message: string) {
  return Layer.succeed(LegacyPgDeltaSslProbe, {
    requireSsl: () => Effect.fail(new LegacyPgDeltaSslProbeError({ message })),
    requireSslForHost: () => Effect.fail(new LegacyPgDeltaSslProbeError({ message })),
  });
}

describe("legacyGenTypesGeneratorLayer", () => {
  it.live("fails closed when the remote SSL probe cannot determine TLS capability", () => {
    const layer = legacyGenTypesGeneratorLayer.pipe(
      Layer.provide(failingProbeLayer("connection refused")),
      Layer.provide(BunServices.layer),
    );

    return Effect.gen(function* () {
      const generator = yield* LegacyGenTypesGenerator;
      const exit = yield* generator
        .generate({
          conn: {
            host: "db.example.com",
            port: 5432,
            user: "postgres",
            password: "secret",
            database: "postgres",
          },
          isLocal: false,
          dnsResolver: "https",
          lang: "go",
          includedSchemas: [],
          postgrestV9Compat: false,
          swiftAccessControl: "internal",
          queryTimeoutSeconds: 15,
        })
        .pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toContain("LegacyPgDeltaSslProbeError");
        expect(String(exit.cause)).toContain("connection refused");
      }
    }).pipe(Effect.provide(layer));
  });
});
