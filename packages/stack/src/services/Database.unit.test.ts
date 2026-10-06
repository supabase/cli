import { describe, expect, it } from "@effect/vitest";
import { Cause, ConfigProvider, Effect, Exit, Fiber, FileSystem, Option, Ref } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { nativeTrustStore, processExit } from "./Database.ts";

it.effect("waits for the stderr tail after a long-running native PostgreSQL exits", () =>
  Effect.gen(function* () {
    const tail = yield* Ref.make("");
    const drained = yield* Effect.forkChild(
      Effect.sleep("2500 millis").pipe(Effect.andThen(Ref.set(tail, "FATAL: data directory"))),
    );
    const settled = yield* Effect.forkChild(
      processExit(Effect.sleep("2 seconds").pipe(Effect.as(1)), { tail, drained }),
    );
    yield* TestClock.adjust("3 seconds");
    const exit = yield* Fiber.join(settled);
    const error = Exit.isFailure(exit)
      ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
      : undefined;
    expect(error?.message).toBe("PostgreSQL exited with code 1: FATAL: data directory");
  }),
);

describe("native PostgreSQL trust store", () => {
  const trustStoreOn = (env: Record<string, string>, files: ReadonlyArray<string>) =>
    nativeTrustStore.pipe(
      Effect.provide([
        FileSystem.layerNoop({ exists: (path) => Effect.succeed(files.includes(path)) }),
        ConfigProvider.layer(ConfigProvider.fromEnvRecord(env, { preserveEmptyStrings: true })),
      ]),
    );

  it.effect("lends http and pg_net the host CA bundle when no trust store is exported", () =>
    Effect.gen(function* () {
      expect(yield* trustStoreOn({}, ["/etc/ssl/cert.pem"])).toEqual({
        SSL_CERT_FILE: "/etc/ssl/cert.pem",
      });
      expect(
        yield* trustStoreOn({ SSL_CERT_FILE: "" }, ["/etc/pki/tls/certs/ca-bundle.crt"]),
      ).toEqual({ SSL_CERT_FILE: "/etc/pki/tls/certs/ca-bundle.crt" });
    }),
  );

  it.effect("keeps the trust store exported on the host", () =>
    Effect.gen(function* () {
      const files = ["/etc/ssl/cert.pem"];
      expect(yield* trustStoreOn({ SSL_CERT_FILE: "/corp/ca.pem" }, files)).toEqual({
        SSL_CERT_FILE: "/corp/ca.pem",
      });
      expect(yield* trustStoreOn({ SSL_CERT_DIR: "/corp/certs" }, files)).toEqual({
        SSL_CERT_DIR: "/corp/certs",
      });
    }),
  );

  it.effect("leaves the PostgreSQL environment alone when the host has no CA bundle", () =>
    Effect.gen(function* () {
      expect(yield* trustStoreOn({}, [])).toEqual({});
    }),
  );
});
