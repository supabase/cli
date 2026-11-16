import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Console,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
  Stdio,
} from "effect";
import { CliOutput, Command } from "effect/cli";
import * as HttpClientError from "effect/http/HttpClientError";
import * as TestClock from "effect/testing/TestClock";

import { respondToComplete } from "../../cli/complete.ts";
import { rootCommandForFeatures } from "../../cli/root.ts";
import { ExperimentalFlag, GLOBAL_FLAGS } from "../../command-internal/global-flags.ts";
import { HostedMutationConsentRequiredError } from "../../command-internal/hosted-consent/hosted-consent.errors.ts";
import { InvalidOutputFormatError } from "../../command-internal/output-formats.ts";
import { ExperimentalFeatureFlagError } from "../../shared/config/experimental-feature.ts";
import { textCliOutputFormatter } from "../../shared/output/text-formatter.ts";
import { commandTreeFor } from "../../../tests/helpers/command-flags.ts";
import {
  VALID_REF,
  VALID_TOKEN,
  buildTestRuntime,
  mockCommandPlatformApi,
  mockCommandSettings,
  useTempWorkdir,
  withConfigEnv,
} from "../../../tests/helpers/command-mocks.ts";
import { describeHostedConsent } from "../../../tests/helpers/hosted-consent.ts";
import {
  fakeConsole,
  mockOutput,
  mockRuntimeInfo,
  mockStdin,
  mockTelemetryRuntime,
  mockTty,
} from "../../../tests/helpers/mocks.ts";
import {
  ApiCommandOperationFailedError,
  ApiCommandStatusError,
  ApiCommandUsageError,
  ApiCommandWaitTimeoutError,
} from "../../command-internal/command-errors/api-command.errors.ts";
import type { ApiCommandEntry } from "./api-command.model.ts";
import { assembleInput, decodeInput, previewRequest } from "./api-command-request.ts";
import { apiCommands } from "./generated.ts";
import { readApiCommand } from "./api-command.annotation.ts";
import { readCommandStage } from "../../command-internal/command-stage/command-stage.annotation.ts";
import { apiCommandGroup, apiCommandGroups } from "./runtime.ts";
import { resolveWarehouseEnabled } from "./warehouse-backend.ts";

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const entryOf = (path: string): ApiCommandEntry => {
  const entry = apiCommands.find((candidate) => candidate.command.join(" ") === path);
  if (entry === undefined) throw new Error(`no generated command "${path}"`);
  return entry;
};

const enable = entryOf("warehouse enable");
const status = entryOf("warehouse status");

const ENABLE_PATH = `/v2/projects/${VALID_REF}/warehouse/enable`;
const STATUS_PATH = `/v2/projects/${VALID_REF}/warehouse/setups/current`;
const TARGET_LOOKUP_PATH = `/v1/projects/${VALID_REF}`;

const SEL = "ab".repeat(32);

const ACCEPTED = {
  data: {
    type: "warehouse_setup",
    id: SEL,
    attributes: { selection_id: SEL, status: "pending", future_field: { nested: [1, 2] } },
  },
};

const statusBody = (state: string, statusError?: string) => ({
  data: {
    type: "warehouse_setup",
    attributes: {
      selection_id: SEL,
      status: state,
      ...(statusError === undefined ? {} : { status_error: statusError }),
    },
  },
});

/** One request the CLI sent to the stubbed Management API. */
interface Sent {
  readonly method: string;
  readonly path: string;
  readonly search: string;
  readonly body: unknown;
}

/** A canned API answer; a string body is sent as is, anything else as JSON. */
interface Reply {
  readonly status: number;
  readonly body?: unknown;
  /** Fails the body stream mid-read, after the status line was delivered. */
  readonly unreadable?: boolean;
}

type Route = (request: Sent) => Reply;

const ok =
  (body: unknown): Route =>
  () => ({ status: 200, body });
const accepted: Route = () => ({ status: 202, body: ACCEPTED });

/** Answers the enable POST with `ACCEPTED` and each later read with the next of `reads`. */
const enableThenPoll = (reads: ReadonlyArray<Reply>): Route => {
  let read = 0;
  return (request) => {
    if (request.method === "POST") return { status: 202, body: ACCEPTED };
    const next = reads[Math.min(read, reads.length - 1)];
    read += 1;
    return next ?? { status: 200, body: {} };
  };
};

const replyOf = (reply: Reply): Response => {
  if (reply.unreadable === true) {
    const broken = new ReadableStream<Uint8Array>({
      pull: (controller) => controller.error(new Error("connection reset")),
    });
    return new Response(broken, {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  }
  const text =
    reply.body === undefined
      ? null
      : typeof reply.body === "string"
        ? reply.body
        : encodeJson(reply.body);
  return new Response(text, {
    status: reply.status,
    headers: reply.body === undefined ? {} : { "content-type": "application/json" },
  });
};

/** Replaces `globalThis.fetch` while `body` runs: the one in-process seam under the real leaf. */
const withApi = (route: Route, sent: Array<Sent>) => {
  const stub = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    if (url.pathname === TARGET_LOOKUP_PATH) {
      return Promise.resolve(replyOf({ status: 200, body: {} }));
    }
    return request.text().then((text) => {
      const entry: Sent = {
        method: request.method,
        path: url.pathname,
        search: url.search.replace(/^\?/, ""),
        body: text === "" ? undefined : decodeJson(text),
      };
      sent.push(entry);
      return replyOf(route(entry));
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

const warehouseRoot = Command.make("supabase").pipe(
  Command.withSubcommands(apiCommandGroups(["warehouse"])),
  Command.withGlobalFlags(GLOBAL_FLAGS),
);

const tempRoot = useTempWorkdir("supabase-api-commands-int-");

/** What the real root needs around a leaf that is not part of the command tree under test. */
const cliServices = (workdir: string, args: ReadonlyArray<string>) =>
  Layer.mergeAll(
    BunServices.layer,
    CliOutput.layer(textCliOutputFormatter()),
    Layer.succeed(ExperimentalFlag, false),
    mockTelemetryRuntime({ configDir: workdir }),
    mockRuntimeInfo({ cwd: workdir, homeDir: workdir }),
    Stdio.layerTest({ args: Effect.succeed(args) }),
  );

interface CliOpts {
  readonly yes?: boolean;
  readonly route: Route;
  readonly root?: typeof warehouseRoot;
}

/**
 * Runs `argv` through the real parser and the real generated leaf; only `globalThis.fetch` is
 * stubbed. `run` still needs the test runtime layers (see {@link setup}).
 */
const execute = (argv: ReadonlyArray<string>, opts: CliOpts) => {
  const args = [...argv, `--remote=${VALID_REF}`, ...(opts.yes === true ? ["--yes"] : [])];
  const sent: Array<Sent> = [];
  const run = withConfigEnv(
    { SUPABASE_ACCESS_TOKEN: VALID_TOKEN, SUPABASE_NO_KEYRING: "1" },
    Command.runWith(opts.root ?? warehouseRoot, { version: "0.0.0-test" })(args),
  ).pipe(withApi(opts.route, sent));
  return { args, sent, run };
};

const setup = (argv: ReadonlyArray<string>, opts: CliOpts) => {
  const out = mockOutput({ format: "text" });
  const { args, sent, run } = execute(argv, opts);
  const layer = Layer.mergeAll(
    buildTestRuntime({
      out,
      api: mockCommandPlatformApi({ response: { status: 200, body: {} } }),
      cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
      tty: mockTty({ stdinIsTty: false, stdoutIsTty: false }),
      stdin: mockStdin(false),
      cliArgs: args,
    }),
    cliServices(tempRoot.current, args),
  );
  return { out, sent, run: run.pipe(Effect.provide(layer)) };
};

const failureOf = (exit: Exit.Exit<unknown, unknown>): unknown =>
  Exit.isFailure(exit) ? Exit.findErrorOption(exit).pipe(Option.getOrUndefined) : undefined;

const bodiesOf = (sent: ReadonlyArray<Sent>) => sent.map((request) => request.body);

describe("generated warehouse commands", () => {
  describe("warehouse enable request", () => {
    it.effect("sends only the schema when no other flag is given", () => {
      const { sent, run } = setup(["warehouse", "enable", "--schema", "public"], {
        yes: true,
        route: accepted,
      });
      return Effect.gen(function* () {
        yield* run;
        expect(sent.map((request) => `${request.method} ${request.path}`)).toEqual([
          `POST ${ENABLE_PATH}`,
        ]);
        expect(bodiesOf(sent)).toEqual([
          { data: { type: "warehouse_setup", attributes: { schema: "public" } } },
        ]);
      });
    });

    it.effect("maps a repeated --table to tables and keeps a false boolean", () => {
      const { sent, run } = setup(
        [
          "warehouse",
          "enable",
          "--schema",
          "public",
          "--table",
          "a",
          "--table",
          "b",
          "--install-fdw",
          "false",
        ],
        { yes: true, route: accepted },
      );
      return Effect.gen(function* () {
        yield* run;
        expect(bodiesOf(sent)).toEqual([
          {
            data: {
              type: "warehouse_setup",
              attributes: { schema: "public", tables: ["a", "b"], install_fdw: false },
            },
          },
        ]);
      });
    });

    it.effect("lets a flag win only at its own pointer when merged into --body", () => {
      const body = encodeJson({
        data: {
          type: "warehouse_setup",
          attributes: { schema: "from-body", install_fdw: true, tables: ["t1"] },
        },
      });
      const { sent, run } = setup(
        ["warehouse", "enable", "--body", body, "--schema", "from-flag"],
        {
          yes: true,
          route: accepted,
        },
      );
      return Effect.gen(function* () {
        yield* run;
        expect(bodiesOf(sent)).toEqual([
          {
            data: {
              type: "warehouse_setup",
              attributes: { schema: "from-flag", install_fdw: true, tables: ["t1"] },
            },
          },
        ]);
      });
    });

    it.effect("reads the whole body from --file", () => {
      const { sent, run } = setup(
        ["warehouse", "enable", "--file", `${tempRoot.current}/enable.json`],
        { yes: true, route: accepted },
      );
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.writeFileString(
          path.join(tempRoot.current, "enable.json"),
          encodeJson({ data: { type: "warehouse_setup", attributes: { schema: "file" } } }),
        );
        yield* run;
        expect(bodiesOf(sent)).toEqual([
          { data: { type: "warehouse_setup", attributes: { schema: "file" } } },
        ]);
      }).pipe(Effect.provide(BunServices.layer));
    });

    it.effect("rejects an unknown key in --body as a usage error and sends nothing", () => {
      const body = encodeJson({
        data: { type: "warehouse_setup", attributes: { schema: "public", bogus: 1 } },
      });
      const { sent, run } = setup(["warehouse", "enable", "--body", body], {
        yes: true,
        route: accepted,
      });
      return Effect.gen(function* () {
        expect(failureOf(yield* Effect.exit(run))).toBeInstanceOf(ApiCommandUsageError);
        expect(sent).toEqual([]);
      });
    });

    it.effect.each([
      {
        name: "ref",
        body: {
          ref: "zyxwvutsrqponmlkjihg",
          data: { type: "warehouse_setup", attributes: { schema: "public" } },
        },
      },
      { name: "bogus", body: { bogus: 1 } },
    ])(
      "rejects the top-level $name key in --body, naming it, and sends nothing",
      ({ name, body }) => {
        const { sent, run } = setup(["warehouse", "enable", "--body", encodeJson(body)], {
          yes: true,
          route: accepted,
        });
        return Effect.gen(function* () {
          const failure = failureOf(yield* Effect.exit(run));
          expect(failure).toBeInstanceOf(ApiCommandUsageError);
          expect(failure).toMatchObject({ message: expect.stringContaining(`"${name}"`) });
          expect(sent).toEqual([]);
        });
      },
    );

    it.effect("names the missing --schema flag and sends nothing", () => {
      const { sent, run } = setup(["warehouse", "enable", "--install-fdw", "true"], {
        yes: true,
        route: accepted,
      });
      return Effect.gen(function* () {
        const failure = failureOf(yield* Effect.exit(run));
        expect(failure).toBeInstanceOf(ApiCommandUsageError);
        expect(failure).toMatchObject({
          message: "Missing required flag --schema",
          hint: "Pass the flag, or include the field in --body/--file.",
        });
        expect(sent).toEqual([]);
      });
    });
  });

  describe("consent and dry run", () => {
    it.effect("prints exactly the request preview and sends nothing under --dry-run", () => {
      const { out, sent, run } = setup(
        ["warehouse", "enable", "--schema", "public", "--table", "a", "--dry-run"],
        { route: accepted },
      );
      return Effect.gen(function* () {
        yield* run;
        expect(sent).toEqual([]);
        expect(decodeJson(out.stdoutText)).toEqual({
          method: "POST",
          path: ENABLE_PATH,
          query: {},
          headers: {},
          body: {
            data: { type: "warehouse_setup", attributes: { schema: "public", tables: ["a"] } },
          },
        });
      });
    });

    it.effect("masks a sensitive field supplied through --body in the preview", () =>
      Effect.gen(function* () {
        const sensitiveEntry: ApiCommandEntry = {
          ...enable,
          flags: enable.flags.map((flag) =>
            flag.name === "schema" ? { ...flag, sensitive: true } : flag,
          ),
        };
        const body = Option.some({
          data: { type: "warehouse_setup", attributes: { schema: "top-secret" } },
        });
        const input = yield* assembleInput(sensitiveEntry, VALID_REF, {}, body);
        const decoded = yield* decodeInput(sensitiveEntry, input);

        const preview = previewRequest(sensitiveEntry, decoded);

        expect(encodeJson(preview)).not.toContain("top-secret");
        expect(preview.body).toEqual({
          data: { type: "warehouse_setup", attributes: { schema: "[redacted]" } },
        });
      }),
    );

    it.effect("previews a read with a null body", () => {
      const { out, run } = setup(["warehouse", "status", "--inspect-fdw", "false", "--dry-run"], {
        route: ok({}),
      });
      return Effect.gen(function* () {
        yield* run;
        expect(decodeJson(out.stdoutText)).toEqual({
          method: "GET",
          path: STATUS_PATH,
          query: { inspect_fdw: "false" },
          headers: {},
          body: null,
        });
      });
    });

    it.effect("prints the dry-run preview as YAML under -o yaml", () => {
      const { out, run } = setup(
        ["warehouse", "enable", "--schema", "public", "--dry-run", "-o", "yaml"],
        { route: accepted },
      );
      return Effect.gen(function* () {
        yield* run;
        expect(Bun.YAML.parse(out.stdoutText)).toEqual({
          method: "POST",
          path: ENABLE_PATH,
          query: {},
          headers: {},
          body: { data: { type: "warehouse_setup", attributes: { schema: "public" } } },
        });
      });
    });

    it.effect.each([
      { name: "a send", argv: ["warehouse", "enable", "--schema", "public"] },
      { name: "a dry run", argv: ["warehouse", "enable", "--schema", "public", "--dry-run"] },
      { name: "a read", argv: ["warehouse", "status"] },
    ])("rejects -o env for $name as a usage error and sends nothing", ({ argv }) => {
      const { sent, run } = setup([...argv, "-o", "env"], { yes: true, route: accepted });
      return Effect.gen(function* () {
        expect(failureOf(yield* Effect.exit(run))).toBeInstanceOf(InvalidOutputFormatError);
        expect(sent).toEqual([]);
      });
    });

    it.effect("refuses a non-interactive mutation without --yes", () => {
      const { sent, run } = setup(["warehouse", "enable", "--schema", "public"], {
        route: accepted,
      });
      return Effect.gen(function* () {
        expect(failureOf(yield* Effect.exit(run))).toBeInstanceOf(
          HostedMutationConsentRequiredError,
        );
        expect(sent).toEqual([]);
      });
    });
  });

  describe("responses", () => {
    it.effect(
      "writes a JSON response with unknown fields unchanged and without a target key",
      () => {
        const { out, run } = setup(["warehouse", "enable", "--schema", "public"], {
          yes: true,
          route: accepted,
        });
        return Effect.gen(function* () {
          yield* run;
          expect(out.stdoutText).toBe(encodeJson(ACCEPTED));
          expect(out.stdoutText).not.toContain('"target"');
        });
      },
    );

    it.effect.each([
      {
        name: "a v1 body with a top-level message and code",
        reply: { status: 422, body: { message: "selection rejected", code: "selection_conflict" } },
        expected: { status: 422, message: "selection rejected", apiCode: "selection_conflict" },
      },
      {
        name: "a v2 body nesting the error, with its description",
        reply: {
          status: 409,
          body: {
            error: { code: "conflict", message: "Setup exists", description: "Run status." },
          },
        },
        expected: { status: 409, message: "Setup exists: Run status.", apiCode: "conflict" },
      },
      {
        name: "a v2 401 body",
        reply: {
          status: 401,
          body: { error: { code: "unauthenticated", message: "Invalid access token" } },
        },
        expected: {
          status: 401,
          message: "Invalid access token",
          apiCode: "unauthenticated",
        },
      },
      {
        name: "a body that carries no message",
        reply: { status: 503, body: "<html>bad gateway</html>" },
        expected: { status: 503, message: "Unexpected status 503", apiCode: undefined },
      },
    ])("fails with the parsed API error for $name", ({ reply, expected }) => {
      const { run } = setup(["warehouse", "enable", "--schema", "public"], {
        yes: true,
        route: () => reply,
      });
      return Effect.gen(function* () {
        const failure = failureOf(yield* Effect.exit(run));
        expect(failure).toBeInstanceOf(ApiCommandStatusError);
        expect(failure).toMatchObject(expected);
      });
    });

    it.effect("fails with a network error when the success body cannot be read", () => {
      const { out, run } = setup(["warehouse", "enable", "--schema", "public"], {
        yes: true,
        route: () => ({ status: 202, unreadable: true }),
      });
      return Effect.gen(function* () {
        const failure = failureOf(yield* Effect.exit(run));
        expect(HttpClientError.isHttpClientError(failure)).toBe(true);
        expect(out.stdoutText).toBe("");
      });
    });

    it.effect.each([
      {
        name: "a 401",
        reply: { status: 401, body: { message: "Invalid access token" } },
        hint: "Run `supabase login`",
      },
      {
        name: "a 403",
        reply: { status: 403, body: { message: "Forbidden" } },
        hint: "Your token needs the permissions:",
      },
      {
        name: "a 401 that carries its own hint",
        reply: {
          status: 401,
          body: { message: "Expired", hint: "Rotate the token in the dashboard." },
        },
        hint: "Rotate the token in the dashboard.",
      },
    ])("hints at the fix for $name", ({ reply, hint }) => {
      const { run } = setup(["warehouse", "enable", "--schema", "public"], {
        yes: true,
        route: () => reply,
      });
      return Effect.gen(function* () {
        const failure = failureOf(yield* Effect.exit(run));
        expect(failure).toBeInstanceOf(ApiCommandStatusError);
        expect(failure).toMatchObject({ hint: expect.stringContaining(hint) });
      });
    });

    it.effect("prints a JSON response as YAML of the parsed document under -o yaml", () => {
      const { out, run } = setup(["warehouse", "enable", "--schema", "public", "-o", "yaml"], {
        yes: true,
        route: accepted,
      });
      return Effect.gen(function* () {
        yield* run;
        expect(Bun.YAML.parse(out.stdoutText)).toEqual(ACCEPTED);
      });
    });

    it.effect("sends status --inspect-fdw false as the inspect_fdw=false query", () => {
      const { sent, out, run } = setup(["warehouse", "status", "--inspect-fdw", "false"], {
        route: ok(statusBody("succeeded")),
      });
      return Effect.gen(function* () {
        yield* run;
        expect(sent.map((request) => request.method)).toEqual(["GET"]);
        expect(sent[0]?.path).toBe(STATUS_PATH);
        expect(sent[0]?.search).toBe("inspect_fdw=false");
        expect(decodeJson(out.stdoutText)).toEqual(statusBody("succeeded"));
      });
    });

    it.effect("sends no query when no status flag is given", () => {
      const { sent, run } = setup(["warehouse", "status"], { route: ok(statusBody("succeeded")) });
      return Effect.gen(function* () {
        yield* run;
        expect(sent[0]?.search).toBe("");
      });
    });
  });

  describe("help", () => {
    it.effect("marks a required API flag as required in its description", () => {
      const { console, calls } = fakeConsole();
      const { run } = setup(["warehouse", "enable", "--help"], { route: accepted });
      return Effect.gen(function* () {
        yield* run.pipe(Effect.provideService(Console.Console, console));
        const lines = calls.join("\n").split("\n");
        const flagLine = (name: string) => lines.find((line) => line.includes(`--${name} `));
        expect(flagLine("schema")).toContain("Required unless the field is in --body or --file.");
        expect(flagLine("table")).not.toContain("Required");
      });
    });
  });

  describe("--wait", () => {
    const driveClock = <A, E>(fiber: Fiber.Fiber<A, E>) =>
      Effect.raceFirst(Effect.forever(TestClock.adjust("2 seconds")), Fiber.await(fiber));

    it.effect("polls the read operation until the setup succeeds and prints its response", () => {
      const { sent, out, run } = setup(["warehouse", "enable", "--schema", "public", "--wait"], {
        yes: true,
        route: enableThenPoll([
          { status: 200, body: statusBody("pending") },
          { status: 200, body: statusBody("pending") },
          { status: 200, body: statusBody("succeeded") },
        ]),
      });
      return Effect.gen(function* () {
        const fiber = yield* run.pipe(Effect.forkChild({ startImmediately: true }));
        yield* driveClock(fiber);
        yield* Fiber.join(fiber);
        const gets = sent.filter((request) => request.method === "GET");
        expect(gets).toHaveLength(3);
        expect(gets.every((request) => request.path === STATUS_PATH)).toBe(true);
        expect(gets.every((request) => request.search === `selection_id=${SEL}`)).toBe(true);
        expect(out.stdoutText).toBe(encodeJson(statusBody("succeeded")));
      });
    });

    it.effect("fails with the reported status_error when the setup fails", () => {
      const { run } = setup(["warehouse", "enable", "--schema", "public", "--wait"], {
        yes: true,
        route: enableThenPoll([{ status: 200, body: statusBody("failed", "pipeline crashed") }]),
      });
      return Effect.gen(function* () {
        const fiber = yield* run.pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
        yield* driveClock(fiber);
        const failure = yield* Fiber.join(fiber);
        expect(failure).toBeInstanceOf(ApiCommandOperationFailedError);
        expect(failure).toMatchObject({ message: expect.stringContaining("pipeline crashed") });
      });
    });

    it.effect("times out on the controlled clock when the status never settles", () => {
      const { sent, run } = setup(
        ["warehouse", "enable", "--schema", "public", "--wait", "--timeout", "10s"],
        { yes: true, route: enableThenPoll([{ status: 200, body: statusBody("pending") }]) },
      );
      return Effect.gen(function* () {
        const fiber = yield* run.pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
        yield* driveClock(fiber);
        expect(yield* Fiber.join(fiber)).toBeInstanceOf(ApiCommandWaitTimeoutError);
        expect(sent.filter((request) => request.method === "GET").length).toBeGreaterThan(1);
      });
    });

    it.effect("treats a 409 on the read as terminal and does not poll again", () => {
      const { sent, run } = setup(["warehouse", "enable", "--schema", "public", "--wait"], {
        yes: true,
        route: enableThenPoll([
          {
            status: 409,
            body: { error: { code: "selection_conflict", message: "selection changed" } },
          },
        ]),
      });
      return Effect.gen(function* () {
        const fiber = yield* run.pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
        yield* driveClock(fiber);
        const failure = yield* Fiber.join(fiber);
        expect(failure).toBeInstanceOf(ApiCommandStatusError);
        expect(failure).toMatchObject({ status: 409, apiCode: "selection_conflict" });
        expect(sent.filter((request) => request.method === "GET")).toHaveLength(1);
      });
    });

    it.effect(
      "fails with the standard operation_failed error when a failed status has no error",
      () => {
        const { run } = setup(["warehouse", "enable", "--schema", "public", "--wait"], {
          yes: true,
          route: enableThenPoll([{ status: 200, body: statusBody("failed") }]),
        });
        return Effect.gen(function* () {
          const fiber = yield* run.pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
          yield* driveClock(fiber);
          const failure = yield* Fiber.join(fiber);
          expect(failure).toBeInstanceOf(ApiCommandOperationFailedError);
          expect(failure).toMatchObject({
            status: "failed",
            message: 'The operation failed with status "failed".',
          });
        });
      },
    );

    it.effect("succeeds and prints the read when a succeeded status carries an error value", () => {
      const settled = statusBody("succeeded", "earlier attempt failed");
      const { out, run } = setup(["warehouse", "enable", "--schema", "public", "--wait"], {
        yes: true,
        route: enableThenPoll([{ status: 200, body: settled }]),
      });
      return Effect.gen(function* () {
        const fiber = yield* run.pipe(Effect.forkChild({ startImmediately: true }));
        yield* driveClock(fiber);
        yield* Fiber.join(fiber);
        expect(out.stdoutText).toBe(encodeJson(settled));
      });
    });

    it.effect("keeps polling while a non-terminal status carries an error value", () => {
      const { sent, run } = setup(["warehouse", "enable", "--schema", "public", "--wait"], {
        yes: true,
        route: enableThenPoll([
          { status: 200, body: statusBody("pending", "retrying") },
          { status: 200, body: statusBody("succeeded") },
        ]),
      });
      return Effect.gen(function* () {
        const fiber = yield* run.pipe(Effect.forkChild({ startImmediately: true }));
        yield* driveClock(fiber);
        yield* Fiber.join(fiber);
        expect(sent.filter((request) => request.method === "GET")).toHaveLength(2);
      });
    });

    it.effect(
      "ends the wait with a defect when the accepted response lacks the selection id",
      () => {
        const { sent, run } = setup(
          ["warehouse", "enable", "--schema", "public", "--yes", "--wait"],
          {
            yes: true,
            route: (request) =>
              request.method === "POST"
                ? { status: 202, body: { data: { type: "warehouse_setup", attributes: {} } } }
                : { status: 200, body: statusBody("succeeded") },
          },
        );
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(run);
          expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
          expect(sent.map((request) => request.method)).toEqual(["POST"]);
        });
      },
    );

    it.effect("names the status command when the setup fails and when the wait times out", () => {
      const failing = setup(["warehouse", "enable", "--schema", "public", "--wait"], {
        yes: true,
        route: enableThenPoll([{ status: 200, body: statusBody("failed", "boom") }]),
      });
      const stalling = setup(
        ["warehouse", "enable", "--schema", "public", "--wait", "--timeout", "10s"],
        { yes: true, route: enableThenPoll([{ status: 200, body: statusBody("pending") }]) },
      );
      const command = `supabase warehouse status --selection-id ${SEL} --remote=${VALID_REF}`;
      return Effect.gen(function* () {
        for (const { run } of [failing, stalling]) {
          const fiber = yield* run.pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
          yield* driveClock(fiber);
          expect(yield* Fiber.join(fiber)).toMatchObject({
            hint: expect.stringContaining(command),
          });
        }
      });
    });

    it.effect("prints the final status read as YAML under -o yaml", () => {
      const { out, run } = setup(
        ["warehouse", "enable", "--schema", "public", "--wait", "-o", "yaml"],
        {
          yes: true,
          route: enableThenPoll([
            { status: 200, body: statusBody("pending") },
            { status: 200, body: statusBody("succeeded") },
          ]),
        },
      );
      return Effect.gen(function* () {
        const fiber = yield* run.pipe(Effect.forkChild({ startImmediately: true }));
        yield* driveClock(fiber);
        yield* Fiber.join(fiber);
        expect(Bun.YAML.parse(out.stdoutText)).toEqual(statusBody("succeeded"));
      });
    });

    describe("on a read that polls itself", () => {
      const statusWait = ["warehouse", "status", "--wait"];
      const reads = (...replies: ReadonlyArray<Reply>): Route => {
        let read = 0;
        return () => replies[Math.min(read++, replies.length - 1)] ?? { status: 200, body: {} };
      };

      it.effect("polls its own route until the setup succeeds and prints the last read", () => {
        const { sent, out, run } = setup(statusWait, {
          route: reads(
            { status: 200, body: statusBody("pending") },
            { status: 200, body: statusBody("pending") },
            { status: 200, body: statusBody("succeeded") },
          ),
        });
        return Effect.gen(function* () {
          const fiber = yield* run.pipe(Effect.forkChild({ startImmediately: true }));
          yield* driveClock(fiber);
          yield* Fiber.join(fiber);
          expect(sent.map((request) => request.method)).toEqual(["GET", "GET", "GET"]);
          expect(sent.every((request) => request.path === STATUS_PATH)).toBe(true);
          expect(out.stdoutText).toBe(encodeJson(statusBody("succeeded")));
        });
      });

      it.effect("fails with the reported status_error when the setup fails", () => {
        const { run } = setup(statusWait, {
          route: reads({ status: 200, body: statusBody("failed", "pipeline crashed") }),
        });
        return Effect.gen(function* () {
          const fiber = yield* run.pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
          yield* driveClock(fiber);
          const failure = yield* Fiber.join(fiber);
          expect(failure).toBeInstanceOf(ApiCommandOperationFailedError);
          expect(failure).toMatchObject({
            message: expect.stringContaining("pipeline crashed"),
            hint: expect.stringContaining(`supabase warehouse status --remote=${VALID_REF}`),
          });
        });
      });

      it.effect("times out and names the status command to check later", () => {
        const { sent, run } = setup([...statusWait, "--timeout", "10s"], {
          route: reads({ status: 200, body: statusBody("pending") }),
        });
        return Effect.gen(function* () {
          const fiber = yield* run.pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
          yield* driveClock(fiber);
          const failure = yield* Fiber.join(fiber);
          expect(failure).toBeInstanceOf(ApiCommandWaitTimeoutError);
          expect(failure).toMatchObject({
            hint: expect.stringContaining(`supabase warehouse status --remote=${VALID_REF}`),
          });
          expect(sent.length).toBeGreaterThan(1);
        });
      });

      it.effect("sends nothing under --dry-run", () => {
        const { sent, run } = setup([...statusWait, "--dry-run"], {
          route: ok(statusBody("succeeded")),
        });
        return Effect.gen(function* () {
          yield* run;
          expect(sent).toEqual([]);
        });
      });
    });

    it.effect("rejects an invalid --timeout before sending anything", () => {
      const { sent, run } = setup(
        ["warehouse", "enable", "--schema", "public", "--wait", "--timeout", "soon"],
        { yes: true, route: accepted },
      );
      return Effect.gen(function* () {
        expect(failureOf(yield* Effect.exit(run))).toBeInstanceOf(ApiCommandUsageError);
        expect(sent).toEqual([]);
      });
    });
  });

  describe("generic response writing", () => {
    const fixture: ApiCommandEntry = {
      ...status,
      command: ["fixture", "read"],
    };
    const fixtureRoot = (entry: ApiCommandEntry) =>
      Command.make("supabase").pipe(
        Command.withSubcommands([
          apiCommandGroup("fixture", { description: "Fixture commands", feature: "fixture" }, [
            entry,
          ]),
        ]),
        Command.withGlobalFlags(GLOBAL_FLAGS),
      );

    it.effect.each([
      {
        name: "a text body as one JSON string",
        kind: "text" as const,
        reply: { status: 200, body: "plain text\nsecond line" },
        stdout: '"plain text\\nsecond line"\n',
      },
      {
        name: "an empty body as null",
        kind: "empty" as const,
        reply: { status: 204 },
        stdout: "null\n",
      },
      {
        name: "a JSON body byte for byte, unknown fields and spacing included",
        kind: "json" as const,
        reply: { status: 200, body: '{"z": 1,  "known": {"future": [1, 2]}}' },
        stdout: '{"z": 1,  "known": {"future": [1, 2]}}',
      },
    ])("writes $name", ({ kind, reply, stdout }) => {
      const entry: ApiCommandEntry = {
        ...fixture,
        response: { status: reply.status, kind },
      };
      const { out, run } = setup(["fixture", "read"], {
        root: fixtureRoot(entry),
        route: () => reply,
      });
      return Effect.gen(function* () {
        yield* run;
        expect(out.stdoutText).toBe(stdout);
      });
    });
  });

  describe("feature gate", () => {
    const resolve = (env: Record<string, string>, cwd: string) =>
      withConfigEnv(env, resolveWarehouseEnabled({ args: ["warehouse"], cwd })).pipe(
        Effect.provide(BunServices.layer),
      );

    const withConfig = (config: string) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.makeDirectory(path.join(tempRoot.current, "supabase"), { recursive: true });
        yield* fs.writeFileString(path.join(tempRoot.current, "supabase", "config.toml"), config);
      }).pipe(Effect.provide(BunServices.layer));

    it.effect("is off by default and absent from the tree and completion", () =>
      Effect.gen(function* () {
        expect(yield* resolve({}, tempRoot.current)).toBe(false);
        expect(commandTreeFor(undefined).has("warehouse enable")).toBe(false);
        const completion = respondToComplete(rootCommandForFeatures(), ["__complete", "ware"]);
        expect(completion?.candidates ?? []).toHaveLength(0);
      }),
    );

    it.effect("is on with SUPABASE_EXPERIMENTAL_WAREHOUSE", () =>
      Effect.gen(function* () {
        expect(yield* resolve({ SUPABASE_EXPERIMENTAL_WAREHOUSE: "1" }, tempRoot.current)).toBe(
          true,
        );
        const root = rootCommandForFeatures({ warehouseEnabled: true });
        const completion = respondToComplete(root, ["__complete", "ware"]);
        expect(completion?.candidates).toContainEqual(
          expect.objectContaining({ name: "warehouse" }),
        );
        const tree = commandTreeFor({ warehouseEnabled: true });
        expect(tree.has("warehouse enable")).toBe(true);
        expect(tree.has("warehouse status")).toBe(true);
      }),
    );

    it("marks each mounted leaf with its operation and experimental feature stage", () => {
      const tree = commandTreeFor({ warehouseEnabled: true });
      for (const entry of [enable, status]) {
        const command = tree.get(entry.command.join(" "))?.command;
        if (command === undefined) throw new Error(`${entry.command.join(" ")} is not mounted`);
        expect(Option.map(readApiCommand(command), (api) => api.operationId)).toEqual(
          Option.some(entry.operationId),
        );
        expect(readCommandStage(command)).toEqual(
          Option.some({ status: "experimental", feature: "warehouse" }),
        );
      }
    });

    it.effect("is on with experimental.warehouse in the project config", () =>
      Effect.gen(function* () {
        yield* withConfig("[experimental]\nwarehouse = true\n");
        expect(yield* resolve({}, tempRoot.current)).toBe(true);
      }),
    );

    it.effect("fails with a typed error for an invalid environment value", () =>
      Effect.gen(function* () {
        const error = yield* resolve(
          { SUPABASE_EXPERIMENTAL_WAREHOUSE: "maybe" },
          tempRoot.current,
        ).pipe(Effect.flip);
        expect(error).toBeInstanceOf(ExperimentalFeatureFlagError);
      }),
    );
  });
});

const consentCommand = commandTreeFor({ warehouseEnabled: true }).get("warehouse enable")?.command;

describeHostedConsent("warehouse enable", {
  ...(consentCommand === undefined ? {} : { command: consentCommand }),
  invoke: ({ workdir, yes }) => {
    const { args, sent, run } = execute(["warehouse", "enable", "--schema", "public"], {
      yes,
      route: accepted,
    });
    return {
      run: run.pipe(Effect.provide(cliServices(workdir, args))),
      mutations: () => sent.filter((request) => request.method !== "GET").length,
    };
  },
});
