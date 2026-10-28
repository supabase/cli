import { describe, expect, test } from "bun:test";
import { type BenchPr, resolveBench, type ResolveIo } from "./resolve.ts";

const REPO = "supabase/cli";
const pr = (overrides: Partial<BenchPr> = {}): BenchPr => ({
  state: "open",
  headSha: "a".repeat(40),
  headRepoFullName: REPO,
  baseRepoFullName: REPO,
  baseRef: "develop",
  ...overrides,
});

function io(permissions: Record<string, string>, head: BenchPr = pr()) {
  const reactions: Array<number> = [];
  const impl: ResolveIo = {
    fetchPr: async () => head,
    fetchPermission: async (login) => permissions[login],
    reactToComment: async (id) => {
      reactions.push(id);
    },
  };
  return { impl, reactions };
}

const command = (body: string, association = "COLLABORATOR", login = "maintainer") =>
  ({
    eventName: "issue_comment",
    prNumber: 7,
    comment: { id: 99, authorLogin: login, authorAssociation: association, body },
  }) as const;

describe("resolveBench", () => {
  test("runs a pull_request event for its own head commit", async () => {
    const { impl } = io({});

    const result = await resolveBench(
      { eventName: "pull_request", prNumber: 7, pr: pr({ baseRef: "next" }) },
      impl,
    );

    expect(result).toMatchObject({
      shouldRun: true,
      trigger: "auto",
      baseRef: "next",
      isFork: false,
    });
  });

  test("marks a pull request from another repository as a fork", async () => {
    const { impl } = io({});

    const result = await resolveBench(
      { eventName: "pull_request", prNumber: 7, pr: pr({ headRepoFullName: "someone/cli" }) },
      impl,
    );

    expect(result.isFork).toBe(true);
  });

  test("accepts /bench from a writer, runs the current head, and reacts", async () => {
    const { impl, reactions } = io({ maintainer: "write" }, pr({ headSha: "b".repeat(40) }));

    const result = await resolveBench(command("/bench\n"), impl);

    expect(result).toMatchObject({ shouldRun: true, trigger: "command", headSha: "b".repeat(40) });
    expect(reactions).toEqual([99]);
  });

  test.each(["/bench full", "/benchmark", "please /bench", "/Bench"])(
    "ignores %p",
    async (body) => {
      const { impl, reactions } = io({ maintainer: "write" });

      const result = await resolveBench(command(body), impl);

      expect(result.shouldRun).toBe(false);
      expect(reactions).toEqual([]);
    },
  );

  test("rejects a commenter without write permission even as a MEMBER", async () => {
    const { impl, reactions } = io({ maintainer: "read" });

    const result = await resolveBench(command("/bench", "MEMBER"), impl);

    expect(result.shouldRun).toBe(false);
    expect(result.skipReason).toContain("not authorized");
    expect(reactions).toEqual([]);
  });

  test("lets the repository owner run it without a permission lookup result", async () => {
    const { impl } = io({});

    const result = await resolveBench(command("/bench", "OWNER"), impl);

    expect(result.shouldRun).toBe(true);
  });

  test("does not run on a closed pull request", async () => {
    const { impl } = io({ maintainer: "admin" }, pr({ state: "closed" }));

    const result = await resolveBench(command("/bench"), impl);

    expect(result.shouldRun).toBe(false);
  });

  test.each([
    ["a fork", "someone/cli"],
    ["a deleted head repository", ""],
  ])("does not run /bench on %s and does not react", async (_name, headRepo) => {
    const { impl, reactions } = io({ maintainer: "write" }, pr({ headRepoFullName: headRepo }));

    const result = await resolveBench(command("/bench"), impl);

    expect(result.shouldRun).toBe(false);
    expect(result.skipReason).toContain("from this repository");
    expect(reactions).toEqual([]);
  });

  test.each([
    ["a pull request into next", "next"],
    ["a stacked pull request into a feature branch", "feature/stack-base"],
  ])("does not run /bench on %s and does not react", async (_name, baseRef) => {
    const { impl, reactions } = io({ maintainer: "write" }, pr({ baseRef }));

    const result = await resolveBench(command("/bench"), impl);

    expect(result.shouldRun).toBe(false);
    expect(result.skipReason).toContain("into develop");
    expect(reactions).toEqual([]);
  });
});
