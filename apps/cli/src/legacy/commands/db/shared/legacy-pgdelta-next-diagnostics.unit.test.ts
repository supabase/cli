import { Effect, Exit } from "effect";
import { it } from "@effect/vitest";
import { describe, expect } from "vitest";

import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
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

describe("pg-delta next diagnostic coverage policy", () => {
  it("allows coverage gaps by default after rendering diagnostics and one feedback invitation", () => {
    const out = mockOutput();
    return Effect.gen(function* () {
      yield* legacyReportPgDeltaNextDiagnostics(
        "diff",
        [unmodeled("text search configuration"), unmodeled("statistics object")],
        false,
      );

      expect(out.messages.filter(({ type }) => type === "warn")).toHaveLength(3);
      expect(out.messages).toContainEqual({
        type: "warn",
        message:
          "pg-delta found schema objects it does not manage. Changes to these objects are omitted from the generated database diff.",
      });
      const invitations = out.messages.filter(({ message }) =>
        message.startsWith("Request pg-delta support:"),
      );
      expect(invitations).toHaveLength(1);
      expect(invitations[0]?.message).toContain("statistics object, text search configuration");
    }).pipe(Effect.provide(out.layer));
  });

  it("renders coverage diagnostics and then fails in strict mode", () => {
    const out = mockOutput();
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
          "pg-delta found schema objects it does not manage. Strict coverage is enabled, so the operation will stop.",
      });
      expect(out.messages.some(({ message }) => message.includes("supabase issue feature"))).toBe(
        true,
      );
    }).pipe(Effect.provide(out.layer));
  });

  it("can suppress a repeated feedback invitation without suppressing warnings", () => {
    const out = mockOutput();
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
    }).pipe(Effect.provide(out.layer));
  });

  it("always renders and fails error diagnostics", () => {
    const out = mockOutput();
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
    }).pipe(Effect.provide(out.layer));
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
