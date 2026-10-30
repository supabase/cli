import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import {
  NpmPackagesNotInstallable,
  NpmRegistryRejected,
  waitUntilInstallable,
  type PackageVersion,
} from "./npm-registry.ts";

const REGISTRY_URL = "https://registry.test";
const VERSION = "3.0.0";
const DARWIN: PackageVersion = { name: "@supabase/cli-darwin-arm64", version: VERSION };
const WINDOWS: PackageVersion = { name: "@supabase/cli-windows-x64", version: VERSION };

const notFound = () => new Response("{}", { status: 404 });
const forbidden = () => new Response("{}", { status: 403 });
const packument = (versions: ReadonlyArray<string>) =>
  new Response(
    JSON.stringify({ versions: Object.fromEntries(versions.map((v) => [v, { version: v }])) }),
    { status: 200 },
  );

/** `respond` receives the request URL and how many times that URL was requested before. */
const stubRegistry = (respond: (url: string, attempt: number) => Response) => {
  const requests: Array<{ url: string; accept: string | undefined }> = [];
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        const attempt = requests.filter((r) => r.url === request.url).length;
        requests.push({ url: request.url, accept: request.headers.accept });
        return HttpClientResponse.fromWeb(request, respond(request.url, attempt));
      }),
    ),
  );
  return { layer, requests };
};

describe("waitUntilInstallable", () => {
  it.effect("resolves once the install packument lists the version", () => {
    const registry = stubRegistry((_url, attempt) =>
      attempt === 0
        ? notFound()
        : attempt === 1
          ? packument(["2.9.0"])
          : packument(["2.9.0", VERSION]),
    );
    return Effect.gen(function* () {
      const installable: Array<string> = [];
      const fiber = yield* waitUntilInstallable({
        registryUrl: REGISTRY_URL,
        packages: [DARWIN],
        onInstallable: (pkg) => Effect.sync(() => void installable.push(pkg.name)),
      }).pipe(Effect.forkChild({ startImmediately: true }));

      yield* TestClock.adjust("10 seconds");
      expect(fiber.pollUnsafe()).toBeUndefined();
      expect(installable).toEqual([]);

      yield* TestClock.adjust("10 seconds");
      yield* Fiber.join(fiber);

      expect(installable).toEqual([DARWIN.name]);
      expect(registry.requests).toEqual(
        Array.from({ length: 3 }, () => ({
          url: "https://registry.test/@supabase%2Fcli-darwin-arm64",
          accept: "application/vnd.npm.install-v1+json",
        })),
      );
    }).pipe(Effect.provide(registry.layer));
  });

  it.effect("abandons a hung probe and keeps polling", () => {
    let attempts = 0;
    const layer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        attempts++ === 0
          ? Effect.never
          : Effect.succeed(HttpClientResponse.fromWeb(request, packument([VERSION]))),
      ),
    );
    return Effect.gen(function* () {
      const fiber = yield* waitUntilInstallable({
        registryUrl: REGISTRY_URL,
        packages: [DARWIN],
        onInstallable: () => Effect.void,
      }).pipe(Effect.forkChild({ startImmediately: true }));

      yield* TestClock.adjust("1 minute");
      yield* Fiber.join(fiber);

      expect(attempts).toBe(2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails naming only the packages that never became installable", () => {
    const registry = stubRegistry((url) =>
      packument(url.includes("darwin") ? [VERSION] : ["2.9.0"]),
    );
    return Effect.gen(function* () {
      const installable: Array<string> = [];
      const fiber = yield* waitUntilInstallable({
        registryUrl: REGISTRY_URL,
        packages: [DARWIN, WINDOWS],
        onInstallable: (pkg) => Effect.sync(() => void installable.push(pkg.name)),
      }).pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));

      yield* TestClock.adjust("14 minutes");
      expect(fiber.pollUnsafe()).toBeUndefined();

      yield* TestClock.adjust("2 minutes");
      const error = yield* Fiber.join(fiber);

      expect(error).toBeInstanceOf(NpmPackagesNotInstallable);
      expect(error.message).toContain(
        `${WINDOWS.name}@${VERSION} (last probe: ${VERSION} not listed yet)`,
      );
      expect(error.message).not.toContain(DARWIN.name);
      expect(installable).toEqual([DARWIN.name]);
    }).pipe(Effect.provide(registry.layer));
  });

  it.effect("keeps polling through request timeouts and throttling", () => {
    const registry = stubRegistry((_url, attempt) =>
      attempt === 0
        ? new Response("{}", { status: 408 })
        : attempt === 1
          ? new Response("{}", { status: 429 })
          : packument([VERSION]),
    );
    return Effect.gen(function* () {
      const fiber = yield* waitUntilInstallable({
        registryUrl: REGISTRY_URL,
        packages: [DARWIN],
        onInstallable: () => Effect.void,
      }).pipe(Effect.forkChild({ startImmediately: true }));

      yield* TestClock.adjust("20 seconds");
      yield* Fiber.join(fiber);

      expect(registry.requests).toHaveLength(3);
    }).pipe(Effect.provide(registry.layer));
  });

  it.effect("fails immediately on a client error other than 404, 408 or 429", () => {
    const registry = stubRegistry(() => forbidden());
    return Effect.gen(function* () {
      const fiber = yield* waitUntilInstallable({
        registryUrl: REGISTRY_URL,
        packages: [DARWIN],
        onInstallable: () => Effect.void,
      }).pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));

      yield* TestClock.adjust("1 minute");
      expect(registry.requests).toHaveLength(1);
      const error = yield* Fiber.join(fiber);

      expect(error).toBeInstanceOf(NpmRegistryRejected);
      expect(error.message).toContain("HTTP 403");
    }).pipe(Effect.provide(registry.layer));
  });
});
