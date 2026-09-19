import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Path, Stream } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import { CommandPlatformApiFactory } from "../auth/command-platform-api-factory.service.ts";
import { dbConnectionLayer } from "./db-connection.layer.ts";
import { stackCatalogSetupLayer } from "./stack-catalog-setup.ts";
import {
  classifyStorageCapability,
  describeStorageCapability,
  stackStorageEndpointFor,
} from "./stack-storage.ts";
import { makeStorageGateway } from "./storage-gateway.ts";
import {
  StackApi,
  stackApiLayer,
  stackTargetResolverLayer,
} from "../commands/experimental/stack/stack.shared.ts";
import {
  mockCommandSettings,
  mockTelemetryStateTracked,
} from "../../tests/helpers/command-mocks.ts";
import { mockOutput, mockTty } from "../../tests/helpers/mocks.ts";
import { CliArgs } from "../shared/cli/cli-args.service.ts";
import { stdinLayer } from "../shared/runtime/stdin.layer.ts";
import { runtimeInfoLayer } from "../shared/runtime/runtime-info.layer.ts";
import { ExperimentalFlag, YesFlag } from "./global-flags.ts";
import { stackStart } from "../commands/experimental/stack/start/start.handler.ts";

const projectConfig = `
project_id = "stack-storage-native-integration"

[api]
enabled = true

[auth]
enabled = false

[realtime]
enabled = false

[storage]
enabled = true

[edge_runtime]
enabled = false

[studio]
enabled = false

[analytics]
enabled = false

[db.pooler]
enabled = false

[local_smtp]
enabled = false
`;

const startFlags = () => ({
  exclude: [],
  stack: Option.none<string>(),
  stackId: Option.none<string>(),
  runtime: "native" as const,
  preparation: "on-demand" as const,
  eager: false,
});

const makeLayers = (root: string) => {
  const settings = mockCommandSettings({ workdir: root, supabaseHome: root });
  const liveStackApi = stackApiLayer.pipe(Layer.provide(BunServices.layer));
  const resolver = stackTargetResolverLayer.pipe(
    Layer.provide(Layer.mergeAll(BunServices.layer, settings, liveStackApi)),
  );
  const output = mockOutput();
  const telemetry = mockTelemetryStateTracked();
  const tty = mockTty({ stdinIsTty: false, stdoutIsTty: false });
  return Layer.mergeAll(
    BunServices.layer,
    FetchHttpClient.layer,
    runtimeInfoLayer,
    settings,
    liveStackApi,
    resolver,
    output.layer,
    telemetry.layer,
    stackCatalogSetupLayer,
    dbConnectionLayer,
    Layer.succeed(ExperimentalFlag, false),
    Layer.succeed(YesFlag, false),
    Layer.succeed(CliArgs, { args: ["stack", "start"] }),
    Layer.succeed(CommandPlatformApiFactory, { make: Effect.die("unused") }),
    stdinLayer.pipe(Layer.provide(tty)),
    tty,
  );
};

describe("native stack Storage gateway", () => {
  it.live(
    "serves lazy Storage without Auth through bucket and object lifecycle operations",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-storage-native-" });
        yield* fs.makeDirectory(path.join(root, "supabase"), { recursive: true });
        yield* fs.writeFileString(path.join(root, "supabase", "config.toml"), projectConfig);
        const layers = makeLayers(root);
        yield* Effect.ensuring(
          Effect.gen(function* () {
            const stackId = yield* stackStart(startFlags());
            const api = yield* StackApi;
            const stack = yield* api.open({
              id: stackId,
              stateRoot: path.join(root, "stacks"),
              cacheRoot: path.join(root, "cache"),
            });
            const composition = yield* stack.composition.describe;
            const members = yield* Effect.forEach(composition.members, (member) =>
              stack.services.get(member.id).pipe(Effect.map((instance) => ({ member, instance }))),
            );
            const storageMember = members.find(({ instance }) => instance.service === "storage");
            expect(storageMember?.member.activation).toBe("lazy");
            expect(members.some(({ instance }) => instance.service === "auth")).toBe(false);

            const credentials = yield* stackStorageEndpointFor(stack);
            const gateway = yield* makeStorageGateway({
              baseUrl: credentials.baseUrl,
              apiKey: credentials.apiKey,
              userAgent: "stack-storage-native-integration",
            });
            const bucket = `native-${crypto.randomUUID().slice(0, 8)}`;
            const local = path.join(root, "payload.txt");
            yield* fs.writeFileString(local, "native storage payload");

            yield* gateway.createBucket(bucket, {
              public: false,
              fileSizeLimit: 0,
              allowedMimeTypes: [],
            });
            expect((yield* gateway.listBuckets()).some(({ name }) => name === bucket)).toBe(true);

            yield* gateway.uploadObject(`${bucket}/source.txt`, local, {
              contentType: "text/plain",
              cacheControl: "max-age=60",
              overwrite: false,
            });
            expect((yield* gateway.listObjects(bucket, "", 0)).map(({ name }) => name)).toContain(
              "source.txt",
            );
            const downloaded = yield* gateway
              .downloadObject(`${bucket}/source.txt`)
              .pipe(Stream.runCollect);
            expect(
              new TextDecoder().decode(Uint8Array.from(downloaded.flatMap((chunk) => [...chunk]))),
            ).toBe("native storage payload");

            yield* gateway.moveObject(bucket, "source.txt", "moved.txt");
            expect((yield* gateway.listObjects(bucket, "", 0)).map(({ name }) => name)).toContain(
              "moved.txt",
            );
            yield* gateway.deleteObjects(bucket, ["moved.txt"]);
            expect(yield* gateway.listObjects(bucket, "", 0)).toEqual([]);
            yield* gateway.deleteBucket(bucket);

            if (storageMember === undefined) return yield* Effect.die("Storage member missing");
            yield* stack.composition.stop;
            const stopped = yield* storageMember.instance.status;
            expect(stopped.lifecycle).toBe("stopped");
            expect(classifyStorageCapability(stopped)).toBe("unusable");
            expect(describeStorageCapability(stopped)).toBe("Storage is stopped for this stack.");
          }),
          Effect.gen(function* () {
            const api = yield* StackApi;
            const stateRoot = path.join(root, "stacks");
            const registered = yield* api.discover({ stateRoot });
            yield* Effect.forEach(registered, ({ definition }) =>
              api
                .open({
                  id: definition.id,
                  stateRoot,
                  cacheRoot: path.join(root, "cache"),
                })
                .pipe(Effect.flatMap((stack) => stack.destroy)),
            );
          }).pipe(Effect.catch((cause) => Effect.die(cause))),
        ).pipe(Effect.provide(layers));
      }).pipe(Effect.provide(BunServices.layer)),
    { timeout: 180_000 },
  );
});
