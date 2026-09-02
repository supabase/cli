import { describe, expect, test } from "vitest";

import { legacyResolveConfigPullDestination, legacySanitizeRemoteLabel } from "./pull.scope.ts";

const TARGET_REF = "target-ref";
const OTHER_REF = "other-ref";

describe("legacyResolveConfigPullDestination", () => {
  test("reuses the matched block when no label was requested", () => {
    const rawRemotes = { staging: { project_id: TARGET_REF } };
    expect(
      legacyResolveConfigPullDestination({
        rawRemotes,
        interpolatedRemotes: rawRemotes,
        projectRef: TARGET_REF,
        branchLabelCandidate: undefined,
        targetWasBranch: false,
        requestedLabel: undefined,
      }),
    ).toEqual({ ok: true, destination: { kind: "remote", label: "staging", created: false } });
  });

  test("reuses the matched block regardless of how the target was named", () => {
    // A branch-named target whose ref happens to already be tracked by an
    // existing block reuses that block — never creates a second one labeled
    // after the branch name.
    const rawRemotes = { staging: { project_id: TARGET_REF } };
    expect(
      legacyResolveConfigPullDestination({
        rawRemotes,
        interpolatedRemotes: rawRemotes,
        projectRef: TARGET_REF,
        branchLabelCandidate: "totally-different-name",
        targetWasBranch: true,
        requestedLabel: undefined,
      }),
    ).toEqual({ ok: true, destination: { kind: "remote", label: "staging", created: false } });
  });

  test("reuses the matched block when the requested label names it explicitly", () => {
    const rawRemotes = { staging: { project_id: TARGET_REF } };
    expect(
      legacyResolveConfigPullDestination({
        rawRemotes,
        interpolatedRemotes: rawRemotes,
        projectRef: TARGET_REF,
        branchLabelCandidate: undefined,
        targetWasBranch: false,
        requestedLabel: "staging",
      }),
    ).toEqual({ ok: true, destination: { kind: "remote", label: "staging", created: false } });
  });

  test("a UUID branch target with no label candidate falls back to the resolved project ref", () => {
    expect(
      legacyResolveConfigPullDestination({
        rawRemotes: {},
        interpolatedRemotes: {},
        projectRef: TARGET_REF,
        branchLabelCandidate: undefined,
        targetWasBranch: true,
        requestedLabel: undefined,
      }),
    ).toEqual({
      ok: true,
      destination: { kind: "remote", label: TARGET_REF, created: true },
    });
  });

  test("a named branch target creates a block labeled after the branch name", () => {
    expect(
      legacyResolveConfigPullDestination({
        rawRemotes: {},
        interpolatedRemotes: {},
        projectRef: TARGET_REF,
        branchLabelCandidate: "staging",
        targetWasBranch: true,
        requestedLabel: undefined,
      }),
    ).toEqual({ ok: true, destination: { kind: "remote", label: "staging", created: true } });
  });

  test("a ref-shaped target with no match writes to the config root", () => {
    expect(
      legacyResolveConfigPullDestination({
        rawRemotes: {},
        interpolatedRemotes: {},
        projectRef: TARGET_REF,
        branchLabelCandidate: undefined,
        targetWasBranch: false,
        requestedLabel: undefined,
      }),
    ).toEqual({ ok: true, destination: { kind: "root" } });
  });

  test("--remote-label overrides both the branch-name fallback and the root default", () => {
    const rootCase = legacyResolveConfigPullDestination({
      rawRemotes: {},
      interpolatedRemotes: {},
      projectRef: TARGET_REF,
      branchLabelCandidate: undefined,
      targetWasBranch: false,
      requestedLabel: "custom",
    });
    expect(rootCase).toEqual({
      ok: true,
      destination: { kind: "remote", label: "custom", created: true },
    });

    const branchCase = legacyResolveConfigPullDestination({
      rawRemotes: {},
      interpolatedRemotes: {},
      projectRef: TARGET_REF,
      branchLabelCandidate: "staging",
      targetWasBranch: true,
      requestedLabel: "custom",
    });
    expect(branchCase).toEqual({
      ok: true,
      destination: { kind: "remote", label: "custom", created: true },
    });
  });

  test("a --remote-label naming an existing block for a different project is a collision", () => {
    const rawRemotes = { prod: { project_id: OTHER_REF } };
    expect(
      legacyResolveConfigPullDestination({
        rawRemotes,
        interpolatedRemotes: rawRemotes,
        projectRef: TARGET_REF,
        branchLabelCandidate: undefined,
        targetWasBranch: false,
        requestedLabel: "prod",
      }),
    ).toEqual({
      ok: false,
      reason: "label_collision",
      label: "prod",
      conflictingProjectId: OTHER_REF,
    });
  });

  test("a --remote-label naming no existing block, while another block already tracks this ref, is also a collision", () => {
    const rawRemotes = { staging: { project_id: TARGET_REF } };
    expect(
      legacyResolveConfigPullDestination({
        rawRemotes,
        interpolatedRemotes: rawRemotes,
        projectRef: TARGET_REF,
        branchLabelCandidate: undefined,
        targetWasBranch: false,
        requestedLabel: "newlabel",
      }),
    ).toEqual({
      ok: false,
      reason: "label_collision",
      label: "newlabel",
      conflictingProjectId: TARGET_REF,
    });
  });

  test("an env()-resolving remote is a hard error, never reused", () => {
    const rawRemotes = { staging: { project_id: "env(SUPABASE_STAGING_REF)" } };
    const interpolatedRemotes = { staging: { project_id: TARGET_REF } };
    expect(
      legacyResolveConfigPullDestination({
        rawRemotes,
        interpolatedRemotes,
        projectRef: TARGET_REF,
        branchLabelCandidate: undefined,
        targetWasBranch: false,
        requestedLabel: undefined,
      }),
    ).toEqual({
      ok: false,
      reason: "env_project_id",
      label: "staging",
      envVariables: ["SUPABASE_STAGING_REF"],
    });
  });

  test("an env()-resolving remote is reported even when a --remote-label was also requested", () => {
    const rawRemotes = { staging: { project_id: "env(SUPABASE_STAGING_REF)" } };
    const interpolatedRemotes = { staging: { project_id: TARGET_REF } };
    expect(
      legacyResolveConfigPullDestination({
        rawRemotes,
        interpolatedRemotes,
        projectRef: TARGET_REF,
        branchLabelCandidate: undefined,
        targetWasBranch: false,
        requestedLabel: "custom",
      }),
    ).toEqual({
      ok: false,
      reason: "env_project_id",
      label: "staging",
      envVariables: ["SUPABASE_STAGING_REF"],
    });
  });

  test("reusing an existing block never rewrites its label, even a control-character one", () => {
    const hostileLabel = `staging${String.fromCharCode(0)}`;
    const rawRemotes = { [hostileLabel]: { project_id: TARGET_REF } };
    expect(
      legacyResolveConfigPullDestination({
        rawRemotes,
        interpolatedRemotes: rawRemotes,
        projectRef: TARGET_REF,
        branchLabelCandidate: undefined,
        targetWasBranch: false,
        requestedLabel: undefined,
      }),
    ).toEqual({
      ok: true,
      destination: { kind: "remote", label: hostileLabel, created: false },
    });
  });

  test("a hostile branch-name label is sanitized when creating a new block", () => {
    expect(
      legacyResolveConfigPullDestination({
        rawRemotes: {},
        interpolatedRemotes: {},
        projectRef: TARGET_REF,
        branchLabelCandidate: "staging\nNo config differences found.",
        targetWasBranch: true,
        requestedLabel: undefined,
      }),
    ).toEqual({
      ok: true,
      destination: { kind: "remote", label: "staging No config differences found.", created: true },
    });
  });

  test("a hostile --remote-label is sanitized when creating a new block", () => {
    expect(
      legacyResolveConfigPullDestination({
        rawRemotes: {},
        interpolatedRemotes: {},
        projectRef: TARGET_REF,
        branchLabelCandidate: undefined,
        targetWasBranch: false,
        requestedLabel: "staging\nNo config differences found.",
      }),
    ).toEqual({
      ok: true,
      destination: { kind: "remote", label: "staging No config differences found.", created: true },
    });
  });
});

describe("legacySanitizeRemoteLabel", () => {
  test("collapses newline/tab injection to a single space", () => {
    expect(legacySanitizeRemoteLabel("staging\nNo config differences found.")).toBe(
      "staging No config differences found.",
    );
  });

  test("strips NUL and other control characters", () => {
    expect(legacySanitizeRemoteLabel(`staging${String.fromCharCode(0)}`)).toBe("staging");
  });
});
