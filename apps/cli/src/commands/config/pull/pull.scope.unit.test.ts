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
      conflictingBlock: "prod",
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
      conflictingBlock: "staging",
    });
  });

  test("a branch-derived label naming an existing block for a different project is a collision (CLI-2064 item A)", () => {
    // Before this rule existed, a branch named like an EXISTING block (here,
    // a branch called "staging" landing on an unrelated `[remotes.staging]`)
    // returned `created: true` and the handler REPLACED that block's own
    // `project_id`, stranding its stale overrides.
    const rawRemotes = { staging: { project_id: OTHER_REF } };
    expect(
      legacyResolveConfigPullDestination({
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
    // The collision check compares the FINAL SANITIZED label against
    // existing block names, not the raw flag value — otherwise
    // `--remote-label $'stag\x01ing'` (sanitizing to "staging") would slip
    // past an existing `[remotes.staging]` block tracking a different
    // project instead of colliding with it.
    const rawRemotes = { staging: { project_id: OTHER_REF } };
    const hostileLabel = `stag${String.fromCharCode(1)}ing`;
    expect(
      legacyResolveConfigPullDestination({
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
    // The unified named-label rule's own env sub-case, exercised through
    // `--remote-label` rather than the general env scan (the general scan
    // only runs when no `--remote-label` was given).
    const rawRemotes = { staging: { project_id: "env(SUPABASE_STAGING_REF)" } };
    const interpolatedRemotes = { staging: { project_id: TARGET_REF } };
    expect(
      legacyResolveConfigPullDestination({
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

  test("--remote-label alongside an unrelated env-spelled match creates/uses the requested block instead of refusing", () => {
    // CLI-2064 item B: `--remote-label` is honored ABOVE the env_project_id
    // refusal — otherwise the refusal's own remedy ("pass --remote-label")
    // would be dead. `custom` names nothing existing, and no OTHER block's
    // RAW literal tracks the target ref, so this creates a fresh block; the
    // env()-spelled "staging" block (which never applied to this project
    // anyway) is left untouched.
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
      ok: true,
      destination: { kind: "remote", label: "custom", created: true },
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
