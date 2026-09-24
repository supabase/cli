import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- The test supplies an independently valid private key.
import { generateKeyPairSync } from "node:crypto";
import { DEFAULT_LOCAL_TLS_CERT, DEFAULT_LOCAL_TLS_KEY } from "./Defaults.ts";
import { validateGatewayConfig } from "./Gateway.ts";

const unrelatedPrivateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ format: "pem", type: "pkcs8" })
  .toString();

describe("gateway TLS configuration", () => {
  it.effect("accepts a matching certificate and key", () =>
    Effect.gen(function* () {
      const config = yield* validateGatewayConfig({
        tls: { cert: DEFAULT_LOCAL_TLS_CERT, key: DEFAULT_LOCAL_TLS_KEY },
      });

      expect(config.tls).toEqual({ cert: DEFAULT_LOCAL_TLS_CERT, key: DEFAULT_LOCAL_TLS_KEY });
    }),
  );

  it.effect("rejects a certificate and key that do not match", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        validateGatewayConfig({
          tls: { cert: DEFAULT_LOCAL_TLS_CERT, key: unrelatedPrivateKey },
        }),
      );

      expect(error._tag).toBe("GatewayTlsConfigError");
      expect(error.message.toLowerCase()).toContain("mismatch");
    }),
  );
});
