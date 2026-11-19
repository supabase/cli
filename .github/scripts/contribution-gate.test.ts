import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  evaluateAllOpenPrs,
  evaluateGate,
  fetchAuthorPermission,
  GATE_LABEL,
  type GateIo,
  isInternalAuthor,
  type LinkedIssue,
  type OpenPr,
} from "./contribution-gate.ts";

const REPO = "supabase/cli";

describe("isInternalAuthor", () => {
  test.each(["OWNER", "MEMBER", "COLLABORATOR"])(
    "treats internal association %s as internal without a permission lookup",
    (authorAssociation) => {
      expect(isInternalAuthor(authorAssociation, undefined)).toBe(true);
    },
  );

  test.each(["admin", "write"])("treats push-capable permission %s as internal", (permission) => {
    expect(isInternalAuthor("CONTRIBUTOR", permission)).toBe(true);
    expect(isInternalAuthor("NONE", permission)).toBe(true);
  });

  test.each(["read", "none", undefined])(
    "treats external author with permission %s as external",
    (permission) => {
      expect(isInternalAuthor("CONTRIBUTOR", permission)).toBe(false);
      expect(isInternalAuthor("NONE", permission)).toBe(false);
    },
  );
});

describe("evaluateGate", () => {
  test("skips bot authors", () => {
    const result = evaluateGate({
      repository: REPO,
      isInternal: false,
      isBot: true,
      linkedIssues: [],
    });
    expect(result.pass).toBe(true);
    expect(result.reason).toBe("bot");
  });

  test("skips internal authors", () => {
    const result = evaluateGate({
      repository: REPO,
      isInternal: true,
      isBot: false,
      linkedIssues: [],
    });
    expect(result.pass).toBe(true);
    expect(result.reason).toBe("internal");
  });

  test("fails when no issue is linked", () => {
    const result = evaluateGate({
      repository: REPO,
      isInternal: false,
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
      isInternal: false,
      isBot: false,
      linkedIssues: [{ repository: REPO, number: 12, state: "OPEN", labels: ["🐛 Bug"] }],
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe("missing-label");
    expect(result.message).toContain(GATE_LABEL);
  });

  test("fails when the only labeled issue is closed", () => {
    const result = evaluateGate({
      repository: REPO,
      isInternal: false,
      isBot: false,
      linkedIssues: [{ repository: REPO, number: 7, state: "CLOSED", labels: [GATE_LABEL] }],
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe("issue-closed");
  });

  test("passes when a linked issue is open and carries the gate label", () => {
    const result = evaluateGate({
      repository: REPO,
      isInternal: false,
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
      isInternal: false,
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
    const result = evaluateGate({
      repository: REPO,
      isInternal: false,
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
      isInternal: false,
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
    permissionByLogin: Record<string, string> = {},
  ): {
    io: GateIo;
    closed: Array<{ number: number; message: string }>;
    permissionLookups: string[];
  } {
    const closed: Array<{ number: number; message: string }> = [];
    const permissionLookups: string[] = [];
    const io: GateIo = {
      listOpenPrs: () => Promise.resolve(openPrs),
      fetchPermission: (login) => {
        permissionLookups.push(login);
        return Promise.resolve(permissionByLogin[login]);
      },
      fetchLinkedIssues: (prNumber) => Promise.resolve(linkedByPr[prNumber] ?? []),
      closePr: (prNumber, message) => {
        closed.push({ number: prNumber, message });
        return Promise.resolve();
      },
    };
    return { io, closed, permissionLookups };
  }

  test("closes only non-conforming external PRs and leaves the rest", async () => {
    const { io, closed, permissionLookups } = makeIo(
      [
        // no issue -> close
        { number: 1, authorLogin: "ext-a", authorAssociation: "NONE", isBot: false },
        // public member -> skip (no permission lookup needed)
        { number: 2, authorLogin: "maint", authorAssociation: "MEMBER", isBot: false },
        // bot -> skip
        { number: 3, authorLogin: "dependabot", authorAssociation: "NONE", isBot: true },
        // conforming external -> keep
        { number: 4, authorLogin: "ext-b", authorAssociation: "CONTRIBUTOR", isBot: false },
        // missing label -> close
        { number: 5, authorLogin: "ext-c", authorAssociation: "NONE", isBot: false },
        // private-membership maintainer (CONTRIBUTOR + write access) -> skip
        { number: 6, authorLogin: "hidden-maint", authorAssociation: "CONTRIBUTOR", isBot: false },
      ],
      {
        4: [{ repository: REPO, number: 40, state: "OPEN", labels: [GATE_LABEL] }],
        5: [{ repository: REPO, number: 50, state: "OPEN", labels: ["🐛 Bug"] }],
      },
      { "hidden-maint": "write" },
    );

    const entries = await evaluateAllOpenPrs(io, REPO);

    expect(closed.map((c) => c.number).sort((a, b) => a - b)).toEqual([1, 5]);
    const byNumber = Object.fromEntries(entries.map((entry) => [entry.number, entry.result]));
    expect(byNumber[1]?.reason).toBe("no-linked-issue");
    expect(byNumber[2]?.pass).toBe(true);
    expect(byNumber[2]?.reason).toBe("internal");
    expect(byNumber[3]?.reason).toBe("bot");
    expect(byNumber[4]?.pass).toBe(true);
    expect(byNumber[5]?.reason).toBe("missing-label");
    expect(byNumber[6]?.pass).toBe(true);
    expect(byNumber[6]?.reason).toBe("internal");
    expect(closed.find((c) => c.number === 1)?.message).toContain(GATE_LABEL);
    expect(permissionLookups).not.toContain("maint");
    expect(permissionLookups).not.toContain("dependabot");
  });

  test.each(["permission", "issues", "close"])(
    "continues after a %s failure and rejects the sweep with PR context",
    async (failure) => {
      const { io, closed } = makeIo(
        [1, 2].map((number) => ({
          number,
          authorLogin: `ext-${number}`,
          authorAssociation: "NONE",
          isBot: false,
        })),
        {},
      );
      if (failure === "permission") {
        io.fetchPermission = async (login) => {
          if (login === "ext-1") throw new Error("permission outage");
          return undefined;
        };
      } else if (failure === "issues") {
        io.fetchLinkedIssues = async (number) => {
          if (number === 1) throw new Error("issues outage");
          return [];
        };
      } else {
        const close = io.closePr;
        io.closePr = async (number, message) => {
          if (number === 1) throw new Error("close outage");
          await close(number, message);
        };
      }
      await expect(evaluateAllOpenPrs(io, REPO)).rejects.toThrow(/PR #1/);
      expect(closed.map((pr) => pr.number)).toEqual([2]);
    },
  );

  test("exempt PRs do not depend on the linked issue API", async () => {
    const { io, closed } = makeIo(
      [
        { number: 1, authorLogin: "bot", authorAssociation: "NONE", isBot: true },
        { number: 2, authorLogin: "member", authorAssociation: "MEMBER", isBot: false },
        { number: 3, authorLogin: "private", authorAssociation: "NONE", isBot: false },
      ],
      {},
      { private: "write" },
    );
    io.fetchLinkedIssues = async () => {
      throw new Error("issues outage");
    };
    expect((await evaluateAllOpenPrs(io, REPO)).map((entry) => entry.result.reason)).toEqual([
      "bot",
      "internal",
      "internal",
    ]);
    expect(closed).toEqual([]);
  });

  test.each(["read", "write", undefined])(
    "reuses successful %s permission results per author",
    async (permission) => {
      const { io, permissionLookups } = makeIo(
        [1, 2].map((number) => ({
          number,
          authorLogin: "same-author",
          authorAssociation: "NONE",
          isBot: false,
        })),
        {},
        permission ? { "same-author": permission } : {},
      );
      await evaluateAllOpenPrs(io, REPO);
      expect(permissionLookups).toEqual(["same-author"]);
    },
  );

  test("retries failed permission lookups for later PRs by the same author", async () => {
    const { io, closed } = makeIo(
      [1, 2].map((number) => ({
        number,
        authorLogin: "same-author",
        authorAssociation: "NONE",
        isBot: false,
      })),
      {},
    );
    let attempts = 0;
    io.fetchPermission = async () => {
      if (++attempts === 1) throw new Error("temporary outage");
      return "write";
    };
    await expect(evaluateAllOpenPrs(io, REPO)).rejects.toThrow(/PR #1/);
    expect(attempts).toBe(2);
    expect(closed).toEqual([]);
  });

  test("returns an entry per PR and closes none when all conform", async () => {
    const { io, closed } = makeIo(
      [{ number: 9, authorLogin: "ext", authorAssociation: "NONE", isBot: false }],
      {
        9: [{ repository: REPO, number: 90, state: "OPEN", labels: [GATE_LABEL] }],
      },
    );

    const entries = await evaluateAllOpenPrs(io, REPO);

    expect(entries).toHaveLength(1);
    expect(closed).toHaveLength(0);
    expect(entries[0]?.result.pass).toBe(true);
  });
});

describe("fetchAuthorPermission", () => {
  const fetchSpy = spyOn(globalThis, "fetch");
  afterEach(() => {
    fetchSpy.mockReset();
  });

  function stubFetch(status: number, body: unknown): void {
    // `typeof fetch` carries a static `preconnect`, so attach a no-op to keep
    // the implementation assignable without casting.
    fetchSpy.mockImplementation(
      Object.assign(() => Promise.resolve(new Response(JSON.stringify(body), { status })), {
        preconnect: () => {},
      }),
    );
  }

  test("returns the effective permission for a collaborator", async () => {
    stubFetch(200, { permission: "admin" });
    const permission = await fetchAuthorPermission("t", "supabase", "cli", "maint");
    expect(permission).toBe("admin");
  });

  test("maps a 404 (non-collaborator fork author) to undefined", async () => {
    stubFetch(404, { message: "Not Found" });
    const permission = await fetchAuthorPermission("t", "supabase", "cli", "ext");
    expect(permission).toBeUndefined();
  });

  test("throws on other API failures rather than treating the author as external", async () => {
    stubFetch(403, { message: "Forbidden" });
    await expect(fetchAuthorPermission("t", "supabase", "cli", "ext")).rejects.toThrow(/403/);
  });

  test("skips the network call for a blank login", async () => {
    stubFetch(200, { permission: "admin" });
    const permission = await fetchAuthorPermission("t", "supabase", "cli", "");
    expect(permission).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
