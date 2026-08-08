import { Effect, Exit, Layer } from "effect";
import { it } from "@effect/vitest";
import { describe, expect } from "vitest";

import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import { LegacyDebugLogger } from "../../../shared/legacy-debug-logger.service.ts";
import type { LegacyPgDeltaNextDiagnostic } from "./legacy-pgdelta-next-adapter.service.ts";
import {
  legacyPgDeltaNextDiagnosticMessage,
  legacyPgDeltaNextDiagnosticReport,
  legacyPgDeltaNextFeedbackInvitation,
  legacyReportPgDeltaNextDiagnostics,
} from "./legacy-pgdelta-next-diagnostics.ts";

const unmodeled = (
  kind: unknown,
  overrides: Partial<LegacyPgDeltaNextDiagnostic> = {},
): LegacyPgDeltaNextDiagnostic => ({
  origin: "desired",
  code: "unmodeled_kind",
  severity: "warning",
  subject: "object:public.unsupported",
  message: "object kind is not modeled",
  context: { kind },
  ...overrides,
});

const debugLayer = (messages: string[]) =>
  Layer.succeed(LegacyDebugLogger, {
    debug: (message) => Effect.sync(() => messages.push(message)),
    http: () => Effect.void,
  });

describe("pg-delta next diagnostic coverage policy", () => {
  it("summarizes unmodeled kinds and routes nonfatal diagnostic detail to debug", () => {
    const out = mockOutput();
    const debugMessages: string[] = [];
    return Effect.gen(function* () {
      yield* legacyReportPgDeltaNextDiagnostics(
        "diff",
        [
          unmodeled("text search configuration"),
          unmodeled("statistics object"),
          {
            origin: "source",
            code: "dangling_edge",
            severity: "warning",
            subject: "role:postgres",
            message: "edge references a fact not in the base",
          },
          {
            origin: "declarativeLoad",
            code: "invalid_routine_body",
            severity: "warning",
            message: "routine body failed validation",
          },
          {
            origin: "snapshot",
            code: "unresolved_security_label",
            severity: "warning",
            message: "provider was not resolved",
          },
        ],
        false,
      );

      expect(out.messages.filter(({ type }) => type === "warn")).toHaveLength(1);
      expect(out.messages).toContainEqual({
        type: "warn",
        message:
          "pg-delta does not manage these PostgreSQL object kinds: statistics object, text search configuration. Changes to these objects are omitted from the generated database diff.",
      });
      expect(out.messages.some(({ message }) => message.includes("dangling_edge"))).toBe(false);
      expect(out.messages.some(({ message }) => message.includes("invalid_routine_body"))).toBe(
        false,
      );
      expect(
        out.messages.some(({ message }) => message.includes("unresolved_security_label")),
      ).toBe(false);
      expect(debugMessages).toHaveLength(5);
      expect(debugMessages).toContain(
        "pg-delta next diagnostic: origin=source code=dangling_edge subject=role:postgres message=edge references a fact not in the base",
      );
      const invitations = out.messages.filter(({ message }) =>
        message.startsWith("Request pg-delta support:"),
      );
      expect(invitations).toHaveLength(1);
      expect(invitations[0]?.message).toContain("statistics object, text search configuration");
    }).pipe(Effect.provide(out.layer), Effect.provide(debugLayer(debugMessages)));
  });

  it("renders coverage diagnostics and then fails in strict mode", () => {
    const out = mockOutput();
    const debugMessages: string[] = [];
    return Effect.gen(function* () {
      const exit = yield* legacyReportPgDeltaNextDiagnostics(
        "declarativePlan",
        [unmodeled("text search configuration")],
        true,
      ).pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(out.messages).toContainEqual({
        type: "warn",
        message:
          "pg-delta next diagnostic: origin=desired code=unmodeled_kind subject=object:public.unsupported message=object kind is not modeled",
      });
      expect(out.messages).toContainEqual({
        type: "warn",
        message:
          "pg-delta does not manage these PostgreSQL object kinds: text search configuration. Strict coverage is enabled, so the operation will stop.",
      });
      expect(debugMessages).toEqual([]);
      expect(out.messages.some(({ message }) => message.includes("supabase issue feature"))).toBe(
        true,
      );
    }).pipe(Effect.provide(out.layer), Effect.provide(debugLayer(debugMessages)));
  });

  it("can suppress a repeated feedback invitation without suppressing warnings", () => {
    const out = mockOutput();
    const debugMessages: string[] = [];
    return Effect.gen(function* () {
      yield* legacyReportPgDeltaNextDiagnostics(
        "declarativePlan",
        [unmodeled("text search configuration")],
        false,
        false,
      );

      expect(out.messages.some(({ message }) => message.includes("supabase issue feature"))).toBe(
        false,
      );
      expect(out.messages.some(({ type }) => type === "warn")).toBe(true);
    }).pipe(Effect.provide(out.layer), Effect.provide(debugLayer(debugMessages)));
  });

  it("always renders and fails error diagnostics", () => {
    const out = mockOutput();
    const debugMessages: string[] = [];
    return Effect.gen(function* () {
      const exit = yield* legacyReportPgDeltaNextDiagnostics(
        "declarativeExport",
        [
          {
            origin: "export",
            code: "extraction_failed",
            severity: "error",
            message: "catalog query failed",
          },
        ],
        false,
      ).pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(out.messages).toContainEqual({
        type: "error",
        message:
          "pg-delta next diagnostic: origin=export code=extraction_failed message=catalog query failed",
      });
    }).pipe(Effect.provide(out.layer), Effect.provide(debugLayer(debugMessages)));
  });

  it("renders every diagnostic with full detail when pg-delta debug is enabled", () => {
    const out = mockOutput();
    const debugMessages: string[] = [];
    return Effect.gen(function* () {
      yield* legacyReportPgDeltaNextDiagnostics(
        "diff",
        [
          {
            origin: "source",
            code: "dangling_edge",
            severity: "warning",
            subject: "role:postgres",
            message: "edge references a fact not in the base",
          },
          {
            origin: "declarativeLoad",
            code: "invalid_routine_body",
            severity: "info",
            message: "routine body failed validation",
          },
        ],
        false,
        true,
        true,
      );

      expect(out.messages).toContainEqual({
        type: "warn",
        message:
          "pg-delta next diagnostic: origin=source code=dangling_edge subject=role:postgres message=edge references a fact not in the base",
      });
      expect(out.messages).toContainEqual({
        type: "info",
        message:
          "pg-delta next diagnostic: origin=declarativeLoad code=invalid_routine_body message=routine body failed validation",
      });
      expect(debugMessages).toEqual([]);
    }).pipe(Effect.provide(out.layer), Effect.provide(debugLayer(debugMessages)));
  });

  it("classifies both coverage codes and aggregates arbitrary kinds safely", () => {
    const report = legacyPgDeltaNextDiagnosticReport(
      [
        unmodeled("z future kind"),
        unmodeled("a future kind"),
        unmodeled("a future kind"),
        unmodeled("line\nbreak"),
        unmodeled(undefined),
        unmodeled("  "),
        {
          origin: "snapshot",
          code: "unresolved_security_label",
          severity: "info",
          message: "provider was not resolved",
          context: { kind: 42 },
        },
      ],
      true,
    );

    expect(report.coverage).toHaveLength(7);
    expect(report.blocking).toHaveLength(7);
    expect(report.unmodeledKinds).toEqual(["a future kind", "line break", "z future kind"]);
  });

  it("omits an unknown subject and keeps feedback free of diagnostic details", () => {
    expect(
      legacyPgDeltaNextDiagnosticMessage({
        origin: "source",
        code: "unmodeled_kind",
        severity: "warning",
        subject: "unknown",
        message: "private diagnostic message",
        context: { kind: "operator class" },
      }),
    ).not.toContain("subject=");

    const invitation = legacyPgDeltaNextFeedbackInvitation(["operator class"]);
    expect(invitation).toContain("operator class");
    expect(invitation).not.toContain("private diagnostic message");
    expect(invitation).not.toContain("subject");
    expect(invitation).not.toContain("public.");
  });

  it("shell-quotes future kind names without making feedback kind-specific", () => {
    expect(legacyPgDeltaNextFeedbackInvitation(["user's future kind"])).toContain(
      `user'"'"'s future kind`,
    );
  });
});
