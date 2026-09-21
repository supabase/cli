import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import {
  Cause,
  Crypto,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Redacted,
  Ref,
  Stream,
} from "effect";
import { postgres } from "../../src/Tools.ts";
import { homedir, tmpdir } from "node:os";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { bundleServeMainTemplate } from "../serve-main-bundler.ts";
import { create, type Stack } from "../../src/effect.ts";
import type { Observation } from "../../src/Rpc.ts";
import { vectorAnalyticsConfig } from "./analytics.ts";
import { cleanupDockerRoot } from "../docker-cleanup.ts";

type AnyService = Effect.Success<Stack["services"]["list"]>[number];

export const serviceNames = [
  "database",
  "rest",
  "auth",
  "realtime",
  "storage",
  "imgproxy",
  "functions",
  "studio",
  "pgmeta",
  "mail",
  "analytics",
  "vector",
  "pooler",
] as const;

export type Runtime = "native" | "docker";
export type WholeStack = Readonly<{
  readonly stack: Stack;
  readonly services: ReadonlyArray<AnyService>;
  readonly root: string;
  readonly locations: {
    readonly stateRoot: string;
    readonly cacheRoot: string;
  };
  readonly secret: string;
  readonly owner: Ref.Ref<Option.Option<Stack>>;
  readonly logTails: Ref.Ref<ReadonlyArray<readonly [string, string]>>;
}>;

const watchServiceLogs = Effect.fn("WholeStack.watchServiceLogs")(
  (
    services: ReadonlyArray<AnyService>,
    logTails: Ref.Ref<ReadonlyArray<readonly [string, string]>>,
  ) =>
    Effect.forEach(
      services,
      (instance) =>
        Effect.forkScoped(
          instance.logs.pipe(
            Stream.runForEach(({ bytes }) =>
              Ref.update(logTails, (tails) => {
                const text = new TextDecoder().decode(bytes);
                const existing = tails.find(([name]) => name === instance.service)?.[1] ?? "";
                const updated = `${existing}${text}`.slice(-8192);
                const without = tails.filter(([name]) => name !== instance.service);
                return [...without, [instance.service, updated] as const];
              }),
            ),
            Effect.ignoreCause,
          ),
        ),
      { discard: true },
    ),
);

const endpoint = (port: "auto") => ({ port });

export const wholeStack = Effect.fn("WholeStack.fixture")((runtime: Runtime) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({
      prefix: `stack-whole-${runtime}-`,
      ...(runtime === "native" && process.platform === "linux" ? { directory: homedir() } : {}),
    });
    const functionsRoot = `${root}/functions`;
    const storageRoot = `${root}/storage`;
    const vectorConfigPath = `${root}/vector.yaml`;
    yield* fs.makeDirectory(`${functionsRoot}/hello`, { recursive: true });
    yield* fs.makeDirectory(storageRoot, { recursive: true });
    yield* fs.writeFileString(
      `${functionsRoot}/hello/index.ts`,
      "Deno.serve(async (request) => { const authorization = request.headers.get('authorization') ?? ''; const input = await request.json(); const response = await fetch(`${Deno.env.get('SUPABASE_URL')}/rest/v1/whole_stack_items?id=eq.${input.id}`, { headers: { authorization, apikey: authorization.replace('Bearer ', '') } }); return new Response(await response.text(), { status: response.status, headers: { 'content-type': 'application/json' } }); });",
    );
    const bootstrap = yield* bundleServeMainTemplate;
    const crypto = yield* Crypto.Crypto;
    const secret = `whole-stack-${yield* crypto.randomUUIDv4}-secret`;
    const locations = {
      stateRoot: `${root}/state`,
      cacheRoot: `${tmpdir()}/supabase-stack-artifacts`,
    };
    const stack = yield* create({
      projectRoot: root,
      ...locations,
      runtime,
      name: `whole-${runtime}`,
    });
    yield* fs.writeFileString(vectorConfigPath, vectorAnalyticsConfig(`vector-${stack.id}`));
    const owner = yield* Ref.make<Option.Option<Stack>>(Option.some(stack));
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const current = yield* Ref.get(owner);
        const destroy = Option.isSome(current)
          ? current.value.destroy.pipe(Effect.catchCause(Effect.die))
          : Effect.void;
        yield* runtime === "docker"
          ? destroy.pipe(Effect.ensuring(cleanupDockerRoot(storageRoot)))
          : destroy;
      }),
    );
    const created = yield* stack.composition.supabase([
      {
        service: "database",
        config: {
          version: "17",
          databasePassword: Redacted.make("postgres"),
          jwtSecret: Redacted.make(secret),
          jwtExpiry: 3600,
        },
        endpoints: { sql: endpoint("auto") },
      },
      {
        service: "rest",
        config: { databaseUrl: "postgresql://placeholder", jwtSecret: secret },
        endpoints: { http: endpoint("auto") },
      },
      {
        service: "auth",
        config: { databaseUrl: "postgresql://placeholder", jwtSecret: secret },
        endpoints: { http: endpoint("auto") },
      },
      {
        service: "realtime",
        config: { databaseUrl: "postgresql://placeholder", jwtSecret: secret },
        endpoints: { http: endpoint("auto"), rpc: endpoint("auto") },
      },
      {
        service: "storage",
        config: {
          databaseUrl: "postgresql://placeholder",
          filePath: storageRoot,
          jwtSecret: secret,
        },
        endpoints: { http: endpoint("auto") },
      },
      {
        service: "imgproxy",
        config: { filePath: storageRoot },
        endpoints: { http: endpoint("auto") },
      },
      {
        service: "functions",
        config: { functionsRoot, bootstrap, verifyJwt: true, jwtSecret: secret },
        endpoints: { http: endpoint("auto") },
      },
      { service: "studio", config: { jwtSecret: secret }, endpoints: { http: endpoint("auto") } },
      {
        service: "pgmeta",
        config: { databaseUrl: "postgresql://placeholder" },
        endpoints: { http: endpoint("auto") },
      },
      {
        service: "mail",
        config: {},
        endpoints: { http: endpoint("auto"), smtp: endpoint("auto"), pop3: endpoint("auto") },
      },
      {
        service: "analytics",
        config: { databaseUrl: "postgresql://placeholder", backend: "postgres", apiKey: secret },
        endpoints: { http: endpoint("auto") },
      },
      {
        service: "vector",
        config: {
          analyticsUrl: "http://placeholder",
          apiKey: secret,
          configPath: vectorConfigPath,
        },
        endpoints: { http: endpoint("auto") },
      },
      {
        service: "pooler",
        config: {
          databaseUrl: "postgresql://placeholder",
          jwtSecret: secret,
          tenant: "whole",
          poolMode: "transaction",
        },
        endpoints: { http: endpoint("auto"), sql: endpoint("auto") },
      },
    ]);
    const logTails = yield* Ref.make<ReadonlyArray<readonly [string, string]>>([]);
    yield* watchServiceLogs(created, logTails);
    yield* Effect.addFinalizer((exit) =>
      Exit.isFailure(exit)
        ? Effect.gen(function* () {
            const current = yield* Ref.get(owner);
            const observed = Option.isSome(current)
              ? yield* current.value.services.list.pipe(Effect.orElseSucceed(() => created))
              : created;
            const statuses = yield* Effect.forEach(observed, (instance) =>
              instance.status.pipe(
                Effect.map((status) => `${instance.service}=${status.lifecycle}`),
                Effect.catchCause(() => Effect.succeed(`${instance.service}=unknown`)),
              ),
            );
            const tails = yield* Ref.get(logTails);
            yield* Effect.logError(
              `Whole-stack failure diagnostics: cause=${Cause.pretty(exit.cause)} statuses=${statuses.join(",")} logs=${tails.map(([name, value]) => `${name}: ${value}`).join("\n")}`,
            );
          }).pipe(Effect.ignoreCause)
        : Effect.void,
    );
    return {
      stack,
      services: created,
      root,
      locations,
      secret,
      owner,
      logTails,
    } satisfies WholeStack;
  }),
);

export const refreshLogTails = Effect.fn("WholeStack.refreshLogTails")((fixture: WholeStack) =>
  watchServiceLogs(fixture.services, fixture.logTails),
);

export const setStackOwner = Effect.fn("WholeStack.setStackOwner")(
  (fixture: WholeStack, stack: Stack) => Ref.set(fixture.owner, Option.some(stack)),
);

export const clearStackOwner = Effect.fn("WholeStack.clearStackOwner")((fixture: WholeStack) =>
  Ref.set(fixture.owner, Option.none()),
);

export const service = (fixture: WholeStack, name: (typeof serviceNames)[number]): AnyService => {
  const found = fixture.services.find((candidate) => candidate.service === name);
  if (found === undefined) throw new Error(`Missing ${name} service`);
  return found;
};

export const allMembers = (stack: WholeStack["stack"]) =>
  Effect.gen(function* () {
    const configuration = yield* stack.composition.describe;
    return configuration.members;
  });

export const setActivation = Effect.fn("WholeStack.setActivation")(
  (stack: WholeStack["stack"], activation: "eager" | "lazy", idleMillis?: number) =>
    Effect.gen(function* () {
      const configuration = yield* stack.composition.describe;
      yield* stack.composition.configure({
        ...configuration,
        members: configuration.members.map((member) => ({
          id: member.id,
          activation,
          ...(idleMillis === undefined ? {} : { idleMillis }),
        })),
      });
    }),
);

export const statusByService = Effect.fn("WholeStack.statusByService")((fixture: WholeStack) =>
  Effect.forEach(serviceNames, (name) =>
    service(fixture, name).status.pipe(Effect.map((status) => [name, status] as const)),
  ).pipe(Effect.map((entries) => entries)),
);

export const requestWithHeaders = Effect.fn("WholeStack.requestWithHeaders")(
  (url: string, headers: Readonly<Record<string, string>>) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const request = Object.entries(headers).reduce(
        (current, [name, value]) => HttpClientRequest.setHeader(name, value)(current),
        HttpClientRequest.get(url),
      );
      const response = yield* client.execute(request);
      return { status: response.status, body: yield* response.text };
    }),
);

export const jsonRequest = Effect.fn("WholeStack.jsonRequest")(
  (
    method: "POST" | "PATCH",
    url: string,
    body: unknown,
    headers?: Readonly<Record<string, string>>,
  ) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const request = yield* HttpClientRequest.bodyJson(body)(
        method === "POST" ? HttpClientRequest.post(url) : HttpClientRequest.patch(url),
      );
      const response = yield* client.execute(
        Object.entries(headers ?? {}).reduce(
          (current, [name, value]) => HttpClientRequest.setHeader(name, value)(current),
          request,
        ),
      );
      return { status: response.status, body: yield* response.text };
    }),
);

export const sql = Effect.fn("WholeStack.sql")((fixture: WholeStack, statement: string) =>
  Effect.gen(function* () {
    const database = service(fixture, "database");
    const credentials = yield* database.credentials({ from: "runtime" });
    const databaseUrl = credentials.databaseUrl;
    if (databaseUrl === undefined) return yield* Effect.die("Database URL missing");
    const output: Array<Uint8Array> = [];
    const errors: Array<Uint8Array> = [];
    const result = yield* fixture.stack.tools.run(postgres.psql({ major: 17 }), {
      args: ["--set", "ON_ERROR_STOP=1", "--dbname", databaseUrl, "-At"],
      stdin: Stream.make(new TextEncoder().encode(`${statement}\n`)),
      stdout: (bytes) => Effect.sync(() => output.push(bytes)),
      stderr: (bytes) => Effect.sync(() => errors.push(bytes)),
    });
    if (result.exitCode !== 0)
      return yield* Effect.die(
        `SQL failed (${result.exitCode}): ${errors.map((bytes) => new TextDecoder().decode(bytes)).join("")}`,
      );
    return output
      .map((bytes) => new TextDecoder().decode(bytes))
      .join("")
      .trim();
  }),
);

export const waitForLifecycle = Effect.fn("WholeStack.waitForLifecycle")(
  (service: AnyService, lifecycle: Observation["lifecycle"]) =>
    service.followStatus.pipe(
      Stream.filter((status) => status.lifecycle === lifecycle),
      Stream.runHead,
      Effect.flatMap((status) =>
        Option.isSome(status) ? Effect.void : Effect.die("status stream ended"),
      ),
    ),
);

export const servicesLayer = Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp);
