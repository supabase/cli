import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option } from "effect";

import { mockOutput, mockTty } from "../../../tests/helpers/mocks.ts";
import {
  buildTestRuntime,
  mockCommandCredentialsTracked,
  mockCommandPlatformApi,
  mockCommandSettings,
  mockLinkedProjectCacheTracked,
  mockTelemetryStateTracked,
  useTempWorkdir,
  VALID_REF,
} from "../../../tests/helpers/command-mocks.ts";
import { tracesGet } from "./traces.handler.ts";
import type { TracesFlags } from "./traces.command.ts";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";

function span(overrides: {
  readonly id: string;
  readonly parent_span_id: string | null;
  readonly span_name: string;
  readonly service_name: string;
  readonly start_time: string;
  readonly duration_ns: number;
  readonly status_code?: string;
}) {
  return {
    type: "span" as const,
    id: overrides.id,
    attributes: {
      parent_span_id: overrides.parent_span_id,
      service_name: overrides.service_name,
      span_name: overrides.span_name,
      span_kind: "server",
      status_code: overrides.status_code ?? "ok",
      start_time: overrides.start_time,
      duration_ns: overrides.duration_ns,
    },
  };
}

const SAMPLE_RESPONSE = {
  data: [
    span({
      id: "a1a1a1a1a1a1a1a1",
      parent_span_id: null,
      span_name: "app.request",
      service_name: "kong",
      start_time: "2026-01-01T00:00:00.000Z",
      duration_ns: 350_000_000,
    }),
    span({
      id: "b2b2b2b2b2b2b2b2",
      parent_span_id: "a1a1a1a1a1a1a1a1",
      span_name: "db.query",
      service_name: "postgrest",
      start_time: "2026-01-01T00:00:00.010Z",
      duration_ns: 40_000_000,
    }),
    span({
      id: "c3c3c3c3c3c3c3c3",
      parent_span_id: "a1a1a1a1a1a1a1a1",
      span_name: "auth.verify",
      service_name: "gotrue",
      start_time: "2026-01-01T00:00:00.005Z",
      duration_ns: 12_000_000,
      status_code: "error",
    }),
  ],
  meta: { partial: true as const },
};

const EMPTY_RESPONSE = { data: [], meta: { partial: true as const } };

const tempRoot = useTempWorkdir("supabase-traces-int-");

beforeEach(() => {
  // Neutralize the ambient environment so the TTY-gated rendering tests only react to
  // `mockTty`'s `stdoutIsTty`; see colors.unit.test.ts for the same pattern.
  vi.stubEnv("NO_COLOR", "");
  vi.stubEnv("CLICOLOR", "");
  vi.stubEnv("CLICOLOR_FORCE", "");
  vi.stubEnv("CI", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function flags(overrides: Partial<TracesFlags> = {}): TracesFlags {
  return {
    traceId: Option.some(TRACE_ID),
    remote: Option.none(),
    projectRef: Option.none(),
    ...overrides,
  };
}

interface SetupOpts {
  readonly format?: "text" | "json" | "stream-json";
  readonly response?: { readonly status: number; readonly body: unknown };
  readonly network?: "fail";
  readonly stdoutIsTty?: boolean;
}

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const api = mockCommandPlatformApi({
    response: opts.response ?? { status: 200, body: SAMPLE_RESPONSE },
    network: opts.network,
  });
  const cliSettings = mockCommandSettings({ workdir: tempRoot.current });
  const credentials = mockCommandCredentialsTracked();
  const layer = Layer.mergeAll(
    buildTestRuntime({
      out,
      api,
      cliSettings,
      tty: mockTty({ stdinIsTty: false, stdoutIsTty: opts.stdoutIsTty ?? false }),
    }),
    credentials.layer,
  );
  return { layer, out, api };
}

describe("traces integration", () => {
  it.effect("prints the summary line and span tree in plain text", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* tracesGet(flags());
      expect(out.stdoutText).toContain("Trace 4bf92f35 — 350ms, 3 spans, 1 error, started");
      expect(out.stdoutText).toContain("db.query (postgrest)");
      expect(out.stdoutText).toContain("[error]");
      expect(out.stdoutText).toContain("Trace has errors. First error span: c3c3c3c3");
    }).pipe(Effect.provide(layer));
  });

  it.effect("uses Unicode tree glyphs when stdout is a TTY", () => {
    const { layer, out } = setup({ stdoutIsTty: true });
    return Effect.gen(function* () {
      yield* tracesGet(flags());
      expect(out.stdoutText).toContain("├─ ");
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "emits a structured success payload with error and duration fields via --output-format=json",
    () => {
      const { layer, out } = setup({ format: "json" });
      return Effect.gen(function* () {
        yield* tracesGet(flags());
        const success = out.messages.find((m) => m.type === "success");
        expect(success?.data).toMatchObject({
          trace_id: TRACE_ID,
          span_count: 3,
          duration_ms: 350,
          error_span_ids: ["c3c3c3c3c3c3c3c3"],
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("succeeds even when the trace has error spans", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(tracesGet(flags()).pipe(Effect.provide(layer)));
      expect(Exit.isSuccess(exit)).toBe(true);
    });
  });

  it.effect("fails with a clear message when --trace-id is missing", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        tracesGet(flags({ traceId: Option.none() })).pipe(Effect.provide(layer)),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("Pass --trace-id");
      }
    });
  });

  it.effect(
    "reports an uncertain not-found reason when the response has no spans, without claiming which cause applies",
    () => {
      // The endpoint returns 200 with an empty `data` array when nothing matches a trace id,
      // rather than a 404 — a 404 from this endpoint means the project itself wasn't found.
      const { layer } = setup({ response: { status: 200, body: EMPTY_RESPONSE } });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(tracesGet(flags()).pipe(Effect.provide(layer)));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const causeText = Cause.pretty(exit.cause);
          expect(causeText).toContain("outside retention, sampled out, never ingested");
        }
      });
    },
  );

  it.effect("reports a project-not-found message on a real 404", () => {
    const { layer } = setup({ response: { status: 404, body: { code: "project_not_found" } } });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(tracesGet(flags()).pipe(Effect.provide(layer)));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("project not found");
      }
    });
  });

  it.effect("fails on a network error", () => {
    const { layer } = setup({ network: "fail" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(tracesGet(flags()).pipe(Effect.provide(layer)));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("TracesNetworkError");
      }
    });
  });

  it.effect("hits the GET /v2/projects/{ref}/analytics/traces/{traceId} URL", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* tracesGet(flags());
      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]?.method).toBe("GET");
      expect(api.requests[0]?.url).toContain(
        `/v2/projects/${VALID_REF}/analytics/traces/${TRACE_ID}`,
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("flushes telemetry and writes the linked-project cache on success", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({ response: { status: 200, body: SAMPLE_RESPONSE } });
    const cliSettings = mockCommandSettings({ workdir: tempRoot.current });
    const telemetry = mockTelemetryStateTracked();
    const cache = mockLinkedProjectCacheTracked();
    const credentials = mockCommandCredentialsTracked();
    const layer = Layer.mergeAll(
      buildTestRuntime({
        out,
        api,
        cliSettings,
        telemetry: telemetry.layer,
        linkedProjectCache: cache.layer,
      }),
      credentials.layer,
    );
    return Effect.gen(function* () {
      yield* tracesGet(flags());
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});
