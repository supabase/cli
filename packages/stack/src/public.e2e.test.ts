import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { expect, expectTypeOf, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { HttpClient } from "effect/unstable/http";
import { tmpdir } from "node:os";
import { open, postgres } from "./effect.ts";
import * as PromiseStack from "./index.ts";

it.live(
  "keeps a service alive after its Promise client exits and reconnects through Effect",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-public-e2e-" });
      const cacheRoot = `${tmpdir()}/supabase-stack-artifacts`;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        ChildProcess.make(
          process.execPath,
          [new URL("../tests/public-client-fixture.ts", import.meta.url).pathname, root, cacheRoot],
          { stdin: "ignore" },
        ),
      );
      const [stdout, stderr, code] = yield* Effect.all(
        [
          child.stdout.pipe(
            Stream.decodeText(),
            Stream.runFold(
              () => "",
              (text, chunk) => text + chunk,
            ),
          ),
          child.stderr.pipe(
            Stream.decodeText(),
            Stream.runFold(
              () => "",
              (text, chunk) => text + chunk,
            ),
          ),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      expect(Number(code), stderr).toBe(0);
      const identity = yield* Schema.decodeEffect(
        Schema.fromJsonString(Schema.Struct({ stackId: Schema.String, instanceId: Schema.String })),
      )(stdout.trim());
      const locations = {
        stateRoot: `${root}/state`,
        cacheRoot,
        id: identity.stackId,
      };
      const stack = yield* open(locations);
      yield* Effect.addFinalizer(() =>
        stack.destroy.pipe(
          Effect.catch((cause) => Effect.logError("E2E stack cleanup failed", cause)),
        ),
      );
      const mail = yield* stack.services.get(identity.instanceId);
      expect((yield* mail.status).lifecycle).toBe("running");
      const credentials = yield* mail.credentials();
      expect(credentials.url).toBeDefined();
      const http = yield* HttpClient.HttpClient;
      const response = yield* http.get(`${credentials.url}/api/v1/messages`);
      expect(response.status).toBe(200);
      yield* mail.stop;
      expect((yield* mail.status).lifecycle).toBe("stopped");
      yield* mail.start;
      yield* mail.ready;
      expect((yield* mail.credentials()).url).toBe(credentials.url);

      const stdoutChunks: Array<Uint8Array> = [];
      const tool = yield* stack.tools.run(postgres.psql({ major: 17 }), {
        args: ["--version"],
        stdout: (bytes) =>
          Effect.sync(() => {
            stdoutChunks.push(bytes);
          }),
        stderr: () => Effect.void,
      });
      expect(tool.exitCode).toBe(0);
      expect(stdoutChunks.map((bytes) => new TextDecoder().decode(bytes)).join("")).toContain(
        "psql (PostgreSQL) 17",
      );
      const promiseClient = yield* Effect.tryPromise(() => PromiseStack.open(locations));
      yield* Effect.acquireUseRelease(
        Effect.succeed(promiseClient),
        (client) =>
          Effect.gen(function* () {
            const status = yield* Effect.tryPromise(() =>
              client.services.get(mail.id).then((service) => service.status()),
            );
            expect(status.lifecycle).toBe("running");
            const database = yield* Effect.tryPromise(() =>
              client.services.create({
                service: "database",
                config: {
                  version: "17",
                  databasePassword: "plain-secret",
                  jwtSecret: "plain-jwt-secret",
                  jwtExpiry: 3600,
                },
                endpoints: { sql: { port: "auto" } },
              }),
            );
            expectTypeOf(database).toEqualTypeOf<PromiseStack.DatabaseInstance>();
            yield* Effect.tryPromise(() =>
              database.restart({
                config: {
                  version: "17",
                  databasePassword: "replacement-secret",
                  jwtSecret: "replacement-jwt",
                  jwtExpiry: 3600,
                },
              }),
            );
            yield* Effect.tryPromise(() => database.ready());
            const urls = yield* Effect.tryPromise(() => database.credentials({ from: "runtime" }));
            const databaseUrl = urls.databaseUrl;
            if (databaseUrl === undefined) return yield* Effect.die("Database URL missing");
            const sqlOutput: Array<Uint8Array> = [];
            const sql = yield* Effect.tryPromise(() =>
              client.tools.run(postgres.psql({ major: 17 }), {
                args: ["--dbname", databaseUrl, "-At"],
                stdin: Stream.toAsyncIterable(
                  Stream.make(new TextEncoder().encode("SELECT 42;\n")),
                ),
                stdout: (bytes) => {
                  sqlOutput.push(bytes);
                },
                stderr: () => {},
              }),
            );
            expect(sql.exitCode).toBe(0);
            expect(
              sqlOutput
                .map((bytes) => new TextDecoder().decode(bytes))
                .join("")
                .trim(),
            ).toBe("42");
            const sourceCredentials = yield* Effect.tryPromise(() =>
              database.credentials({ from: "runtime" }),
            );
            if (sourceCredentials.databaseUrl === undefined)
              return yield* Effect.die("Snapshot source URL missing");
            const sourceUrl = sourceCredentials.databaseUrl;
            const seed = yield* Effect.tryPromise(() =>
              client.tools.run(postgres.psql({ major: 17 }), {
                args: [
                  "--dbname",
                  sourceUrl,
                  "-c",
                  "CREATE TABLE snapshot_rows (value text NOT NULL); INSERT INTO snapshot_rows VALUES ('roundtrip');",
                ],
                stdout: () => {},
                stderr: () => {},
              }),
            );
            expect(seed.exitCode).toBe(0);
            yield* Effect.tryPromise(() => database.stop());
            const archive = path.join(root, "public-snapshot.tar");
            yield* Effect.tryPromise(() => database.exportSnapshot(archive));
            const restored = yield* Effect.tryPromise(() =>
              client.services.create({
                service: "database",
                config: {
                  version: "17",
                  databasePassword: "restored-secret",
                  jwtSecret: "restored-jwt-secret",
                  jwtExpiry: 3600,
                },
                endpoints: { sql: { port: "auto" } },
              }),
            );
            yield* Effect.tryPromise(() => restored.restoreSnapshot(archive));
            yield* Effect.tryPromise(() => restored.start());
            yield* Effect.tryPromise(() => restored.ready());
            const restoredCredentials = yield* Effect.tryPromise(() =>
              restored.credentials({ from: "runtime" }),
            );
            if (restoredCredentials.databaseUrl === undefined)
              return yield* Effect.die("Restored snapshot URL missing");
            const restoredUrl = restoredCredentials.databaseUrl;
            const restoredOutput: Array<Uint8Array> = [];
            const restoredQuery = yield* Effect.tryPromise(() =>
              client.tools.run(postgres.psql({ major: 17 }), {
                args: ["--dbname", restoredUrl, "-Atc", "SELECT value FROM snapshot_rows"],
                stdout: (bytes) => {
                  restoredOutput.push(bytes);
                },
                stderr: () => {},
              }),
            );
            expect(restoredQuery.exitCode).toBe(0);
            expect(
              restoredOutput
                .map((bytes) => new TextDecoder().decode(bytes))
                .join("")
                .trim(),
            ).toBe("roundtrip");
            expect((yield* stack.services.list).map((service) => service.id)).toContain(
              database.id,
            );
            const selected = yield* Effect.tryPromise(() =>
              client.composition.supabase([
                { service: "mail", config: {}, endpoints: { http: { port: "auto" } } },
              ]),
            );
            const selectedMail = selected[0];
            if (selectedMail === undefined) return yield* Effect.die("Composition member missing");
            yield* Effect.tryPromise(() => client.composition.start());
            expect((yield* Effect.tryPromise(() => selectedMail.status())).wakeEnabled).toBe(true);
            const selectedUrl = yield* Effect.tryPromise(() => selectedMail.credentials());
            expect((yield* http.get(`${selectedUrl.url}/api/v1/messages`)).status).toBe(200);
            yield* Effect.tryPromise(() => client.composition.stop());
            expect((yield* Effect.tryPromise(() => selectedMail.status())).lifecycle).toBe(
              "stopped",
            );
            expect((yield* mail.status).lifecycle).toBe("running");
          }),
        (client) => Effect.promise(() => client.close()),
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp)),
    ),
  { timeout: 180_000 },
);

it.live(
  "closes Promise observation iterators while leaving the owner usable",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-public-observation-" });
      const cacheRoot = `${tmpdir()}/supabase-stack-artifacts`;
      const locations = { stateRoot: `${root}/state`, cacheRoot };
      const stack = yield* Effect.tryPromise(() =>
        PromiseStack.create({ ...locations, projectRoot: root, runtime: "native" }),
      );
      const owner = yield* open({ ...locations, id: stack.id });
      yield* Effect.addFinalizer(() =>
        owner.destroy.pipe(Effect.catch((cause) => Effect.logError("Stack destroy failed", cause))),
      );
      yield* Effect.addFinalizer(() =>
        Effect.tryPromise(() => stack.close()).pipe(
          Effect.catch((cause) => Effect.logError("Promise stack close failed", cause)),
        ),
      );
      const mail = yield* Effect.tryPromise(() =>
        stack.services.create({
          service: "mail",
          config: {},
          endpoints: { http: { port: "auto" }, smtp: { port: "auto" }, pop3: { port: "auto" } },
        }),
      );
      yield* Effect.tryPromise(() => mail.start());
      yield* Effect.tryPromise(() => mail.ready());
      const attached = yield* Effect.tryPromise(() => stack.services.get(mail.id));
      const observations = attached.followStatus()[Symbol.asyncIterator]();
      const firstObservation = yield* Effect.tryPromise(() => observations.next());
      expect(firstObservation.done).toBe(false);
      const pendingObservation = observations.next();
      yield* Effect.tryPromise(() => stack.close());
      expect((yield* Effect.tryPromise(() => pendingObservation)).done).toBe(true);
      expect(() => attached.followStatus()[Symbol.asyncIterator]()).toThrow();
      const reopened = yield* Effect.tryPromise(() =>
        PromiseStack.open({ ...locations, id: stack.id }),
      );
      yield* Effect.acquireUseRelease(
        Effect.succeed(reopened),
        (client) =>
          Effect.tryPromise(() => client.services.get(mail.id)).pipe(
            Effect.flatMap((reopenedMail) =>
              Effect.tryPromise(() => reopenedMail.status()).pipe(
                Effect.map((status) => expect(status.lifecycle).toBe("running")),
              ),
            ),
          ),
        (client) => Effect.tryPromise(() => client.close()),
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp)),
    ),
  { timeout: 60_000 },
);
