import { describe, expect, test } from "bun:test";
import { GithubRequestError } from "./github.ts";
import {
  type BenchPr,
  type CommandIo,
  handleBenchCommand,
  RERUN_WINDOW_MS,
  type WorkflowRun,
} from "./rerun.ts";

const REPO = "supabase/cli";
const HEAD = "a".repeat(40);
const NOW = new Date("2026-10-28T12:00:00Z");
const pr = (overrides: Partial<BenchPr> = {}): BenchPr => ({
  state: "open",
  draft: false,
  headSha: HEAD,
  headRepoFullName: REPO,
  baseRepoFullName: REPO,
  baseRef: "develop",
  ...overrides,
});
const run = (overrides: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: 11,
  status: "completed",
  createdAt: "2026-10-27T12:00:00Z",
  ...overrides,
});

function setup(
  options: {
    permissions?: Record<string, string>;
    pr?: BenchPr;
    runs?: ReadonlyArray<WorkflowRun>;
    rerunError?: Error;
  } = {},
) {
  const calls = {
    reactions: [] as Array<number>,
    replies: [] as Array<string>,
    reruns: [] as Array<number>,
  };
  const io: CommandIo = {
    fetchPr: async () => options.pr ?? pr(),
    fetchPermission: async (login) => (options.permissions ?? { maintainer: "write" })[login],
    listRuns: async () => options.runs ?? [run()],
    rerun: async (id) => {
      if (options.rerunError !== undefined) throw options.rerunError;
      calls.reruns.push(id);
    },
    reactToComment: async (id) => {
      calls.reactions.push(id);
    },
    replyToPr: async (_n, body) => {
      calls.replies.push(body);
    },
  };
  return { io, calls };
}

const command = (body: string, association = "COLLABORATOR", login = "maintainer") => ({
  prNumber: 7,
  comment: { id: 99, authorLogin: login, authorAssociation: association, body },
  now: NOW,
});

describe("handleBenchCommand", () => {
  test("re-runs the latest run for the head commit and reacts only after GitHub accepts it", async () => {
    const { io, calls } = setup({
      runs: [run({ id: 1, createdAt: "2026-10-20T00:00:00Z" }), run({ id: 2 })],
    });

    const outcome = await handleBenchCommand(command("/bench\n"), io);

    expect(outcome).toEqual({ kind: "rerun", runId: 2 });
    expect(calls.reruns).toEqual([2]);
    expect(calls.reactions).toEqual([99]);
    expect(calls.replies).toEqual([]);
  });

  test.each(["/bench full", "/benchmark", "please /bench", "/Bench"])(
    "ignores %p without a reply",
    async (body) => {
      const { io, calls } = setup();

      const outcome = await handleBenchCommand(command(body), io);

      expect(outcome.kind).toBe("ignored");
      expect(calls).toEqual({ reactions: [], replies: [], reruns: [] });
    },
  );

  test("rejects a commenter without write permission even as a MEMBER", async () => {
    const { io, calls } = setup({ permissions: { maintainer: "read" } });

    const outcome = await handleBenchCommand(command("/bench", "MEMBER"), io);

    expect(outcome).toMatchObject({ kind: "ignored" });
    expect(calls.reruns).toEqual([]);
  });

  test("lets the repository owner run it without a permission lookup result", async () => {
    const { io } = setup({ permissions: {} });

    expect((await handleBenchCommand(command("/bench", "OWNER"), io)).kind).toBe("rerun");
  });

  test.each([
    ["a closed pull request", pr({ state: "closed" })],
    ["a fork", pr({ headRepoFullName: "someone/cli" })],
    ["a deleted head repository", pr({ headRepoFullName: "" })],
    ["a pull request into another branch", pr({ baseRef: "feature/stack-base" })],
  ])("ignores /bench on %s", async (_name, head) => {
    const { io, calls } = setup({ pr: head });

    const outcome = await handleBenchCommand(command("/bench"), io);

    expect(outcome.kind).toBe("ignored");
    expect(calls).toEqual({ reactions: [], replies: [], reruns: [] });
  });

  test("tells the pull request there is no run when none exists for the head commit", async () => {
    const { io, calls } = setup({ runs: [] });

    const outcome = await handleBenchCommand(command("/bench"), io);

    expect(outcome.kind).toBe("replied");
    expect(calls.replies).toHaveLength(1);
    expect(calls.replies[0]).toContain("no benchmark run for commit `aaaaaaa`");
    expect(calls.reruns).toEqual([]);
    expect(calls.reactions).toEqual([]);
  });

  test("says a benchmark is already running instead of re-running it", async () => {
    const { io, calls } = setup({ runs: [run({ status: "in_progress" })] });

    await handleBenchCommand(command("/bench"), io);

    expect(calls.replies[0]).toContain("already running");
    expect(calls.reruns).toEqual([]);
    expect(calls.reactions).toEqual([]);
  });

  test("says the re-run could not start when the run is older than 30 days", async () => {
    const old = new Date(NOW.getTime() - RERUN_WINDOW_MS - 1000).toISOString();
    const { io, calls } = setup({ runs: [run({ createdAt: old })] });

    await handleBenchCommand(command("/bench"), io);

    expect(calls.replies[0]).toContain("older than 30 days");
    expect(calls.reruns).toEqual([]);
  });

  test("surfaces GitHub's refusal in a reply and does not react", async () => {
    const { io, calls } = setup({
      rerunError: new GithubRequestError(403, "Resource not accessible by integration", "u"),
    });

    const outcome = await handleBenchCommand(command("/bench"), io);

    expect(outcome.kind).toBe("replied");
    expect(calls.replies[0]).toContain("403");
    expect(calls.replies[0]).toContain("Resource not accessible by integration");
    expect(calls.reactions).toEqual([]);
  });

  test("keeps an accepted re-run when the reaction fails", async () => {
    const { io } = setup();
    io.reactToComment = async () => {
      throw new Error("boom");
    };

    expect(await handleBenchCommand(command("/bench"), io)).toEqual({ kind: "rerun", runId: 11 });
  });

  test("explains that a draft pull request is not benchmarked", async () => {
    const { io, calls } = setup({ pr: pr({ draft: true }) });

    await handleBenchCommand(command("/bench"), io);

    expect(calls.replies[0]).toContain("draft");
    expect(calls.reruns).toEqual([]);
  });
});
