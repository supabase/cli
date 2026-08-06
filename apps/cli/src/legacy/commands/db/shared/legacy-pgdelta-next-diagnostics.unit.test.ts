import { describe, expect, it } from "vitest";

import {
  legacyPgDeltaNextBlockingDiagnostic,
  legacyPgDeltaNextBlockingDiagnosticMessage,
} from "./legacy-pgdelta-next-diagnostics.ts";

describe("pg-delta next diagnostic coverage policy", () => {
  it("blocks errors and strict coverage gaps while allowing ordinary warnings", () => {
    expect(
      legacyPgDeltaNextBlockingDiagnostic([
        {
          origin: "source",
          code: "unsupported_extension",
          severity: "warning",
          message: "extension is managed externally",
        },
      ]),
    ).toBeUndefined();

    expect(
      legacyPgDeltaNextBlockingDiagnostic([
        {
          origin: "desired",
          code: "unmodeled_kind",
          severity: "warning",
          subject: "object:public.unsupported",
          message: "object kind is not modeled",
        },
      ]),
    ).toMatchObject({ code: "unmodeled_kind" });

    expect(
      legacyPgDeltaNextBlockingDiagnostic([
        {
          origin: "export",
          code: "extraction_failed",
          severity: "error",
          message: "catalog query failed",
        },
      ]),
    ).toMatchObject({ code: "extraction_failed" });
  });

  it("renders the refused action and complete diagnostic identity", () => {
    expect(
      legacyPgDeltaNextBlockingDiagnosticMessage("declarativePlan", {
        origin: "declarativeLoad",
        code: "unresolved_security_label",
        severity: "info",
        subject: "table:public.accounts",
        message: "security label provider was not resolved",
      }),
    ).toBe(
      "pg-delta next refused to emit the declarative migration plan: origin=declarativeLoad code=unresolved_security_label subject=table:public.accounts message=security label provider was not resolved",
    );
  });
});
