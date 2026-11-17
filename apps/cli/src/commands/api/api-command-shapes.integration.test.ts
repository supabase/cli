import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { openApiOperationIdMap } from "@supabase/api/effect";
import openApiSpec from "@supabase/api/openapi.json";
import { Console, Effect, Exit, FileSystem, Layer, Path, Predicate, Schema, Stdio } from "effect";
import { CliOutput, Command } from "effect/cli";

import { deriveApiCommands } from "../../../scripts/api-command-derive.ts";
import { ApiCommandUsageError } from "../../command-internal/command-errors/api-command.errors.ts";
import { ExperimentalFlag, GLOBAL_FLAGS } from "../../command-internal/global-flags.ts";
import { textCliOutputFormatter } from "../../shared/output/text-formatter.ts";
import {
  VALID_REF,
  VALID_TOKEN,
  buildTestRuntime,
  mockCommandPlatformApi,
  mockCommandSettings,
  useTempWorkdir,
  withConfigEnv,
} from "../../../tests/helpers/command-mocks.ts";
import {
  fakeConsole,
  mockOutput,
  mockRuntimeInfo,
  mockStdin,
  mockTelemetryRuntime,
  mockTty,
} from "../../../tests/helpers/mocks.ts";
import type { ApiNoun } from "./api-command-policy.ts";
import { apiCommandGroup } from "./runtime.ts";

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Predicate.isObject(value) && !Array.isArray(value);

const fixtureNoun: ApiNoun = {
  description: "Fixture commands",
  feature: "fixture",
  groups: {
    migrations: "Migration fixtures",
    auth: "Auth fixtures",
    "auth.signing-keys": "Signing key fixtures",
    jit: "JIT access fixtures",
    keys: "Legacy key fixtures",
  },
};

const FIXTURE_OPERATIONS = {
  "v1-apply-a-migration": { group: "fixture.migrations", method: "create" },
  "v1-get-a-migration": { group: "fixture.migrations", method: "get" },
  "v1-get-project-signing-key": { group: "fixture.auth.signing-keys", method: "get" },
  "v1-update-jit-access": { group: "fixture.jit", method: "update" },
  "v1-update-project-legacy-api-keys": { group: "fixture.keys", method: "update" },
};

/** The committed spec with an experimental `x-operation` on a few real operations. */
const fixtureSpec = () => {
  const spec: Record<string, unknown> = structuredClone(openApiSpec);
  for (const item of Object.values(isRecord(spec["paths"]) ? spec["paths"] : {})) {
    for (const operation of Object.values(isRecord(item) ? item : {})) {
      if (!isRecord(operation)) continue;
      const operationId = String(operation["operationId"]);
      if (!Object.hasOwn(FIXTURE_OPERATIONS, operationId)) continue;
      operation["x-operation"] = Reflect.get(FIXTURE_OPERATIONS, operationId);
      operation["x-scalar-stability"] = "experimental";
    }
  }
  return spec;
};

const derived = deriveApiCommands({
  spec: fixtureSpec(),
  generated: Object.keys(FIXTURE_OPERATIONS),
  pollTargets: {},
  nouns: { fixture: fixtureNoun },
  operationIdMap: openApiOperationIdMap,
  handWrittenTopLevel: new Set(),
});

const fixtureRoot = Command.make("supabase").pipe(
  Command.withSubcommands([apiCommandGroup("fixture", fixtureNoun, derived.entries)]),
  Command.withGlobalFlags(GLOBAL_FLAGS),
);

const MIGRATION_VERSION = "20250312000000";
const SIGNING_KEY_ID = "33333333-3333-4333-8333-333333333333";
const MIGRATIONS_PATH = `/v1/projects/${VALID_REF}/database/migrations`;
const TARGET_LOOKUP_PATH = `/v1/projects/${VALID_REF}`;

interface Sent {
  readonly method: string;
  readonly path: string;
  readonly headers: Headers;
  readonly body: unknown;
}

/** Replaces `globalThis.fetch` while the command runs; every API request is recorded and answered with `{}`. */
const withApi = (sent: Array<Sent>) => {
  const answer = () =>
    new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  const stub = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    if (url.pathname === TARGET_LOOKUP_PATH) return Promise.resolve(answer());
    return request.text().then((text) => {
      sent.push({
        method: request.method,
        path: url.pathname,
        headers: request.headers,
        body: text === "" ? undefined : decodeJson(text),
      });
      return answer();
    });
  };
  return <A, E, R>(body: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = globalThis.fetch;
        globalThis.fetch = Object.assign(stub, { preconnect: previous.preconnect });
        return previous;
      }),
      () => body,
      (previous) =>
        Effect.sync(() => {
          globalThis.fetch = previous;
        }),
    );
};

const tempRoot = useTempWorkdir("supabase-api-shapes-int-");

const run = (argv: ReadonlyArray<string>) => {
  const args = [...argv, `--remote=${VALID_REF}`, "--yes"];
  const sent: Array<Sent> = [];
  const out = mockOutput({ format: "text" });
  const { console, calls } = fakeConsole();
  const layer = Layer.mergeAll(
    buildTestRuntime({
      out,
      api: mockCommandPlatformApi({ response: { status: 200, body: {} } }),
      cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
      tty: mockTty({ stdinIsTty: false, stdoutIsTty: false }),
      stdin: mockStdin(false),
      cliArgs: args,
    }),
    BunServices.layer,
    CliOutput.layer(textCliOutputFormatter()),
    Layer.succeed(ExperimentalFlag, false),
    mockTelemetryRuntime({ configDir: tempRoot.current }),
    mockRuntimeInfo({ cwd: tempRoot.current, homeDir: tempRoot.current }),
    Stdio.layerTest({ args: Effect.succeed(args) }),
  );
  const effect = withConfigEnv(
    { SUPABASE_ACCESS_TOKEN: VALID_TOKEN, SUPABASE_NO_KEYRING: "1" },
    Command.runWith(fixtureRoot, { version: "0.0.0-test" })(args),
  ).pipe(withApi(sent), Effect.provideService(Console.Console, console), Effect.provide(layer));
  return { sent, out, help: () => calls.join("\n"), effect };
};

describe("generated command shapes", () => {
  it("derives the fixture commands without problems", () => {
    expect(derived.problems).toEqual([]);
    expect(derived.entries.map((entry) => entry.command.join(" "))).toEqual([
      "fixture auth signing-keys get",
      "fixture jit update",
      "fixture keys update",
      "fixture migrations create",
      "fixture migrations get",
    ]);
  });

  describe("a positional path parameter", () => {
    it.effect("is path-encoded into the request of a three-word command", () => {
      const { sent, effect } = run(["fixture", "migrations", "get", MIGRATION_VERSION]);
      return Effect.gen(function* () {
        yield* effect;
        expect(sent.map(({ method, path }) => `${method} ${path}`)).toEqual([
          `GET ${MIGRATIONS_PATH}/${MIGRATION_VERSION}`,
        ]);
      });
    });

    it.effect("reaches a four-word command through two nested groups", () => {
      const { sent, effect } = run(["fixture", "auth", "signing-keys", "get", SIGNING_KEY_ID]);
      return Effect.gen(function* () {
        yield* effect;
        expect(sent.map(({ path }) => path)).toEqual([
          `/v1/projects/${VALID_REF}/config/auth/signing-keys/${SIGNING_KEY_ID}`,
        ]);
      });
    });

    it.effect("fails the parse and sends nothing when it is missing", () => {
      const { sent, help, effect } = run(["fixture", "migrations", "get"]);
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(effect);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(help()).toContain("<version>");
        expect(sent).toEqual([]);
      });
    });

    it.effect.each(["", ".."])(
      "rejects the value %j as a usage error and sends nothing",
      (value) => {
        const { sent, effect } = run(["fixture", "migrations", "get", value]);
        return Effect.gen(function* () {
          const failure = yield* Effect.flip(effect);
          expect(failure).toBeInstanceOf(ApiCommandUsageError);
          expect(failure).toMatchObject({
            message: '<version> must not be empty, "." or "..".',
          });
          expect(sent).toEqual([]);
        });
      },
    );

    it.effect("is interpolated into the dry-run path", () => {
      const { sent, out, effect } = run([
        "fixture",
        "migrations",
        "get",
        MIGRATION_VERSION,
        "--dry-run",
      ]);
      return Effect.gen(function* () {
        yield* effect;
        expect(sent).toEqual([]);
        expect(decodeJson(out.stdoutText)).toEqual({
          method: "GET",
          path: `${MIGRATIONS_PATH}/${MIGRATION_VERSION}`,
          query: {},
          headers: {},
          body: null,
        });
      });
    });
  });

  describe("a header flag", () => {
    const create = ["fixture", "migrations", "create", "--query", "select 1"];

    it.effect("is sent as the header when passed", () => {
      const { sent, effect } = run([...create, "--idempotency-key", "retry-1"]);
      return Effect.gen(function* () {
        yield* effect;
        expect(sent.map((request) => request.headers.get("idempotency-key"))).toEqual(["retry-1"]);
      });
    });

    it.effect("is left out of the request when absent", () => {
      const { sent, effect } = run(create);
      return Effect.gen(function* () {
        yield* effect;
        expect(sent.map((request) => request.headers.has("idempotency-key"))).toEqual([false]);
      });
    });

    it.effect("appears under headers in the dry-run document", () => {
      const { out, effect } = run([...create, "--idempotency-key", "retry-1", "--dry-run"]);
      return Effect.gen(function* () {
        yield* effect;
        expect(decodeJson(out.stdoutText)).toEqual({
          method: "POST",
          path: MIGRATIONS_PATH,
          query: {},
          headers: { "Idempotency-Key": "retry-1" },
          body: { query: "select 1" },
        });
      });
    });
  });

  describe("a body field without a flag", () => {
    const USER_ID = "55555555-5555-4555-8555-555555555555";
    const roles = [
      { role: "postgres", allowed_networks: { allowed_cidrs: [{ cidr: "10.0.0.0/8" }] } },
    ];
    const update = ["fixture", "jit", "update"];

    it.effect("is sent from --body together with a flag-supplied scalar field", () => {
      const { sent, effect } = run([
        ...update,
        "--user-id",
        USER_ID,
        "--body",
        encodeJson({ roles }),
      ]);
      return Effect.gen(function* () {
        yield* effect;
        expect(sent.map(({ method, path }) => `${method} ${path}`)).toEqual([
          `PUT /v1/projects/${VALID_REF}/database/jit`,
        ]);
        expect(sent.map((request) => request.body)).toEqual([{ user_id: USER_ID, roles }]);
      });
    });

    it.effect("is sent from --file together with a flag-supplied scalar field", () => {
      const { sent, effect } = run([
        ...update,
        "--user-id",
        USER_ID,
        "--file",
        `${tempRoot.current}/jit.json`,
      ]);
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.writeFileString(path.join(tempRoot.current, "jit.json"), encodeJson({ roles }));
        yield* effect;
        expect(sent.map((request) => request.body)).toEqual([{ user_id: USER_ID, roles }]);
      }).pipe(Effect.provide(BunServices.layer));
    });

    it.effect("has no flag in --help while its scalar sibling has one", () => {
      const { help, effect } = run([...update, "--help"]);
      return Effect.gen(function* () {
        yield* effect;
        expect(help()).toContain("--user-id");
        expect(help()).not.toContain("--roles");
        expect(help()).not.toContain("--role ");
      });
    });
  });

  describe("a required query flag", () => {
    it.effect("reports a missing flag with the plain hint and sends nothing", () => {
      const { sent, effect } = run(["fixture", "keys", "update"]);
      return Effect.gen(function* () {
        const failure = yield* effect.pipe(Effect.flip);
        expect(failure).toMatchObject({ hint: "Pass the flag." });
        expect(sent).toEqual([]);
      });
    });
  });

  describe("help", () => {
    it.effect("lists the nested group under its parent", () => {
      const { help, effect } = run(["fixture", "auth", "--help"]);
      return Effect.gen(function* () {
        yield* effect;
        expect(help()).toContain("signing-keys");
        expect(help()).toContain("Signing key fixtures (experimental)");
      });
    });

    it.effect("shows the positional in the usage and the header as an optional flag", () => {
      const read = run(["fixture", "migrations", "get", "--help"]);
      const create = run(["fixture", "migrations", "create", "--help"]);
      return Effect.gen(function* () {
        yield* read.effect;
        yield* create.effect;
        expect(read.help()).toContain("<version>");
        const flagLine = create
          .help()
          .split("\n")
          .find((line) => line.includes("--idempotency-key "));
        expect(flagLine).toContain(
          "A unique key to ensure the same migration is tracked only once.",
        );
        expect(flagLine).not.toContain("Required");
      });
    });
  });
});
