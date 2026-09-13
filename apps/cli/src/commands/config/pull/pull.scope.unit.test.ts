import { describe, expect, test } from "vitest";

import { resolveConfigPullDestination, sanitizeRemoteLabel } from "./pull.scope.ts";

const TARGET_REF = "target-ref";
const OTHER_REF = "other-ref";

describe("resolveConfigPullDestination", () => {
  test("reuses the matched block when no label was requested", () => {
    const rawRemotes = { staging: { project_id: TARGET_REF } };
    expect(
      resolveConfigPullDestination({
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
    const rawRemotes = { staging: { project_id: TARGET_REF } };
    expect(
      resolveConfigPullDestination({
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
      resolveConfigPullDestination({
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
      resolveConfigPullDestination({
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
      resolveConfigPullDestination({
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
      resolveConfigPullDestination({
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
    const rootCase = resolveConfigPullDestination({
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

    const branchCase = resolveConfigPullDestination({
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
      resolveConfigPullDestination({
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
      conflictingBlock: "prod",
    });
  });

  test("a --remote-label naming no existing block, while another block already tracks this ref, is also a collision", () => {
    const rawRemotes = { staging: { project_id: TARGET_REF } };
    expect(
      resolveConfigPullDestination({
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
      conflictingBlock: "staging",
    });
  });

  test("a branch-derived label naming an existing block for a different project is a collision (CLI-2064 item A)", () => {
    const rawRemotes = { staging: { project_id: OTHER_REF } };
    expect(
      resolveConfigPullDestination({
        rawRemotes,
        interpolatedRemotes: rawRemotes,
        projectRef: TARGET_REF,
        branchLabelCandidate: "staging",
        targetWasBranch: true,
        requestedLabel: undefined,
      }),
    ).toEqual({
      ok: false,
      reason: "label_collision",
      label: "staging",
      conflictingProjectId: OTHER_REF,
      conflictingBlock: "staging",
    });
  });

  test("a --remote-label collision is caught even when the raw flag value differs from the block's name only by control characters", () => {
    // The collision check compares the final sanitized label against existing block names, not
    // the raw flag value, so a hostile value can't slip past detection.
    const rawRemotes = { staging: { project_id: OTHER_REF } };
    const hostileLabel = `stag${String.fromCharCode(1)}ing`;
    expect(
      resolveConfigPullDestination({
        rawRemotes,
        interpolatedRemotes: rawRemotes,
        projectRef: TARGET_REF,
        branchLabelCandidate: undefined,
        targetWasBranch: false,
        requestedLabel: hostileLabel,
      }),
    ).toEqual({
      ok: false,
      reason: "label_collision",
      label: "staging",
      conflictingProjectId: OTHER_REF,
      conflictingBlock: "staging",
    });
  });

  test("--remote-label naming the same block as an env-spelled match is still a hard error", () => {
    // Exercises the named-label rule's env sub-case through --remote-label, rather than the
    // general env scan (which only runs without --remote-label).
    const rawRemotes = { staging: { project_id: "env(SUPABASE_STAGING_REF)" } };
    const interpolatedRemotes = { staging: { project_id: TARGET_REF } };
    expect(
      resolveConfigPullDestination({
        rawRemotes,
        interpolatedRemotes,
        projectRef: TARGET_REF,
        branchLabelCandidate: undefined,
        targetWasBranch: false,
        requestedLabel: "staging",
      }),
    ).toEqual({
      ok: false,
      reason: "env_project_id",
      label: "staging",
      envVariables: ["SUPABASE_STAGING_REF"],
    });
  });

  test("an env()-resolving remote is a hard error, never reused", () => {
    const rawRemotes = { staging: { project_id: "env(SUPABASE_STAGING_REF)" } };
    const interpolatedRemotes = { staging: { project_id: TARGET_REF } };
    expect(
      resolveConfigPullDestination({
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

  test("--remote-label alongside an unrelated env-spelled match creates/uses the requested block instead of refusing", () => {
    // --remote-label is honored above the env_project_id refusal, or the refusal's own remedy
    // ("pass --remote-label") would be dead. `custom` names nothing existing and no other
    // block's raw literal tracks the ref, so this creates a fresh block, leaving the
    // env()-spelled "staging" block untouched.
    const rawRemotes = { staging: { project_id: "env(SUPABASE_STAGING_REF)" } };
    const interpolatedRemotes = { staging: { project_id: TARGET_REF } };
    expect(
      resolveConfigPullDestination({
        rawRemotes,
        interpolatedRemotes,
        projectRef: TARGET_REF,
        branchLabelCandidate: undefined,
        targetWasBranch: false,
        requestedLabel: "custom",
      }),
    ).toEqual({
      ok: true,
      destination: { kind: "remote", label: "custom", created: true },
    });
  });

  test("reusing an existing block never rewrites its label, even a control-character one", () => {
    const hostileLabel = `staging${String.fromCharCode(0)}`;
    const rawRemotes = { [hostileLabel]: { project_id: TARGET_REF } };
    expect(
      resolveConfigPullDestination({
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
      resolveConfigPullDestination({
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
      resolveConfigPullDestination({
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

describe("sanitizeRemoteLabel", () => {
  test("collapses newline/tab injection to a single space", () => {
    expect(sanitizeRemoteLabel("staging\nNo config differences found.")).toBe(
      "staging No config differences found.",
    );
  });

  test("strips NUL and other control characters", () => {
    expect(sanitizeRemoteLabel(`staging${String.fromCharCode(0)}`)).toBe("staging");
  });
});
