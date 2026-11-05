import { expect, layer } from "@effect/vitest";
import { createClient, type RealtimeChannel } from "@supabase/supabase-js";
import { Data, Deferred, Effect, Layer, Option, Random, Schema, type Scope, Stream } from "effect";
import { FetchHttpClient, HttpClient, type HttpClientError } from "effect/http";
import * as Socket from "effect/socket/Socket";
import { ContractReset, ContractTarget, type ContractTargetError } from "./target.ts";

/** One consumer behavior, run unchanged against every setup's {@link ContractTarget}. */
interface ContractCase {
  readonly name: string;
  readonly run: Effect.Effect<
    void,
    ContractCallError | ContractTargetError | HttpClientError.HttpClientError | Schema.SchemaError,
    | ContractTarget
    | ContractReset
    | HttpClient.HttpClient
    | Socket.WebSocketConstructor
    | Scope.Scope
  >;
  readonly timeout?: number;
}

/** A supabase-js call rejected or returned an error. */
class ContractCallError extends Data.TaggedError("ContractCallError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

/** Runs one Promise-returning consumer call, passing the fiber's abort signal through. */
const call = <A>(operation: string, run: (signal: AbortSignal) => PromiseLike<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new ContractCallError({ message: `${operation} rejected`, cause }),
  });

const succeeded = <R extends { readonly error: unknown }>(
  result: R,
): result is Extract<R, { readonly error: null }> => result.error === null;

/** Runs one supabase-js call and fails with the `error` it returned. */
const sdk = <R extends { readonly data: unknown; readonly error: unknown }>(
  operation: string,
  run: (signal: AbortSignal) => PromiseLike<R>,
): Effect.Effect<Extract<R, { readonly error: null }>["data"], ContractCallError> =>
  Effect.flatMap(call(operation, run), (result) =>
    succeeded(result)
      ? Effect.succeed(result.data)
      : Effect.fail(new ContractCallError({ message: `${operation} failed`, cause: result.error })),
  );

const contractClient = (key: "PUBLISHABLE_KEY" | "ANON_KEY" | "SECRET_KEY") =>
  ContractTarget.useSync((target) =>
    createClient(target.API_URL, target[key], {
      auth: { persistSession: false, autoRefreshToken: false },
    }),
  );

const unique = (prefix: string) =>
  Effect.map(Random.nextIntBetween(0, 1_000_000_000), (suffix) => `${prefix}-${suffix}`);

const selectsSeededRow = (key: "PUBLISHABLE_KEY" | "ANON_KEY") =>
  Effect.gen(function* () {
    const client = yield* contractClient(key);
    const rows = yield* sdk("select contract_items", (signal) =>
      client.from("contract_items").select("id,label").eq("id", 1).abortSignal(signal),
    );
    expect(rows).toEqual([{ id: 1, label: "contract" }]);
  });

const insertsAndReadsBack = (key: "PUBLISHABLE_KEY" | "ANON_KEY") =>
  Effect.gen(function* () {
    const client = yield* contractClient(key);
    const id = yield* Random.nextIntBetween(2, 1_000_000_000);
    yield* sdk("insert contract_items", (signal) =>
      client.from("contract_items").insert({ id, label: "inserted" }).abortSignal(signal),
    );
    const rows = yield* sdk("select inserted row", (signal) =>
      client.from("contract_items").select("id,label").eq("id", id).abortSignal(signal),
    );
    expect(rows).toEqual([{ id, label: "inserted" }]);
  });

const postgrestCases: ReadonlyArray<ContractCase> = [
  { name: "PostgREST selects with the publishable key", run: selectsSeededRow("PUBLISHABLE_KEY") },
  { name: "PostgREST selects with the legacy anon key", run: selectsSeededRow("ANON_KEY") },
  {
    name: "PostgREST inserts with the publishable key and reads the row back",
    run: insertsAndReadsBack("PUBLISHABLE_KEY"),
  },
  {
    name: "PostgREST inserts with the legacy anon key and reads the row back",
    run: insertsAndReadsBack("ANON_KEY"),
  },
];

const password = "contract-password-123456";

const signUp = (email: string) =>
  Effect.flatMap(contractClient("ANON_KEY"), (client) =>
    sdk("sign up", () => client.auth.signUp({ email, password })),
  );

const signIn = (email: string) =>
  Effect.flatMap(contractClient("ANON_KEY"), (client) =>
    call("sign in", () => client.auth.signInWithPassword({ email, password })),
  );

const NewMail = Schema.Struct({
  Type: Schema.Literal("new"),
  Data: Schema.Struct({
    ID: Schema.String,
    To: Schema.Array(Schema.Struct({ Address: Schema.String })),
  }),
});
const MailBody = Schema.Struct({ Text: Schema.String, HTML: Schema.String });

const decodeEvent = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

const mailError = (message: string, cause?: unknown) =>
  new ContractCallError({ message: `Mailpit ${message}`, cause });

/** Signs `email` up while subscribed to Mailpit's events, then returns the link mailed to it. */
const signUpConfirmationLink = Effect.fn("Contract.signUpConfirmationLink")(function* (
  email: string,
) {
  const { MAILPIT_URL } = yield* ContractTarget;
  const events = new URL("/api/events", MAILPIT_URL);
  events.protocol = "ws:";
  const pull = yield* Socket.makeWebSocket(events.toString()).pipe(
    Effect.flatMap(Socket.readerString),
    Effect.mapError((cause) => mailError("events socket", cause)),
  );
  yield* signUp(email);
  const mail = yield* Stream.fromEffectRepeat(
    Effect.mapError(pull, (cause) => mailError("events socket", cause)),
  ).pipe(
    Stream.flattenIterable,
    Stream.mapEffect((frame) => decodeEvent(frame)),
    Stream.filter(Schema.is(NewMail)),
    Stream.filter(({ Data }) => Data.To.some(({ Address }) => Address === email)),
    Stream.runHead,
  );
  if (Option.isNone(mail)) return yield* mailError("event stream ended");
  const response = yield* HttpClient.get(`${MAILPIT_URL}/api/v1/message/${mail.value.Data.ID}`);
  const { Text, HTML } = yield* Schema.decodeUnknownEffect(MailBody)(yield* response.json);
  const link = `${Text}\n${HTML}`
    .replaceAll("&amp;", "&")
    .match(/https?:\/\/[^\s"'<>]+\/verify\?[^\s"'<>]+/);
  if (link === null) return yield* mailError("no verify link");
  return link[0];
});

const authCases: ReadonlyArray<ContractCase> = [
  {
    name: "Auth rejects password sign-in before the email is confirmed",
    run: Effect.gen(function* () {
      const email = `${yield* unique("unconfirmed")}@example.com`;
      expect((yield* signUp(email)).session).toBeNull();
      const { error } = yield* signIn(email);
      expect(error).toMatchObject({ code: "email_not_confirmed" });
    }),
  },
  {
    name: "Auth confirms a sign-up through the mailed link, then signs in",
    run: Effect.gen(function* () {
      const email = `${yield* unique("confirmed")}@example.com`;
      const verified = yield* HttpClient.get(yield* signUpConfirmationLink(email)).pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      );
      expect(verified.status).toBe(303);
      expect(verified.headers.location).toContain("access_token=");
      const { data, error } = yield* signIn(email);
      expect(error).toBeNull();
      expect(data.user?.email).toBe(email);
    }),
  },
];

const bytes = new Uint8Array([1, 2, 3, 250, 251, 252]);

const uploadedObject = Effect.gen(function* () {
  const client = yield* contractClient("SECRET_KEY");
  const name = yield* unique("contract");
  yield* sdk("create bucket", () => client.storage.createBucket(name, { public: false }));
  const bucket = client.storage.from(name);
  yield* sdk("upload", () =>
    bucket.upload("dir/a.bin", bytes, { contentType: "application/octet-stream" }),
  );
  return { bucket, name };
});

const downloadedBytes = ({ bucket }: Effect.Success<typeof uploadedObject>, objectPath: string) =>
  sdk(`download ${objectPath}`, (signal) => bucket.download(objectPath, {}, { signal })).pipe(
    Effect.flatMap((blob) => call("read download", () => blob.arrayBuffer())),
    Effect.map((buffer) => new Uint8Array(buffer)),
  );

const storageCases: ReadonlyArray<ContractCase> = [
  {
    name: "Storage downloads the bytes it uploaded",
    run: Effect.gen(function* () {
      const object = yield* uploadedObject;
      expect(yield* downloadedBytes(object, "dir/a.bin")).toEqual(bytes);
    }),
  },
  {
    name: "Storage lists an uploaded object",
    run: Effect.gen(function* () {
      const { bucket } = yield* uploadedObject;
      const objects = yield* sdk("list", (signal) => bucket.list("dir", undefined, { signal }));
      expect(objects.map(({ name }) => name)).toEqual(["a.bin"]);
    }),
  },
  {
    name: "Storage serves an object through a signed URL",
    run: Effect.gen(function* () {
      const { bucket } = yield* uploadedObject;
      const { signedUrl } = yield* sdk("create signed URL", () =>
        bucket.createSignedUrl("dir/a.bin", 60),
      );
      const response = yield* HttpClient.get(signedUrl);
      expect(response.status, signedUrl).toBe(200);
      expect(new Uint8Array(yield* response.arrayBuffer)).toEqual(bytes);
    }),
  },
  {
    name: "Storage accepts an anon upload through a signed upload URL",
    run: Effect.gen(function* () {
      const object = yield* uploadedObject;
      const { token } = yield* sdk("create signed upload URL", () =>
        object.bucket.createSignedUploadUrl("dir/b.bin"),
      );
      const anon = (yield* contractClient("ANON_KEY")).storage.from(object.name);
      yield* sdk("upload to signed URL", () => anon.uploadToSignedUrl("dir/b.bin", token, bytes));
      expect(yield* downloadedBytes(object, "dir/b.bin")).toEqual(bytes);
    }),
  },
];

/** A client whose channels and socket close with the scope. */
const realtimeClient = (key: "PUBLISHABLE_KEY" | "ANON_KEY") =>
  Effect.acquireRelease(contractClient(key), (client) =>
    call("remove channels", () => client.removeAllChannels()).pipe(Effect.orDie),
  );

const subscribed = (channel: RealtimeChannel) =>
  Effect.callback<void, ContractCallError>((resume) => {
    channel.subscribe((status, cause) =>
      resume(
        status === "SUBSCRIBED"
          ? Effect.void
          : Effect.fail(new ContractCallError({ message: `subscribe ${status}`, cause })),
      ),
    );
    return Effect.ignore(call("unsubscribe", () => channel.unsubscribe()));
  });

const deliversBroadcast = (key: "PUBLISHABLE_KEY" | "ANON_KEY") =>
  Effect.gen(function* () {
    const topic = yield* unique("room");
    const received = yield* Deferred.make<unknown>();
    const receiver = (yield* realtimeClient(key))
      .channel(topic)
      .on("broadcast", { event: "ping" }, ({ payload }) =>
        Deferred.doneUnsafe(received, Effect.succeed(payload)),
      );
    const sender = (yield* realtimeClient(key)).channel(topic);
    yield* Effect.all([subscribed(receiver), subscribed(sender)], { concurrency: "unbounded" });
    const sent = yield* call("send broadcast", () =>
      sender.send({ type: "broadcast", event: "ping", payload: { n: 42 } }),
    );
    expect(sent).toBe("ok");
    expect(yield* Deferred.await(received)).toEqual({ n: 42 });
  });

const realtimeCases: ReadonlyArray<ContractCase> = [
  {
    name: "Realtime delivers a broadcast between publishable-key clients",
    run: deliversBroadcast("PUBLISHABLE_KEY"),
  },
  {
    name: "Realtime delivers a broadcast between legacy anon-key clients",
    run: deliversBroadcast("ANON_KEY"),
  },
];

/* Guards a cold first launch: native stacks start the edge runtime on first use. */
const COLD_LAUNCH_TIMEOUT_MS = 120_000;

const invokesEcho = (key: "PUBLISHABLE_KEY" | "ANON_KEY") =>
  Effect.gen(function* () {
    const client = yield* contractClient(key);
    const data = yield* sdk("invoke echo", (signal) => client.functions.invoke("echo", { signal }));
    expect(data).toEqual({ ok: true });
  });

const functionsCases: ReadonlyArray<ContractCase> = [
  {
    name: "Functions invokes a function with the publishable key",
    run: invokesEcho("PUBLISHABLE_KEY"),
    timeout: COLD_LAUNCH_TIMEOUT_MS,
  },
  {
    name: "Functions invokes a function with the legacy anon key",
    run: invokesEcho("ANON_KEY"),
    timeout: COLD_LAUNCH_TIMEOUT_MS,
  },
  {
    name: "Functions rejects a request without Authorization when verify_jwt is on",
    run: Effect.gen(function* () {
      const { FUNCTIONS_URL } = yield* ContractTarget;
      const response = yield* HttpClient.post(`${FUNCTIONS_URL}/echo`);
      const body = yield* response.text;
      expect(response.status, body).toBe(401);
      expect(body).toContain("UNAUTHORIZED_NO_AUTH_HEADER");
    }),
    timeout: COLD_LAUNCH_TIMEOUT_MS,
  },
];

const appliesInOrder = Effect.gen(function* () {
  const client = yield* contractClient("SECRET_KEY");
  const log = yield* sdk("select contract_log", (signal) =>
    client.from("contract_log").select("source").order("seq").abortSignal(signal),
  );
  expect(log.map(({ source }) => source)).toEqual([
    "migration 0 sees auth=true storage=true realtime=true",
    "migration 10",
    "migration 20260101000000",
    "migration 9",
    "seed zz",
    "seed aa sees public=false",
    "seed mm",
  ]);
  const buckets = yield* sdk("list buckets", () => client.storage.listBuckets());
  expect(Object.fromEntries(buckets.map(({ id, public: open }) => [id, open]))).toMatchObject({
    "config-public": true,
    "config-private": false,
  });
  for (const [key, text] of Object.entries({
    "a.txt": "seeded object\n",
    "nested/b.txt": "nested object\n",
  })) {
    const object = yield* sdk(`download seeded ${key}`, (signal) =>
      client.storage.from("config-public").download(key, {}, { signal }),
    );
    expect(yield* call(`read seeded ${key}`, () => object.text())).toBe(text);
  }
});

const seedingCases: ReadonlyArray<ContractCase> = [
  {
    name: "start applies migrations in byte order, then seeds in sql_paths order, then config buckets",
    run: appliesInOrder,
  },
];

const resetCases: ReadonlyArray<ContractCase> = [
  {
    name: "db reset drops data and reapplies migrations, seeds and config buckets in order",
    run: Effect.gen(function* () {
      const client = yield* contractClient("PUBLISHABLE_KEY");
      const id = yield* Random.nextIntBetween(2, 1_000_000_000);
      yield* sdk("insert marker", (signal) =>
        client.from("contract_items").insert({ id, label: "before reset" }).abortSignal(signal),
      );
      yield* Effect.flatten(ContractReset);
      const rows = yield* sdk("select marker", (signal) =>
        client.from("contract_items").select("id").eq("id", id).abortSignal(signal),
      );
      expect(rows).toEqual([]);
      yield* appliesInOrder;
    }),
    /* Guards a legacy reset, which recreates the database container and restarts its services. */
    timeout: 180_000,
  },
];

const contractCases: ReadonlyArray<ContractCase> = [
  ...postgrestCases,
  ...authCases,
  ...storageCases,
  ...realtimeCases,
  ...functionsCases,
  ...seedingCases,
  /* Last: a legacy reset restarts its services without start's Realtime readiness wait. */
  ...resetCases,
];

/** Runs every contract case against one setup's running stack. */
export const describeContract = <E>(
  setup: string,
  target: Layer.Layer<ContractTarget | ContractReset, E>,
) =>
  layer(Layer.mergeAll(target, FetchHttpClient.layer, Socket.layerWebSocketConstructorGlobal), {
    /* Guards the stack start, including first image pulls or native artifact downloads. */
    timeout: "5 minutes",
    excludeTestServices: true,
  })(`consumer contract (${setup})`, (it) => {
    for (const { name, run, timeout } of contractCases)
      it.effect(name, () => run, timeout ?? 60_000);
  });
