import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { StackError } from "@supabase/stack/effect";
import { Deferred, Effect, Fiber, FileSystem, Layer, Option, Path, Schema, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import {
  mockCommandSettings,
  mockTelemetryStateTracked,
} from "../../../../../tests/helpers/command-mocks.ts";
import { StackApi, stackApiLayer, stackTargetResolverLayer } from "../stack.shared.ts";
import { stackRestart } from "./restart.handler.ts";
import { destroyTestStack } from "../../../../../tests/helpers/stack-cleanup.ts";
import { stackArtifactCacheRoot } from "../../../../../tests/helpers/stack-artifacts.ts";

const live = Layer.provideMerge(
  stackApiLayer,
  Layer.merge(BunServices.layer, FetchHttpClient.layer),
);
const MailpitInfo = Schema.Struct({ RuntimeStats: Schema.Struct({ SMTPAccepted: Schema.Finite }) });

// Mailpit counts accepted messages per process, so the count restarts from zero after a relaunch.
const mailpit = Effect.fn("StackRestartTest.mailpit")(function* (port: number) {
  const http = yield* HttpClient.HttpClient;
  const origin = `http://127.0.0.1:${port}`;
  return {
    send: http
      .execute(
        HttpClientRequest.post(`${origin}/api/v1/send`).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            From: { Email: "from@example.com" },
            To: [{ Email: "to@example.com" }],
            Subject: "restart",
            Text: "restart",
          }),
        ),
      )
      .pipe(Effect.flatMap((response) => response.text)),
    accepted: http.get(`${origin}/api/v1/info`).pipe(
      Effect.flatMap((response) => response.json),
      Effect.flatMap(Schema.decodeUnknownEffect(MailpitInfo)),
      Effect.map((info) => info.RuntimeStats.SMTPAccepted),
    ),
  };
});
const fixture = Effect.fn("StackRestartTest.fixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-restart-" });
  const api = yield* StackApi;
  const locations = {
    stateRoot: path.join(root, "stacks"),
    cacheRoot: stackArtifactCacheRoot,
  };
  const stack = yield* api.create({ ...locations, projectRoot: root, runtime: "native" });
  const output = mockOutput();
  const telemetry = mockTelemetryStateTracked();
  const settings = mockCommandSettings({ workdir: root, supabaseHome: root });
  const layer = Layer.mergeAll(
    output.layer,
    telemetry.layer,
    settings,
    stackTargetResolverLayer.pipe(Layer.provide(settings)),
  );
  return {
    api,
    locations,
    stack,
    output,
    telemetry,
    layer,
    flags: { stack: Option.none<string>(), stackId: Option.some(stack.id) },
  };
});

describe("stack restart", () => {
  it.live(
    "restarts saved members while leaving a running standalone service untouched",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* Effect.acquireUseRelease(
          Effect.succeed(f.stack),
          (stack) =>
            Effect.gen(function* () {
              const member = yield* stack.services.create({
                service: "mail",
                config: {},
                endpoints: { http: { port: "auto" } },
              });
              const standalone = yield* stack.services.create({
                service: "mail",
                config: {},
                endpoints: { http: { port: "auto" } },
              });
              yield* stack.composition.configure({
                members: [{ id: member.id, activation: "eager" }],
                dependencies: [],
              });
              yield* stack.composition.start;
              yield* standalone.start;
              yield* standalone.ready;
              const before = yield* member.status;
              const standaloneHttpPort = (yield* standalone.status).endpoints.find(
                ({ name }) => name === "http",
              )?.port;
              if (standaloneHttpPort === undefined) return yield* Effect.die("Mail port missing");
              const standaloneMail = yield* mailpit(standaloneHttpPort);
              yield* standaloneMail.send;
              expect(yield* standaloneMail.accepted).toBe(1);

              // Both follows are subscribed once their first status arrives, before the restart.
              const memberFollowing = yield* Deferred.make<void>();
              const relaunched = yield* member.followStatus.pipe(
                Stream.tap(() => Deferred.succeed(memberFollowing, undefined)),
                Stream.dropWhile((value) => value.lifecycle === "running"),
                Stream.filter(
                  (value) => value.lifecycle === "running" && value.health === "healthy",
                ),
                Stream.take(1),
                Stream.runDrain,
                Effect.forkScoped,
              );
              yield* Deferred.await(memberFollowing);

              const result = yield* stackRestart(f.flags).pipe(Effect.provide(f.layer));
              yield* Fiber.join(relaunched);
              const after = yield* member.status;
              const standaloneAfter = yield* standalone.status;
              expect(result.map(({ id }) => id)).toEqual([member.id]);
              expect(after.lifecycle).toBe("running");
              expect(after.health).toBe("healthy");
              expect(after.endpoints).toEqual(before.endpoints);
              expect(standaloneAfter.lifecycle).toBe("running");
              expect(yield* standaloneMail.accepted).toBe(1);
              expect(f.output.stdoutText).toContain("using its saved configuration");
              expect(f.telemetry.flushed).toBe(true);
              yield* stack.stop;
              const reopened = yield* stackRestart(f.flags).pipe(Effect.provide(f.layer));
              expect(reopened.map(({ id }) => id)).toEqual([member.id]);
              const resumed = yield* member.status;
              expect(resumed.endpoints).toEqual(before.endpoints);
              expect(resumed.lifecycle).toBe("running");
              expect(resumed.health).toBe("healthy");
              expect((yield* standalone.status).lifecycle).toBe("stopped");
            }),
          destroyTestStack,
        );
      }).pipe(Effect.provide(live)),
    60_000,
  );

  it.live("rejects an unconfigured namespace without starting an owner", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const error = yield* stackRestart(f.flags).pipe(Effect.provide(f.layer), Effect.flip);
      expect(error.reason).toBe("lifecycle");
      expect((yield* f.api.discover(f.locations))[0]?.host).toBeUndefined();
      expect(f.telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(live)),
  );

  it.live("identifies failed members when a composition restart fails", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const failure = new StackError({
        operation: "composition.restart",
        message: "Some services failed to restart",
        outcomes: [
          { id: "database-instance", succeeded: true },
          { id: "rest-instance", succeeded: false, error: "Port is occupied" },
        ],
      });
      const api = Layer.succeed(
        StackApi,
        StackApi.of({
          ...f.api,
          open: () =>
            Effect.succeed({
              ...f.stack,
              composition: {
                ...f.stack.composition,
                describe: Effect.succeed({
                  members: [{ id: "rest-instance", activation: "lazy" }],
                  dependencies: [],
                }),
                restart: Effect.fail(failure),
              },
            }),
        }),
      );
      const error = yield* stackRestart(f.flags).pipe(
        Effect.provide(Layer.provideMerge(f.layer, api)),
        Effect.flip,
      );
      expect(error.message).toBe("Some services failed to restart");
      expect(error.detail).toBe("rest-instance: Port is occupied");
      expect(f.telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(live)),
  );
});
