import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import type { OperationOutput } from "@supabase/api/effect";
import { parse as parseYaml } from "yaml";
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
import { ExperimentalFlag, ROOT_GLOBAL_FLAGS } from "../../command-internal/global-flags.ts";
import { HostedMutationConsentRequiredError } from "../../command-internal/hosted-consent/hosted-consent.errors.ts";
import { InvalidOutputFormatError } from "../../command-internal/output-formats.ts";
import { ExperimentalFeatureFlagError } from "../../shared/config/experimental-feature.ts";
import { textCliOutputFormatter } from "../../shared/output/text-formatter.ts";
import type { OutputFormat } from "../../shared/output/types.ts";
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
  mockAnalytics,
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
import { withApiCommands } from "./runtime.ts";
import { standardFailureFor } from "../../shared/cli/standard-errors.ts";
import { EventUpgradeSuggested } from "../../shared/telemetry/event-catalog.ts";
import { resolveApiCommandFeatures } from "./api-command-features.ts";

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
const STATUS_PATH = `/v2/projects/${VALID_REF}/warehouse/status`;
const SETUP_PATH = `/v2/projects/${VALID_REF}/warehouse/setups/current`;
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

const RICH_STATUS = {
  data: {
    type: "warehouse_setup",
    id: SEL,
    attributes: {
      dns: { hostname: "wh.example.test", region: "us-east-1", status: "active" },
      delete_data: false,
      setup_status: "ready",
      pipeline_id: 42,
      steps: [
        { name: "create_pipeline", status: "succeeded" },
        { name: "import_foreign_schema", status: "failed", message: "line one\nline two" },
      ],
      tables: [
        {
          schema: "public",
          name: "orders",
          state: "synced",
          lag_ms: 120,
          last_synced_at: "2026-01-01T00:00:00Z",
          copy_name: '"public"."orders"',
          replication_state: "streaming",
        },
        {
          schema: "public",
          name: "users",
          state: "copying",
          copy_name: '"public"."users"',
          warehouse_size_bytes: 2048,
          replication_state: "copying",
        },
      ],
      fdw_status: {
        extension_available: true,
        extension_installed: true,
        wrapper_installed: false,
        server_configured: false,
        schema_created: false,
        foreign_schema_imported: false,
      },
      status: "succeeded",
      replication_state: "streaming",
    },
  },
};

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
  Command.withSubcommands(withApiCommands([], ["warehouse"])),
  Command.withGlobalFlags(ROOT_GLOBAL_FLAGS),
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
  readonly analytics?: ReturnType<typeof mockAnalytics>;
  /** The Output layer's resolved format; defaults to `text`. */
  readonly outputFormat?: OutputFormat;
  /** Whether stdout is a terminal; defaults to a pipe. */
  readonly stdoutIsTty?: boolean;
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
  const out = mockOutput({ format: opts.outputFormat ?? "text" });
  const { args, sent, run } = execute(argv, opts);
  const layer = Layer.mergeAll(
    buildTestRuntime({
      out,
      api: mockCommandPlatformApi({ response: { status: 200, body: {} } }),
      ...(opts.analytics === undefined ? {} : { analytics: opts.analytics }),
      cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
      tty: mockTty({ stdinIsTty: false, stdoutIsTty: opts.stdoutIsTty ?? false }),
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

const driveClock = <A, E>(fiber: Fiber.Fiber<A, E>) =>
  Effect.raceFirst(Effect.forever(TestClock.adjust("2 seconds")), Fiber.await(fiber));

describe("generated warehouse commands", () => {
  describe("consolidated warehouse status", () => {
    const attributes = {
      project_ref: VALID_REF,
      enabled: true,
      status: "degraded",
      configured_readiness: "not_ready",
      query_connectivity: "not_checked",
      observed_at: "2026-11-17T10:00:00Z",
      compute: {
        status: "available",
        region: "us-east-1",
        routing_status: "ready",
        unavailable_reason: null,
        observed_at: "2026-11-17T10:00:00Z",
      },
      lifecycle: null,
      pipeline: null,
      tables: {
        status: "available",
        unavailable_reason: null,
        observed_at: "2026-11-17T10:00:00Z",
        items: [],
      },
      replication: {
        status: "unavailable",
        unavailable_reason: "observation_unavailable",
        observed_at: null,
        apply_lag: null,
      },
      capabilities: {
        context: true,
        query_explain: false,
        replication_add: false,
        replication_remove: true,
        table_layout_read: true,
        table_layout_update: false,
        table_resync: false,
        workload_metrics: true,
      },
    } satisfies OperationOutput<"v2GetWarehouseStatus">["data"]["attributes"];
    const body = {
      data: {
        type: "warehouse_context",
        id: VALID_REF,
        attributes: { ...attributes, future_field: { retained: true } },
      },
    };

    it.effect.each(["json", "yaml"] as const)(
      "preserves zero targets, capabilities and unavailable observations as %s",
      (format) => {
        const { out, sent, run } = setup(
          ["warehouse", "status", ...(format === "yaml" ? ["-o", "yaml"] : [])],
          { route: ok(body) },
        );
        return Effect.gen(function* () {
          yield* run;
          expect(sent).toEqual([
            {
              method: "GET",
              path: `/v2/projects/${VALID_REF}/warehouse/status`,
              search: "",
              body: undefined,
            },
          ]);
          expect(
            format === "yaml" ? Bun.YAML.parse(out.stdoutText) : decodeJson(out.stdoutText),
          ).toEqual(body);
          expect(out.progressEvents).toEqual([]);
        });
      },
    );

    it.effect("labels configured readiness and unavailable observations in terminal output", () => {
      const { out, run } = setup(["warehouse", "status"], { route: ok(body), stdoutIsTty: true });
      return Effect.gen(function* () {
        yield* run;
        expect(out.stdoutText).toMatch(/Enabled\s+yes/);
        expect(out.stdoutText).toMatch(/Configured readiness\s+not_ready/);
        expect(out.stdoutText).toMatch(/Query connectivity\s+not_checked/);
        expect(out.stdoutText).toMatch(/Status\s+unavailable/);
        expect(out.stdoutText).toMatch(/Unavailable reason\s+observation_unavailable/);
        expect(out.stdoutText).toMatch(/Replication add\s+no/);
        expect(out.stdoutText).toMatch(/Replication remove\s+yes/);
        expect(out.stdoutText).toMatch(/Observed at\s+2026-11-17T10:00:00Z/);
      });
    });

    it.effect("lists every table of a large warehouse in terminal output", () => {
      const items = Array.from({ length: 12 }, (_, index) => ({
        id: 20000 + index,
        schema: "public",
        name: `table_${index}`,
        replication_state: index === 0 ? ("error" as const) : ("following_wal" as const),
        sync_lag:
          index === 1
            ? {
                active: true,
                feedback_age_ms: 5,
                flush_lag_bytes: 2048,
                flush_lag_ms: 120,
                wal_status: "reserved" as const,
                write_lag_ms: 80,
              }
            : null,
      })) satisfies OperationOutput<"v2GetWarehouseStatus">["data"]["attributes"]["tables"]["items"];
      const { out, run } = setup(["warehouse", "status"], {
        route: ok({
          data: {
            ...body.data,
            attributes: { ...attributes, tables: { ...attributes.tables, items } },
          },
        }),
        stdoutIsTty: true,
      });
      return Effect.gen(function* () {
        yield* run;
        expect(out.stdoutText).toMatch(
          /ID\s+20000\n\s+Schema\s+public\n\s+Name\s+table_0\n\s+Replication state\s+error\n/,
        );
        for (const item of items) expect(out.stdoutText).toContain(String(item.id));
        expect(out.stdoutText).not.toContain("omitted");
      });
    });
  });

  describe("warehouse tables list", () => {
    const tablesPath = `/v2/projects/${VALID_REF}/warehouse/tables`;
    const table = (attributes: Readonly<Record<string, unknown>>) => ({
      type: "warehouse_table",
      attributes: { schema: "public", ...attributes, observed_at: "2026-11-17T10:00:00Z" },
    });
    const body = {
      data: [
        {
          id: "16385",
          ...table({
            name: "orders",
            warehouse_name: '"public"."orders"',
            status: "live",
            replication_state: "following_wal",
            lag_ms: 120,
            replication_feedback: {
              source: "pipeline_apply",
              active: true,
              wal_status: "reserved",
              write_lag_ms: 80,
              flush_lag_ms: 120,
              flush_lag_bytes: 2048,
              feedback_age_ms: 5,
            },
          }),
        },
        {
          id: "16402",
          ...table({
            name: "events",
            warehouse_name: '"public"."events"',
            status: "syncing",
            replication_state: "copying_table",
            lag_ms: null,
            replication_feedback: null,
          }),
        },
      ],
    };

    it.effect("lists tables in one row each with replication feedback in a block below", () => {
      const { out, sent, run } = setup(["warehouse", "tables", "list"], {
        route: ok(body),
        stdoutIsTty: true,
      });
      return Effect.gen(function* () {
        yield* run;
        expect(sent).toEqual([{ method: "GET", path: tablesPath, search: "", body: undefined }]);
        expect(out.stdoutText).toMatch(/16385\s.*orders.*live.*following_wal.*120/);
        expect(out.stdoutText).toMatch(/16402\s.*events.*syncing.*copying_table/);
        expect(out.stdoutText).toMatch(/Warehouse table 16385\n[\s\S]*Source\s+pipeline_apply/);
        expect(out.stdoutText).toMatch(/Feedback age ms\s+5/);
        expect(out.stdoutText).toMatch(/Warehouse table 16402\n\s+Replication feedback\s+-\n/);
      });
    });

    it.effect("passes the document, including replication feedback, through as JSON", () => {
      const { out, run } = setup(["warehouse", "tables", "list", "-o", "json"], {
        route: ok(body),
      });
      return Effect.gen(function* () {
        yield* run;
        expect(decodeJson(out.stdoutText)).toEqual(body);
      });
    });
  });
  describe("warehouse inspect query-stats", () => {
    const argv = ["warehouse", "inspect", "query-stats"];
    const attributes = {
      project_ref: VALID_REF,
      metric: "query_duration_p95",
      unit: "seconds",
      aggregation: "p95",
      definition:
        "Executor duration through terminal outcome, including assignment wait and streaming.",
      requested: { metric: "query_duration_p95", start: 1795000000, end: 1795001800 },
      effective: { start: 1795000000, end: 1795001800, step: 60, rate_window_seconds: 300 },
      scrape_interval_seconds: 60,
      last_sample_at: 1795001740,
      availability: "partial",
      series: [
        {
          labels: { method: "DoGet", status: "ok" },
          points: [
            { timestamp: 1795001740, value: 0.2 },
            { timestamp: 1795001800, value: null },
          ],
          coverage: { returned_points: 1, expected_points: 2 },
        },
      ],
    } satisfies OperationOutput<"v2GetWarehouseQueryStats">["data"][number]["attributes"];
    const response = {
      data: [
        {
          type: "warehouse_metric",
          id: "query_duration_p95",
          attributes: { ...attributes, future_observation: { reason: null } },
        },
      ],
    };

    it.effect("shows the last 10 samples of a long series with an omission notice", () => {
      const points = Array.from({ length: 12 }, (_, index) => ({
        timestamp: 1795001000 + index * 60,
        value: 1001 + index,
      }));
      const [first] = response.data;
      const [firstSeries] = attributes.series;
      const { out, run } = setup(argv, {
        route: ok({
          data: [
            {
              ...first,
              attributes: {
                ...first?.attributes,
                series: [
                  {
                    ...firstSeries,
                    points,
                    coverage: { returned_points: 12, expected_points: 12 },
                  },
                ],
              },
            },
          ],
        }),
        stdoutIsTty: true,
      });
      return Effect.gen(function* () {
        yield* run;
        expect(out.stdoutText).toContain(
          "Showing last 10 of 12 samples; 2 omitted; use -o json for all samples.",
        );
        expect(out.stdoutText).not.toContain("1001");
        expect(out.stdoutText).not.toContain("1002");
        expect(out.stdoutText).toContain("1003");
        expect(out.stdoutText).toContain("1012");
      });
    });

    it.effect("forwards a relative range and preserves the full JSON response", () => {
      const { sent, out, run } = setup(
        [
          ...argv,
          "--since",
          "30m",
          "--attributes",
          "query_rate,query_duration_p95",
          "--interval",
          "5m",
          "-o",
          "json",
        ],
        {
          route: ok(response),
          stdoutIsTty: true,
        },
      );
      return Effect.gen(function* () {
        yield* run;
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({
          method: "GET",
          path: `/v2/projects/${VALID_REF}/warehouse/query-stats`,
          body: undefined,
        });
        expect(Object.fromEntries(new URLSearchParams(sent[0]?.search))).toEqual({
          since: "30m",
          attributes: "query_rate,query_duration_p95",
          interval: "5m",
        });
        expect(decodeJson(out.stdoutText)).toEqual(response);
      });
    });

    it.effect("forwards fixed timestamps unchanged and preserves null samples in YAML", () => {
      const from = "2026-11-18T09:30:00+01:00";
      const to = "2026-11-18T10:00:00+01:00";
      const { sent, out, run } = setup([...argv, "--from", from, "--to", to, "-o", "yaml"], {
        route: ok(response),
        stdoutIsTty: true,
      });
      return Effect.gen(function* () {
        yield* run;
        expect(Object.fromEntries(new URLSearchParams(sent[0]?.search))).toEqual({ from, to });
        expect(parseYaml(out.stdoutText)).toEqual(response);
      });
    });

    it.effect.each([
      { name: "terminal default", flags: [], stdoutIsTty: true },
      { name: "explicit text", flags: ["--output-format", "text"], stdoutIsTty: false },
      { name: "pretty alias", flags: ["-o", "pretty"], stdoutIsTty: false },
    ])("shows ranges, dimensions, and sample values with $name", ({ flags, stdoutIsTty }) => {
      const { out, run } = setup([...argv, ...flags], {
        route: ok(response),
        stdoutIsTty,
      });
      return Effect.gen(function* () {
        yield* run;
        expect(out.stdoutText).toContain("query_duration_p95");
        expect(out.stdoutText).toContain("partial");
        expect(out.stdoutText).toMatch(/Requested[\s\S]*1795000000/);
        expect(out.stdoutText).toMatch(/Effective[\s\S]*Rate window seconds\s+300/);
        expect(out.stdoutText).toMatch(/Method\s+DoGet/);
        expect(out.stdoutText).toMatch(/1795001740\s*[|│]?\s*0\.2/);
        expect(out.stdoutText).toMatch(/1795001800\s*[|│]?\s*-/);
        expect(out.stdoutText.trimStart().startsWith("{")).toBe(false);
      });
    });
  });
  describe("warehouse inspect capacity", () => {
    const argv = ["warehouse", "inspect", "capacity"];
    const attributes = {
      project_ref: VALID_REF,
      metric: "activation_duration_p95",
      unit: "seconds",
      aggregation: "p95",
      definition: "Activation duration by kind and result.",
      requested: { metric: "activation_duration_p95", start: 1795000000, end: 1795001800 },
      effective: { start: 1795000000, end: 1795001800, step: 60, rate_window_seconds: 300 },
      scrape_interval_seconds: 60,
      last_sample_at: 1795001740,
      availability: "partial",
      series: [
        {
          labels: { kind: "cold", result: "success" },
          points: [
            { timestamp: 1795001740, value: 0.2 },
            { timestamp: 1795001800, value: null },
          ],
          coverage: { returned_points: 1, expected_points: 2 },
        },
        {
          labels: { kind: "warm", result: "success" },
          points: [{ timestamp: 1795001800, value: 0.01 }],
          coverage: { returned_points: 1, expected_points: 2 },
        },
      ],
    } satisfies OperationOutput<"v2GetWarehouseCapacity">["data"][number]["attributes"];
    const response = {
      data: [
        {
          type: "warehouse_metric",
          id: "activation_duration_p95",
          attributes: { ...attributes, future_observation: { reason: null } },
        },
      ],
    };

    it.effect("leaves default selection to the API and preserves all JSON bytes when piped", () => {
      const { sent, out, run } = setup([...argv, "--since", "30m", "--interval", "5m"], {
        route: ok(response),
      });
      return Effect.gen(function* () {
        yield* run;
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({
          method: "GET",
          path: `/v2/projects/${VALID_REF}/warehouse/capacity`,
          body: undefined,
        });
        expect(Object.fromEntries(new URLSearchParams(sent[0]?.search))).toEqual({
          since: "30m",
          interval: "5m",
        });
        expect(out.stdoutText).toBe(encodeJson(response));
      });
    });

    it.effect(
      "forwards fixed timestamps and metric selection and keeps all dimensions in YAML",
      () => {
        const from = "2026-11-18T09:30:00+01:00";
        const to = "2026-11-18T10:00:00+01:00";
        const selection = "activation_duration_p95,worker_admission_occupied";
        const { sent, out, run } = setup(
          [...argv, "--from", from, "--to", to, "--attributes", selection, "-o", "yaml"],
          { route: ok(response), stdoutIsTty: true },
        );
        return Effect.gen(function* () {
          yield* run;
          expect(sent).toHaveLength(1);
          expect(Object.fromEntries(new URLSearchParams(sent[0]?.search))).toEqual({
            from,
            to,
            attributes: selection,
          });
          expect(parseYaml(out.stdoutText)).toEqual(response);
        });
      },
    );
  });
  describe("warehouse tables get", () => {
    const tablePath = `/v2/projects/${VALID_REF}/warehouse/tables/16385`;
    const body = {
      data: {
        id: "16385",
        type: "warehouse_table",
        attributes: {
          schema: "public",
          name: "orders",
          warehouse_name: '"public"."orders"',
          status: "live",
          replication_state: "following_wal",
          lag_ms: 120,
          observed_at: "2026-11-17T10:00:00Z",
          replication_feedback: {
            source: "pipeline_apply",
            active: true,
            wal_status: "reserved",
            write_lag_ms: 80,
            flush_lag_ms: 120,
            flush_lag_bytes: 2048,
            feedback_age_ms: 5,
          },
        },
      },
    };

    it.effect(
      "requests the table by OID and renders its attributes and replication feedback",
      () => {
        const { out, sent, run } = setup(["warehouse", "tables", "get", "16385"], {
          route: ok(body),
          stdoutIsTty: true,
        });
        return Effect.gen(function* () {
          yield* run;
          expect(sent).toEqual([{ method: "GET", path: tablePath, search: "", body: undefined }]);
          expect(out.stdoutText).toMatch(/Warehouse table/);
          expect(out.stdoutText).toMatch(/Name\s+orders/);
          expect(out.stdoutText).toMatch(/Replication state\s+following_wal/);
          expect(out.stdoutText).toMatch(/Replication feedback\n\s+Source\s+pipeline_apply/);
          expect(out.stdoutText).toMatch(/Flush lag bytes\s+2048/);
        });
      },
    );
  });
  describe("warehouse tables layout get", () => {
    const layoutPath = `/v2/projects/${VALID_REF}/warehouse/tables/16385/layout`;
    const body = {
      data: {
        id: "16385",
        type: "warehouse_table_layout",
        attributes: {
          schema: "public",
          name: "events",
          desired: {
            sort_by: null,
            partition_by: [{ column: "account_id", transform: { kind: "bucket", count: 16 } }],
          },
          observation_status: "observed",
          observed: {
            sort_by: [{ expression: '"created_at"', direction: "DESC", nulls: "NULLS_LAST" }],
            partition_by: [{ column: "account_id", transform: "bucket(16)" }],
            observed_at: "2026-11-18T09:30:00.123456Z",
          },
        },
      },
    };

    it.effect("renders unmanaged desired sorting beside the observed catalog layout", () => {
      const { out, sent, run } = setup(["warehouse", "tables", "layout", "get", "16385"], {
        route: ok(body),
        stdoutIsTty: true,
      });
      return Effect.gen(function* () {
        yield* run;
        expect(sent).toEqual([{ method: "GET", path: layoutPath, search: "", body: undefined }]);
        expect(out.stdoutText).toMatch(/^Warehouse table layout\n/);
        expect(out.stdoutText).toMatch(/Desired\n\s+Sort by\s+-\n/);
        expect(out.stdoutText).toMatch(/Column\s+account_id[\s\S]*Kind\s+bucket[\s\S]*Count\s+16/);
        expect(out.stdoutText).toMatch(/Observation status\s+observed/);
        expect(out.stdoutText).toMatch(/account_id \| bucket\(16\)/);
        expect(out.stdoutText).toMatch(/Observed at\s+2026-11-18T09:30:00\.123456Z/);
      });
    });
  });
  describe("warehouse tables layout update", () => {
    const argv = ["warehouse", "tables", "layout", "update", "16385"];
    const layoutPath = `/v2/projects/${VALID_REF}/warehouse/tables/16385/layout`;
    const body = {
      data: {
        type: "warehouse_table_layout",
        attributes: { sort_by: { kind: "primary_key" }, partition_by: [] },
      },
    };

    it.effect.each([
      { flags: [], reset: {} },
      { flags: ["--reset-table"], reset: { reset_table: true } },
      { flags: ["--reset-table", "false"], reset: { reset_table: false } },
    ])(
      "sends a layout file with reset option $flags and prints the full API response",
      ({ flags, reset }) => {
        const response = {
          data: {
            type: "warehouse_table_layout",
            id: "16385",
            attributes: {
              pipeline_id: "pipeline-1",
              schema: "public",
              name: "events",
              desired: body.data.attributes,
              application_status: "waiting_for_start",
              reset_table: reset.reset_table ?? false,
              observation_status: "not_requested",
              observed: null,
              future_state: { reason: null },
            },
          },
        };
        const file = `${tempRoot.current}/layout.json`;
        const { sent, out, run } = setup([...argv, "--file", file, ...flags], {
          yes: true,
          route: () => ({ status: 202, body: response }),
        });
        return Effect.gen(function* () {
          yield* (yield* FileSystem.FileSystem).writeFileString(file, encodeJson(body));
          yield* run;
          expect(sent).toEqual([
            {
              method: "PATCH",
              path: layoutPath,
              search: "",
              body: { data: { ...body.data, attributes: { ...body.data.attributes, ...reset } } },
            },
          ]);
          expect(decodeJson(out.stdoutText)).toEqual(response);
        }).pipe(Effect.provide(BunServices.layer));
      },
    );

    it.effect(
      "previews unmanaged sorting while preserving omitted settings without sending a request",
      () => {
        const clear = { data: { type: "warehouse_table_layout", attributes: { sort_by: null } } };
        const { sent, out, run } = setup([...argv, "--body", encodeJson(clear), "--dry-run"], {
          route: accepted,
        });
        return Effect.gen(function* () {
          yield* run;
          expect(sent).toEqual([]);
          expect(decodeJson(out.stdoutText)).toEqual({
            method: "PATCH",
            path: layoutPath,
            query: {},
            headers: {},
            body: clear,
          });
        });
      },
    );

    it.effect("rejects a non-boolean reset before making a hosted request", () => {
      const reset = {
        data: { type: "warehouse_table_layout", attributes: { reset_table: "true" } },
      };
      const { sent, run } = setup([...argv, "--body", encodeJson(reset)], {
        yes: true,
        route: accepted,
      });
      return Effect.gen(function* () {
        expect(failureOf(yield* Effect.exit(run))).toBeInstanceOf(ApiCommandUsageError);
        expect(sent).toEqual([]);
      });
    });
  });
  describe("warehouse connection", () => {
    const connectionPath = `/v2/projects/${VALID_REF}/warehouse/connection`;
    const host = `${VALID_REF}.warehouse.example.invalid`;
    const connection = (attributes: Readonly<Record<string, unknown>>) => ({
      data: {
        type: "warehouse_connection",
        id: VALID_REF,
        attributes: {
          project_ref: VALID_REF,
          observed_at: "2026-11-17T10:00:00Z",
          protocol: "arrow_flight_sql",
          tls_required: true,
          authentication: {
            method: "database_username_password",
            credential_source: "source_project_database",
            default_username: "postgres",
            password_guidance:
              "Use the same password as this role in the source Supabase database. For postgres, use the project's database password.",
            required_membership: "supabase_warehouse_reader",
          },
          access_mode: "read_only",
          query_connectivity: "not_checked",
          ...attributes,
        },
      },
    });

    it.effect("prints the endpoint and source database login guidance from a single read", () => {
      const body = connection({
        status: "available",
        unavailable_reason: null,
        endpoint: `grpc+tls://${host}:443`,
        host,
        port: 443,
        region: "eu-central-1",
        routing_status: "ready",
      });
      const { out, sent, run } = setup(["warehouse", "connection"], {
        route: ok(body),
        stdoutIsTty: true,
      });
      return Effect.gen(function* () {
        yield* run;
        expect(sent).toEqual([
          { method: "GET", path: connectionPath, search: "", body: undefined },
        ]);
        expect(out.stdoutText).toMatch(/^Warehouse connection$/m);
        expect(out.stdoutText).toMatch(/Status\s+available/);
        expect(out.stdoutText).toContain(`grpc+tls://${host}:443`);
        expect(out.stdoutText).toMatch(/TLS required\s+yes/);
        expect(out.stdoutText).toMatch(/Default username\s+postgres/);
        expect(out.stdoutText).toMatch(/Password guidance\s+Use the same password as this role/);
        expect(out.stdoutText).toMatch(/Required membership\s+supabase_warehouse_reader/);
        expect(out.stdoutText).toMatch(/Query connectivity\s+not_checked/);
      });
    });

    it.effect("shows no connection string for an unconfigured Warehouse", () => {
      const body = connection({
        status: "not_configured",
        unavailable_reason: null,
        endpoint: null,
        host: null,
        port: null,
        region: null,
        routing_status: null,
      });
      const { out, run } = setup(["warehouse", "connection"], {
        route: ok(body),
        stdoutIsTty: true,
      });
      return Effect.gen(function* () {
        yield* run;
        expect(out.stdoutText).toMatch(/Status\s+not_configured/);
        expect(out.stdoutText).toMatch(/Endpoint\s+-$/m);
        expect(out.stdoutText).toMatch(/Host\s+-$/m);
        expect(out.stdoutText).not.toMatch(/grpc\+tls|flightsql:/);
      });
    });
  });
  describe("warehouse disable", () => {
    const operationId = "7579647f-2cdc-466c-982e-425958a2f985";
    const disablePath = `/v2/projects/${VALID_REF}/warehouse`;
    const teardownPath = `${disablePath}/teardowns/current`;
    const teardown = (lifecycleStatus: string, deleteData = false) => ({
      data: {
        type: "warehouse_teardown",
        id: operationId,
        attributes: {
          lifecycle_status: lifecycleStatus,
          delete_data: deleteData,
          updated_at: "2026-11-17T10:00:00Z",
          cleanup_error: null,
          unknown_observation: null,
        },
      },
    });

    it.effect.each([false, true])(
      "keeps retention as the default and sends explicit deletion=%s",
      (deleteData) => {
        const body = teardown("disabling", deleteData);
        const { sent, out, run } = setup(
          ["warehouse", "disable", ...(deleteData ? ["--delete-data"] : [])],
          {
            yes: true,
            route: () => ({ status: 202, body }),
          },
        );
        return Effect.gen(function* () {
          yield* run;
          expect(sent).toStrictEqual([
            {
              method: "DELETE",
              path: disablePath,
              search: deleteData ? "delete_data=true" : "",
              body: undefined,
            },
          ]);
          expect(out.stdoutText).toBe(encodeJson(body));
        });
      },
    );

    it.effect("previews permanent deletion without consent or a command request", () => {
      const { sent, out, run } = setup(["warehouse", "disable", "--delete-data", "--dry-run"], {
        route: accepted,
      });
      return Effect.gen(function* () {
        yield* run;
        expect(sent).toEqual([]);
        expect(decodeJson(out.stdoutText)).toMatchObject({
          method: "DELETE",
          path: disablePath,
          query: { delete_data: true },
        });
      });
    });

    it.effect("waits on the accepted cleanup identity and prints the final raw resource", () => {
      const final = teardown("disabled");
      const { sent, out, run } = setup(["warehouse", "disable", "--wait"], {
        yes: true,
        route: (request) =>
          request.method === "DELETE"
            ? { status: 202, body: teardown("disabling") }
            : { status: 200, body: final },
      });
      return Effect.gen(function* () {
        yield* run;
        expect(sent.map(({ method, path, search }) => ({ method, path, search }))).toStrictEqual([
          { method: "DELETE", path: disablePath, search: "" },
          { method: "GET", path: teardownPath, search: `operation_id=${operationId}` },
        ]);
        expect(out.stdoutText).toBe(encodeJson(final));
      });
    });

    it.effect.each([undefined, operationId])(
      "reads cleanup without mutation consent using optional operation identity %s",
      (requestedId) => {
        const body = teardown("disabling");
        const { sent, out, run } = setup(
          [
            "warehouse",
            "teardowns",
            "get",
            ...(requestedId === undefined ? [] : ["--operation-id", requestedId]),
          ],
          { route: () => ({ status: 200, body }) },
        );
        return Effect.gen(function* () {
          yield* run;
          expect(sent).toStrictEqual([
            {
              method: "GET",
              path: teardownPath,
              search: requestedId === undefined ? "" : `operation_id=${requestedId}`,
              body: undefined,
            },
          ]);
          expect(out.stdoutText).toBe(encodeJson(body));
        });
      },
    );

    it.effect("waits for the current cleanup without an operation identity", () => {
      const final = teardown("disabled");
      let reads = 0;
      const { sent, out, run } = setup(["warehouse", "teardowns", "get", "--wait"], {
        route: () => ({
          status: 200,
          body: reads++ === 0 ? teardown("disabling") : final,
        }),
      });
      return Effect.gen(function* () {
        const fiber = yield* run.pipe(Effect.forkChild({ startImmediately: true }));
        yield* driveClock(fiber);
        yield* Fiber.join(fiber);
        expect(sent.map(({ method, path, search }) => ({ method, path, search }))).toStrictEqual([
          { method: "GET", path: teardownPath, search: "" },
          { method: "GET", path: teardownPath, search: "" },
        ]);
        expect(out.stdoutText).toBe(encodeJson(final));
      });
    });

    it.effect("preserves partial cleanup failure and the command for inspecting it", () => {
      const failed = teardown("deletion_failed", true);
      const { run } = setup(["warehouse", "disable", "--delete-data", "--wait"], {
        yes: true,
        route: (request) => ({ status: request.method === "DELETE" ? 202 : 200, body: failed }),
      });
      return Effect.gen(function* () {
        const error = yield* run.pipe(Effect.flip);
        expect(standardFailureFor(Cause.fail(error)).document).toMatchObject({
          code: "operation_failed",
          context: { status: "deletion_failed" },
          hint: expect.stringContaining(`--operation-id ${operationId}`),
        });
      });
    });

    it.effect("reports the last cleanup state on a bounded timeout", () => {
      const { run, sent } = setup(["warehouse", "disable", "--wait", "--timeout", "10s"], {
        yes: true,
        route: (request) => ({
          status: request.method === "DELETE" ? 202 : 200,
          body: teardown("disabling"),
        }),
      });
      return Effect.gen(function* () {
        const fiber = yield* run.pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
        yield* driveClock(fiber);
        const error = yield* Fiber.join(fiber);
        expect(standardFailureFor(Cause.fail(error)).document).toMatchObject({
          code: "wait_timeout",
          context: { timeout_ms: 10000, last_status: "disabling" },
          message: expect.stringContaining("disabling"),
          hint: expect.stringContaining(`--operation-id ${operationId}`),
        });
        expect(sent.filter((request) => request.method === "DELETE")).toHaveLength(1);
      });
    });
  });

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
      const { out, run } = setup(["warehouse", "status", "--dry-run"], {
        route: ok({}),
      });
      return Effect.gen(function* () {
        yield* run;
        expect(decodeJson(out.stdoutText)).toEqual({
          method: "GET",
          path: STATUS_PATH,
          query: {},
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

    it.effect("reports a plan-gated 403 with its entitlement in the document and telemetry", () => {
      const analytics = mockAnalytics();
      const planGate = {
        error: {
          code: "entitlement_required",
          feature: "warehouse",
          upgrade_url: "https://supabase.com/dashboard/org/acme/billing",
        },
      };
      const { run } = setup(["warehouse", "enable", "--schema", "public"], {
        yes: true,
        route: () => ({ status: 403, body: planGate }),
        analytics,
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(run);
        expect(Exit.isFailure(exit) && standardFailureFor(exit.cause).document).toMatchObject({
          code: "forbidden",
          status: 403,
          hint: null,
          entitlement: {
            feature: "warehouse",
            upgrade_url: "https://supabase.com/dashboard/org/acme/billing",
          },
        });
        expect(analytics.captured.find((c) => c.event === EventUpgradeSuggested)).toMatchObject({
          properties: { feature_key: "warehouse", org_slug: "acme" },
        });
      });
    });

    it.effect.each([
      { name: "a 403 without the plan-gate code", status: 403, body: { message: "Forbidden" } },
      {
        name: "a 5xx carrying a plan-gate body",
        status: 503,
        body: {
          error: {
            code: "entitlement_required",
            feature: "warehouse",
            upgrade_url: "https://supabase.com/dashboard/org/acme/billing",
          },
        },
      },
    ])("reports no entitlement for $name", ({ status, body }) => {
      const analytics = mockAnalytics();
      const { run } = setup(["warehouse", "enable", "--schema", "public"], {
        yes: true,
        route: () => ({ status, body }),
        analytics,
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(run);
        expect(Exit.isFailure(exit) && standardFailureFor(exit.cause).document).not.toHaveProperty(
          "entitlement",
        );
        expect(analytics.captured.some((c) => c.event === EventUpgradeSuggested)).toBe(false);
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
  });

  describe("help", () => {
    it.effect("shows a body file in the layout update example", () => {
      const { console, calls } = fakeConsole();
      const { run } = setup(["warehouse", "tables", "layout", "update", "--help"], {
        route: accepted,
      });
      return Effect.gen(function* () {
        yield* run.pipe(Effect.provideService(Console.Console, console));
        expect(calls.join("\n")).toContain(
          "supabase warehouse tables layout update <table-id> --file <path>",
        );
      });
    });

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
        expect(gets.every((request) => request.path === SETUP_PATH)).toBe(true);
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

    it.effect(
      "points a failed or timed-out wait at warehouse status without exposing the internal setup read",
      () => {
        const failing = setup(["warehouse", "enable", "--schema", "public", "--wait"], {
          yes: true,
          route: enableThenPoll([{ status: 200, body: statusBody("failed", "boom") }]),
        });
        const stalling = setup(
          ["warehouse", "enable", "--schema", "public", "--wait", "--timeout", "10s"],
          { yes: true, route: enableThenPoll([{ status: 200, body: statusBody("pending") }]) },
        );
        const hint = `Check it with \`supabase warehouse status --remote=${VALID_REF}\`.`;
        return Effect.gen(function* () {
          for (const { run } of [failing, stalling]) {
            const fiber = yield* run.pipe(
              Effect.flip,
              Effect.forkChild({ startImmediately: true }),
            );
            yield* driveClock(fiber);
            expect(yield* Fiber.join(fiber)).toMatchObject({
              hint,
            });
          }
        });
      },
    );

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

  describe("text output", () => {
    const STATUS_TEXT =
      [
        "Warehouse setup",
        `  ID                 ${SEL}`,
        "  DNS",
        "    Hostname  wh.example.test",
        "    Region    us-east-1",
        "    Status    active",
        "  Delete data        no",
        "  Setup status       ready",
        "  Pipeline ID        42",
        "  Steps",
        "     NAME                  | STATUS    | MESSAGE            ",
        "    -----------------------|-----------|--------------------",
        "     create_pipeline       | succeeded | -                  ",
        "     import_foreign_schema | failed    | line one\\nline two ",
        "  Tables",
        "     SCHEMA | NAME   | STATE   | LAG MS | LAST SYNCED AT       | COPY NAME         | REPLICATION STATE | WAREHOUSE SIZE BYTES ",
        "    --------|--------|---------|--------|----------------------|-------------------|-------------------|----------------------",
        '     public | orders | synced  | 120    | 2026-01-01T00:00:00Z | "public"."orders" | streaming         | -                    ',
        '     public | users  | copying | -      | -                    | "public"."users"  | copying           | 2048                 ',
        "  FDW status",
        "    Extension available      yes",
        "    Extension installed      yes",
        "    Wrapper installed        no",
        "    Server configured        no",
        "    Schema created           no",
        "    Foreign schema imported  no",
        "  Status             succeeded",
        "  Replication state  streaming",
      ].join("\n") + "\n";

    it.effect("renders the status as text on a terminal by default", () => {
      const { out, run } = setup(["warehouse", "enable", "--schema", "public", "--wait"], {
        yes: true,
        route: enableThenPoll([{ status: 200, body: RICH_STATUS }]),
        stdoutIsTty: true,
      });
      return Effect.gen(function* () {
        yield* run;
        expect(out.stdoutText).toBe(STATUS_TEXT);
      });
    });

    it.effect("keeps the API bytes by default when stdout is piped", () => {
      const { out, run } = setup(["warehouse", "enable", "--schema", "public", "--wait"], {
        yes: true,
        route: enableThenPoll([{ status: 200, body: RICH_STATUS }]),
      });
      return Effect.gen(function* () {
        yield* run;
        expect(out.stdoutText).toBe(encodeJson(RICH_STATUS));
      });
    });

    it.effect("renders text through a pipe when --output-format text is explicit", () => {
      const { out, run } = setup(
        ["warehouse", "enable", "--schema", "public", "--wait", "--output-format", "text"],
        {
          yes: true,
          route: enableThenPoll([{ status: 200, body: RICH_STATUS }]),
        },
      );
      return Effect.gen(function* () {
        yield* run;
        expect(out.stdoutText).toBe(STATUS_TEXT);
      });
    });

    it.effect(
      "prints only the text rendering for -o pretty under --output-format stream-json",
      () => {
        const { out, run } = setup(
          [
            "warehouse",
            "enable",
            "--schema",
            "public",
            "--wait",
            "-o",
            "pretty",
            "--output-format",
            "stream-json",
          ],
          {
            yes: true,
            route: enableThenPoll([{ status: 200, body: RICH_STATUS }]),
            outputFormat: "stream-json",
            stdoutIsTty: true,
          },
        );
        return Effect.gen(function* () {
          yield* run;
          expect(out.stdoutText).toBe(STATUS_TEXT);
          expect(out.progressEvents).toEqual([]);
        });
      },
    );

    it.effect("keeps the API bytes for -o json on a terminal", () => {
      const { out, run } = setup(
        ["warehouse", "enable", "--schema", "public", "--wait", "-o", "json"],
        {
          yes: true,
          route: enableThenPoll([{ status: 200, body: RICH_STATUS }]),
          stdoutIsTty: true,
        },
      );
      return Effect.gen(function* () {
        yield* run;
        expect(out.stdoutText).toBe(encodeJson(RICH_STATUS));
      });
    });

    it.effect("shows the request as one task that is cleared when it succeeds", () => {
      const { out, run } = setup(["warehouse", "status"], {
        route: ok(RICH_STATUS),
        stdoutIsTty: true,
      });
      return Effect.gen(function* () {
        yield* run;
        expect(out.progressEvents).toEqual([
          { type: "start", message: "Get consolidated Warehouse status and capabilities" },
        ]);
        expect(out.taskSettlements).toEqual([{ type: "clear" }]);
      });
    });

    it.effect("prints the final status as text and tracks the wait in one polling task", () => {
      const { out, run } = setup(["warehouse", "enable", "--schema", "public", "--wait"], {
        yes: true,
        stdoutIsTty: true,
        route: enableThenPoll([
          { status: 200, body: statusBody("pending") },
          { status: 200, body: statusBody("succeeded") },
        ]),
      });
      return Effect.gen(function* () {
        const fiber = yield* run.pipe(Effect.forkChild({ startImmediately: true }));
        yield* driveClock(fiber);
        yield* Fiber.join(fiber);
        expect(out.stdoutText).toBe(
          ["Warehouse setup", `  Selection ID  ${SEL}`, "  Status        succeeded", ""].join("\n"),
        );
        const polling = "Get Warehouse initial synchronization status";
        expect(out.progressEvents).toEqual([
          { type: "start", message: "Enable Warehouse replication" },
          { type: "start", message: polling },
          { type: "message", message: `${polling} (status: pending)` },
          { type: "message", message: `${polling} (status: succeeded)` },
        ]);
        expect(out.taskSettlements).toEqual([{ type: "clear" }, { type: "clear" }]);
      });
    });

    it.effect("fails the polling task and keeps the standard error when the setup fails", () => {
      const { out, run } = setup(["warehouse", "enable", "--schema", "public", "--wait"], {
        yes: true,
        stdoutIsTty: true,
        route: enableThenPoll([{ status: 200, body: statusBody("failed", "pipeline crashed") }]),
      });
      return Effect.gen(function* () {
        const fiber = yield* run.pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
        yield* driveClock(fiber);
        const failure = yield* Fiber.join(fiber);
        expect(failure).toBeInstanceOf(ApiCommandOperationFailedError);
        expect(failure).toMatchObject({ message: expect.stringContaining("pipeline crashed") });
        expect(out.stdoutText).toBe("");
        expect(out.taskSettlements).toEqual([{ type: "clear" }, { type: "fail" }]);
      });
    });

    it.effect("cancels the polling task when the run is interrupted mid-wait", () => {
      const { out, run } = setup(["warehouse", "enable", "--schema", "public", "--wait"], {
        yes: true,
        stdoutIsTty: true,
        route: enableThenPoll([{ status: 200, body: statusBody("pending") }]),
      });
      return Effect.gen(function* () {
        const fiber = yield* run.pipe(Effect.forkChild({ startImmediately: true }));
        yield* TestClock.adjust("2 seconds").pipe(
          Effect.andThen(Effect.yieldNow),
          Effect.repeat({ until: () => out.progressEvents.some((e) => e.type === "message") }),
        );
        yield* Fiber.interrupt(fiber);
        expect(out.stdoutText).toBe("");
        expect(out.taskSettlements).toEqual([{ type: "clear" }, { type: "cancel" }]);
      });
    });

    it.effect("prints the dry run as text with its query values", () => {
      const { out, sent, run } = setup(
        [
          "warehouse",
          "teardowns",
          "get",
          "--operation-id",
          "7579647f-2cdc-466c-982e-425958a2f985",
          "--dry-run",
          "--output-format",
          "text",
        ],
        { route: ok({}) },
      );
      return Effect.gen(function* () {
        yield* run;
        expect(sent).toEqual([]);
        expect(out.stdoutText).toBe(
          [
            `Dry run: GET /v2/projects/${VALID_REF}/warehouse/teardowns/current`,
            "Query",
            "  operation_id  7579647f-2cdc-466c-982e-425958a2f985",
            "",
          ].join("\n"),
        );
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
        Command.withSubcommands(
          withApiCommands([], ["warehouse"], {
            nouns: { fixture: { description: "Fixture commands", feature: "warehouse" } },
            entries: [entry],
          }),
        ),
        Command.withGlobalFlags(ROOT_GLOBAL_FLAGS),
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
    const resolve = (
      env: Record<string, string>,
      cwd: string,
      args: ReadonlyArray<string> = ["warehouse"],
    ) =>
      withConfigEnv(env, resolveApiCommandFeatures({ args, cwd })).pipe(
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
        expect(yield* resolve({}, tempRoot.current)).toEqual([]);
        expect(commandTreeFor(undefined).has("warehouse enable")).toBe(false);
        const completion = respondToComplete(rootCommandForFeatures(), ["__complete", "ware"]);
        expect(completion?.candidates ?? []).toHaveLength(0);
      }),
    );

    it.effect("is on with SUPABASE_EXPERIMENTAL_WAREHOUSE", () =>
      Effect.gen(function* () {
        expect(yield* resolve({ SUPABASE_EXPERIMENTAL_WAREHOUSE: "1" }, tempRoot.current)).toEqual([
          "warehouse",
        ]);
        const root = rootCommandForFeatures({ apiFeatures: ["warehouse"] });
        const completion = respondToComplete(root, ["__complete", "ware"]);
        expect(completion?.candidates).toContainEqual(
          expect.objectContaining({ name: "warehouse" }),
        );
        const tree = commandTreeFor({ apiFeatures: ["warehouse"] });
        expect(tree.has("warehouse enable")).toBe(true);
        expect(tree.has("warehouse setups get")).toBe(false);
        expect(tree.has("warehouse status")).toBe(true);
      }),
    );

    it("marks each mounted leaf with its operation and experimental feature stage", () => {
      const tree = commandTreeFor({ apiFeatures: ["warehouse"] });
      for (const entry of apiCommands) {
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
        expect(yield* resolve({}, tempRoot.current)).toEqual(["warehouse"]);
      }),
    );

    it.effect.each([
      { name: "root help", args: [], features: ["warehouse"] },
      {
        name: "shell completion of the group",
        args: ["__complete", "ware"],
        features: ["warehouse"],
      },
      { name: "inspection parent help", args: ["inspect"], features: [] },
      {
        name: "Warehouse inspection",
        args: ["warehouse", "inspect", "query-stats"],
        features: ["warehouse"],
      },
      {
        name: "Warehouse capacity inspection",
        args: ["warehouse", "inspect", "capacity"],
        features: ["warehouse"],
      },
      { name: "database inspection", args: ["inspect", "db", "table-stats"], features: [] },
      { name: "inspection report", args: ["inspect", "report"], features: [] },
      {
        name: "inspection completion",
        args: ["__complete", "inspect", ""],
        features: [],
      },
      {
        name: "database inspection completion",
        args: ["__complete", "inspect", "db", ""],
        features: [],
      },
      { name: "a command of another group", args: ["projects", "list"], features: [] },
      { name: "completion of another group", args: ["__complete", "projects", ""], features: [] },
      { name: "the root version flag", args: ["--version"], features: [] },
    ])("resolves $name by whether it can reach the group", ({ args, features }) =>
      Effect.gen(function* () {
        const env = { SUPABASE_EXPERIMENTAL_WAREHOUSE: "1" };
        expect(yield* resolve(env, tempRoot.current, args)).toEqual(features);
      }),
    );

    it.effect("ignores an invalid value when the invocation cannot reach the group", () =>
      Effect.gen(function* () {
        const env = { SUPABASE_EXPERIMENTAL_WAREHOUSE: "maybe" };
        expect(yield* resolve(env, tempRoot.current, ["projects", "list"])).toEqual([]);
        expect(yield* resolve(env, tempRoot.current, ["inspect"])).toEqual([]);
        expect(yield* resolve(env, tempRoot.current, ["inspect", "db", "table-stats"])).toEqual([]);
        expect(yield* resolve(env, tempRoot.current, ["inspect", "report"])).toEqual([]);
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

const consentCommand = commandTreeFor({ apiFeatures: ["warehouse"] }).get(
  "warehouse enable",
)?.command;

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

const disableConsentCommand = commandTreeFor({ apiFeatures: ["warehouse"] }).get(
  "warehouse disable",
)?.command;
describeHostedConsent("warehouse disable", {
  ...(disableConsentCommand === undefined ? {} : { command: disableConsentCommand }),
  invoke: ({ workdir, yes }) => {
    const { args, sent, run } = execute(["warehouse", "disable"], { yes, route: accepted });
    return {
      run: run.pipe(Effect.provide(cliServices(workdir, args))),
      mutations: () => sent.filter((request) => request.method !== "GET").length,
    };
  },
});

const layoutUpdateConsentCommand = commandTreeFor({ apiFeatures: ["warehouse"] }).get(
  "warehouse tables layout update",
)?.command;
describeHostedConsent("warehouse tables layout update", {
  ...(layoutUpdateConsentCommand === undefined ? {} : { command: layoutUpdateConsentCommand }),
  invoke: ({ workdir, yes }) => {
    const body = { data: { type: "warehouse_table_layout", attributes: { sort_by: null } } };
    const { args, sent, run } = execute(
      ["warehouse", "tables", "layout", "update", "16385", "--body", encodeJson(body)],
      { yes, route: accepted },
    );
    return {
      run: run.pipe(Effect.provide(cliServices(workdir, args))),
      mutations: () => sent.filter((request) => request.method !== "GET").length,
    };
  },
});
