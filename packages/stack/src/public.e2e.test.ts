import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { expect, expectTypeOf, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Redacted, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { HttpClient } from "effect/unstable/http";
import { tmpdir } from "node:os";
import { open, postgres } from "./effect.ts";
import * as PromiseStack from "./index.ts";
import { assertOwnerExited, captureOwnerPid } from "../tests/owner.ts";

for (const runtime of ["node", "bun"] as const) {
  it.live(
    `${runtime}: Promise stop and destroy confirm the launching client's owner has exited`,
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: `stack-owner-${runtime}-` });
        const child = yield* ChildProcess.make(
          runtime === "bun" ? process.execPath : "node",
          [
            new URL("../tests/owner-exit-client.ts", import.meta.url).pathname,
            root,
            `${tmpdir()}/supabase-stack-artifacts`,
          ],
          { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
        );
        const [stdout, stderr, code] = yield* Effect.all(
          [
            child.stdout.pipe(Stream.decodeText, Stream.mkString),
            child.stderr.pipe(Stream.decodeText, Stream.mkString),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        expect(Number(code), stderr).toBe(0);
        expect(stdout).toContain("owner-exit-confirmed");
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp)),
      ),
    { timeout: 120_000 },
  );
}

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
        Effect.gen(function* () {
          const pid = yield* captureOwnerPid(locations, stack.id);
          yield* stack.destroy;
          yield* assertOwnerExited(pid);
        }).pipe(Effect.catchCause(Effect.die)),
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
      const database = yield* stack.services.create({
        service: "database",
        config: {
          version: "17",
          databasePassword: Redacted.make("public-pgprove-password"),
          jwtSecret: Redacted.make("public-pgprove-jwt-secret"),
          jwtExpiry: 3600,
        },
        endpoints: { sql: { port: "auto" } },
      });
      yield* database.start;
      yield* database.ready;
      const databaseCredentials = yield* database.credentials();
      const databaseUrl = databaseCredentials.databaseUrl;
      if (databaseUrl === undefined) return yield* Effect.die("Public pgProve URL missing");
      const pgProveRoot = path.join(root, "public-pgprove-tests");
      yield* fs.makeDirectory(pgProveRoot, { recursive: true });
      yield* fs.writeFileString(path.join(pgProveRoot, "main.sql"), "\\ir included.sql\n");
      yield* fs.writeFileString(path.join(pgProveRoot, "included.sql"), "\\i nested.sql\n");
      yield* fs.writeFileString(
        path.join(pgProveRoot, "nested.sql"),
        "SELECT plan(1);\nSELECT pass('public pgProve');\nSELECT * FROM finish();\n",
      );
      const extension = yield* stack.tools.run(postgres.psql({ major: 17 }), {
        args: ["--dbname", databaseUrl, "-c", "CREATE EXTENSION IF NOT EXISTS pgtap"],
        stdout: () => Effect.void,
        stderr: () => Effect.void,
      });
      expect(extension.exitCode).toBe(0);
      const pgProveOutput: Array<Uint8Array> = [];
      const pgProve = yield* stack.tools.run(postgres.pgProve({ major: 17 }), {
        args: ["--dbname", databaseUrl, "--ext", ".sql", "main.sql", "--verbose"],
        pgProve: {
          mounts: [{ source: pgProveRoot, target: "/tests" }],
          cwd: pgProveRoot,
          workingDir: undefined,
        },
        stdout: (bytes) => Effect.sync(() => pgProveOutput.push(bytes)),
        stderr: () => Effect.void,
      });
      expect(pgProve.exitCode).toBe(0);
      expect(pgProveOutput.map((bytes) => new TextDecoder().decode(bytes)).join("")).toContain(
        "public pgProve",
      );
      expect(yield* fs.readFileString(path.join(pgProveRoot, "nested.sql"))).toContain(
        "public pgProve",
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
            const promiseExtension = yield* Effect.tryPromise(() =>
              client.tools.run(postgres.psql({ major: 17 }), {
                args: ["--dbname", databaseUrl, "-c", "CREATE EXTENSION IF NOT EXISTS pgtap"],
                stdout: () => {},
                stderr: () => {},
              }),
            );
            expect(promiseExtension.exitCode).toBe(0);
            const promiseProveOutput: Array<Uint8Array> = [];
            const promiseProveError: Array<Uint8Array> = [];
            const promiseProve = yield* Effect.tryPromise(() =>
              client.tools.run(postgres.pgProve({ major: 17 }), {
                args: ["--dbname", databaseUrl, "--ext", ".sql", "main.sql", "--verbose"],
                pgProve: {
                  mounts: [{ source: pgProveRoot, target: "/tests" }],
                  cwd: pgProveRoot,
                  workingDir: undefined,
                },
                stdout: (bytes) => {
                  promiseProveOutput.push(bytes);
                },
                stderr: (bytes) => {
                  promiseProveError.push(bytes);
                },
              }),
            );
            expect(
              promiseProve.exitCode,
              promiseProveError.map((bytes) => new TextDecoder().decode(bytes)).join(""),
            ).toBe(0);
            expect(
              promiseProveOutput.map((bytes) => new TextDecoder().decode(bytes)).join(""),
            ).toContain("public pgProve");
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
            const reused = yield* Effect.tryPromise(() =>
              client.composition.supabase(
                [{ service: "mail", config: {}, endpoints: { http: { port: "auto" } } }],
                { reuseIds: [selectedMail.id] },
              ),
            );
            expect(reused[0]?.id).toBe(selectedMail.id);
            yield* Effect.tryPromise(() => client.composition.start());
            expect((yield* Effect.tryPromise(() => selectedMail.status())).wakeEnabled).toBe(true);
            expect((yield* http.get(`${selectedUrl.url}/api/v1/messages`)).status).toBe(200);
            expect((yield* Effect.tryPromise(() => selectedMail.status())).lifecycle).toBe(
              "running",
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
        Effect.gen(function* () {
          const pid = yield* captureOwnerPid(locations, owner.id);
          yield* owner.destroy;
          yield* assertOwnerExited(pid);
        }).pipe(Effect.catchCause(Effect.die)),
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
