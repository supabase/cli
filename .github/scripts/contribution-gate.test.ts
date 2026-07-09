import { describe, expect, test } from "bun:test";
import {
  evaluateAllOpenPrs,
  evaluateGate,
  GATE_LABEL,
  type GateIo,
  type LinkedIssue,
  type OpenPr,
} from "./contribution-gate.ts";

const REPO = "supabase/cli";

describe("evaluateGate", () => {
  test("skips bot authors", () => {
    const result = evaluateGate({
      repository: REPO,
      authorAssociation: "NONE",
      isBot: true,
      linkedIssues: [],
    });
    expect(result.pass).toBe(true);
    expect(result.reason).toBe("bot");
  });

  test.each(["OWNER", "MEMBER", "COLLABORATOR"])(
    "skips internal author association %s",
    (authorAssociation) => {
      const result = evaluateGate({
        repository: REPO,
        authorAssociation,
        isBot: false,
        linkedIssues: [],
      });
      expect(result.pass).toBe(true);
      expect(result.reason).toBe("internal");
    },
  );

  test("fails when no issue is linked", () => {
    const result = evaluateGate({
      repository: REPO,
      authorAssociation: "NONE",
      isBot: false,
      linkedIssues: [],
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe("no-linked-issue");
    expect(result.message).toContain(GATE_LABEL);
    expect(result.message).toContain("CONTRIBUTING.md");
  });

  test("fails when the linked issue is open but not labeled", () => {
    const result = evaluateGate({
      repository: REPO,
      authorAssociation: "CONTRIBUTOR",
      isBot: false,
      linkedIssues: [
        { repository: REPO, number: 12, state: "OPEN", labels: ["🐛 Bug"] },
      ],
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe("missing-label");
    expect(result.message).toContain(GATE_LABEL);
  });

  test("fails when the only labeled issue is closed", () => {
    const result = evaluateGate({
      repository: REPO,
      authorAssociation: "NONE",
      isBot: false,
      linkedIssues: [
        { repository: REPO, number: 7, state: "CLOSED", labels: [GATE_LABEL] },
      ],
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe("issue-closed");
  });

  test("passes when a linked issue is open and carries the gate label", () => {
    const result = evaluateGate({
      repository: REPO,
      authorAssociation: "NONE",
      isBot: false,
      linkedIssues: [
        {
          repository: REPO,
          number: 42,
          state: "OPEN",
          labels: [GATE_LABEL, "🐛 Bug"],
        },
      ],
    });
    expect(result.pass).toBe(true);
    expect(result.reason).toBe("ok");
  });

  test("passes when any one of several linked issues qualifies", () => {
    const result = evaluateGate({
      repository: REPO,
      authorAssociation: "FIRST_TIME_CONTRIBUTOR",
      isBot: false,
      linkedIssues: [
        { repository: REPO, number: 1, state: "CLOSED", labels: [GATE_LABEL] },
        { repository: REPO, number: 2, state: "OPEN", labels: ["✨ Feature"] },
        { repository: REPO, number: 3, state: "OPEN", labels: [GATE_LABEL] },
      ],
    });
    expect(result.pass).toBe(true);
    expect(result.reason).toBe("ok");
  });

  test("ignores an open, labeled issue from a different repository", () => {
    // Cross-repo closing keyword (e.g. `Closes attacker/repo#1`): the issue is
    // controlled by the contributor, so it must not satisfy the gate.
    const result = evaluateGate({
      repository: REPO,
      authorAssociation: "NONE",
      isBot: false,
      linkedIssues: [
        {
          repository: "attacker/repo",
          number: 1,
          state: "OPEN",
          labels: [GATE_LABEL],
        },
      ],
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe("no-linked-issue");
  });

  test("matches the repository case-insensitively", () => {
    const result = evaluateGate({
      repository: REPO,
      authorAssociation: "NONE",
      isBot: false,
      linkedIssues: [
        {
          repository: "Supabase/CLI",
          number: 5,
          state: "OPEN",
          labels: [GATE_LABEL],
        },
      ],
    });
    expect(result.pass).toBe(true);
    expect(result.reason).toBe("ok");
  });
});

describe("evaluateAllOpenPrs", () => {
  function makeIo(
    openPrs: OpenPr[],
    linkedByPr: Record<number, LinkedIssue[]>,
  ): { io: GateIo; closed: Array<{ number: number; message: string }> } {
    const closed: Array<{ number: number; message: string }> = [];
    const io: GateIo = {
      listOpenPrs: () => Promise.resolve(openPrs),
      fetchLinkedIssues: (prNumber) =>
        Promise.resolve(linkedByPr[prNumber] ?? []),
      closePr: (prNumber, message) => {
        closed.push({ number: prNumber, message });
        return Promise.resolve();
      },
    };
    return { io, closed };
  }

  test("closes only non-conforming external PRs and leaves the rest", async () => {
    const { io, closed } = makeIo(
      [
        { number: 1, authorAssociation: "NONE", isBot: false }, // no issue -> close
        { number: 2, authorAssociation: "MEMBER", isBot: false }, // internal -> skip
        { number: 3, authorAssociation: "NONE", isBot: true }, // bot -> skip
        { number: 4, authorAssociation: "CONTRIBUTOR", isBot: false }, // conforming -> keep
        { number: 5, authorAssociation: "NONE", isBot: false }, // missing label -> close
      ],
      {
        4: [
          { repository: REPO, number: 40, state: "OPEN", labels: [GATE_LABEL] },
        ],
        5: [
          { repository: REPO, number: 50, state: "OPEN", labels: ["🐛 Bug"] },
        ],
      },
    );

    const entries = await evaluateAllOpenPrs(io, REPO);

    expect(closed.map((c) => c.number).sort((a, b) => a - b)).toEqual([1, 5]);
    const byNumber = Object.fromEntries(
      entries.map((entry) => [entry.number, entry.result]),
    );
    expect(byNumber[1]?.reason).toBe("no-linked-issue");
    expect(byNumber[2]?.pass).toBe(true);
    expect(byNumber[2]?.reason).toBe("internal");
    expect(byNumber[3]?.reason).toBe("bot");
    expect(byNumber[4]?.pass).toBe(true);
    expect(byNumber[5]?.reason).toBe("missing-label");
    expect(closed.find((c) => c.number === 1)?.message).toContain(GATE_LABEL);
  });

  test("returns an entry per PR and closes none when all conform", async () => {
    const { io, closed } = makeIo(
      [{ number: 9, authorAssociation: "NONE", isBot: false }],
      {
        9: [
          { repository: REPO, number: 90, state: "OPEN", labels: [GATE_LABEL] },
        ],
      },
    );

    const entries = await evaluateAllOpenPrs(io, REPO);

    expect(entries).toHaveLength(1);
    expect(closed).toHaveLength(0);
    expect(entries[0]?.result.pass).toBe(true);
  });
});
