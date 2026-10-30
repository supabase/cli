import { describe, expect, test } from "bun:test";
import { GithubRequestError } from "./github.ts";
import { makeEntry } from "./history.ts";
import { composeBody, failureMarkdown, measuredSha, runningContent } from "./post-comment.ts";
import {
  type BenchPr,
  type CommandIo,
  coversIntegrationHeavy,
  handleBenchCommand,
  RERUN_WINDOW_MS,
  type FullRun,
  type FullWorkloads,
  type WorkflowRun,
} from "./rerun.ts";

const REPO = "supabase/cli";
const HEAD = "a".repeat(40);
const NOW = new Date("2026-10-28T12:00:00Z");
const pr = (overrides: Partial<BenchPr> = {}): BenchPr => ({
  state: "open",
  draft: false,
  headSha: HEAD,
  headRef: "feature/x",
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
    fullRuns?: ReadonlyArray<FullRun>;
    dispatchError?: Error;
    /** Short SHA the lightweight comment measured. */
    lightweightSha?: string;
  } = {},
) {
  const calls = {
    reactions: [] as Array<number>,
    replies: [] as Array<string>,
    reruns: [] as Array<number>,
    dispatches: [] as Array<{ ref: string; workloads: FullWorkloads }>,
  };
  const io: CommandIo = {
    fetchPr: async () => options.pr ?? pr(),
    fetchPermission: async (login) => (options.permissions ?? { maintainer: "write" })[login],
    listRuns: async () => options.runs ?? [run()],
    rerun: async (id) => {
      if (options.rerunError !== undefined) throw options.rerunError;
      calls.reruns.push(id);
    },
    listFullRuns: async () => options.fullRuns ?? [],
    dispatchFull: async (ref, workloads) => {
      if (options.dispatchError !== undefined) throw options.dispatchError;
      calls.dispatches.push({ ref, workloads });
    },
    lightweightSha: async () => options.lightweightSha,
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

  test.each(["/bench fully", "/benchmark", "please /bench", "/Bench", "/bench full now"])(
    "ignores %p without a reply",
    async (body) => {
      const { io, calls } = setup();

      const outcome = await handleBenchCommand(command(body), io);

      expect(outcome.kind).toBe("ignored");
      expect(calls).toEqual({ reactions: [], replies: [], reruns: [], dispatches: [] });
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
    expect(calls).toEqual({ reactions: [], replies: [], reruns: [], dispatches: [] });
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

const stackRun = (overrides: Partial<FullRun> = {}): FullRun => ({
  id: 31,
  status: "in_progress",
  displayTitle: "CLI benchmark full (integration-heavy): feature/x",
  url: "https://github.com/supabase/cli/actions/runs/31",
  ...overrides,
});

describe("handleBenchCommand with /bench full", () => {
  test("dispatches the integration-heavy workloads on the branch and leaves a current lightweight comment alone", async () => {
    const { io, calls } = setup({ lightweightSha: "aaaaaaa" });

    const outcome = await handleBenchCommand(command("/bench full\n"), io);

    expect(outcome).toEqual({
      kind: "dispatched",
      workloads: "integration-heavy",
      rerunId: undefined,
    });
    expect(calls.dispatches).toEqual([{ ref: "feature/x", workloads: "integration-heavy" }]);
    expect(calls.reruns).toEqual([]);
    expect(calls.reactions).toEqual([99]);
    expect(calls.replies).toEqual([]);
  });

  test("also re-runs the lightweight run when its comment is behind the head commit", async () => {
    const { io, calls } = setup({ lightweightSha: "bbbbbbb", runs: [run({ id: 4 })] });

    const outcome = await handleBenchCommand(command("/bench full"), io);

    expect(outcome).toEqual({ kind: "dispatched", workloads: "integration-heavy", rerunId: 4 });
    expect(calls.reruns).toEqual([4]);
  });

  test("leaves the lightweight part to a pull request run that is already in flight", async () => {
    const { io, calls } = setup({
      lightweightSha: "bbbbbbb",
      runs: [run({ status: "queued" })],
    });

    await handleBenchCommand(command("/bench full"), io);

    expect(calls.dispatches).toEqual([{ ref: "feature/x", workloads: "integration-heavy" }]);
    expect(calls.reruns).toEqual([]);
    expect(calls.replies).toEqual([]);
  });

  test.each([
    ["no pull request run exists for the head commit", [] as Array<WorkflowRun>],
    [
      "its pull request run is older than 30 days",
      [run({ createdAt: new Date(NOW.getTime() - RERUN_WINDOW_MS - 1000).toISOString() })],
    ],
  ])("measures the lightweight workloads in the full run when %s", async (_name, runs) => {
    const { io, calls } = setup({ lightweightSha: undefined, runs });

    const outcome = await handleBenchCommand(command("/bench full"), io);

    expect(outcome).toEqual({ kind: "dispatched", workloads: "all", rerunId: undefined });
    expect(calls.dispatches).toEqual([{ ref: "feature/x", workloads: "all" }]);
    expect(calls.reruns).toEqual([]);
  });

  test("replies with the link of an integration-heavy run already in progress and starts nothing", async () => {
    const { io, calls } = setup({ fullRuns: [stackRun()] });

    const outcome = await handleBenchCommand(command("/bench full"), io);

    expect(outcome.kind).toBe("replied");
    expect(calls.replies[0]).toContain("https://github.com/supabase/cli/actions/runs/31");
    expect(calls.dispatches).toEqual([]);
    expect(calls.reruns).toEqual([]);
    expect(calls.reactions).toEqual([]);
  });

  test("starts a run when the one in progress measures only the lightweight workloads", async () => {
    const { io, calls } = setup({
      lightweightSha: "aaaaaaa",
      fullRuns: [stackRun({ displayTitle: "CLI benchmark full (lightweight): feature/x" })],
    });

    await handleBenchCommand(command("/bench full"), io);

    expect(calls.dispatches).toHaveLength(1);
  });

  test("starts a run when earlier ones have finished", async () => {
    const { io, calls } = setup({
      lightweightSha: "aaaaaaa",
      fullRuns: [stackRun({ status: "completed" })],
    });

    await handleBenchCommand(command("/bench full"), io);

    expect(calls.dispatches).toHaveLength(1);
  });

  test.each([
    ["a missing workflow file", new GithubRequestError(404, "Not Found", "u")],
    [
      "a branch whose workflow cannot be dispatched",
      new GithubRequestError(422, "Workflow does not have 'workflow_dispatch' trigger", "u"),
    ],
  ])("tells the author to merge develop on %s", async (_name, dispatchError) => {
    const { io, calls } = setup({ dispatchError });

    const outcome = await handleBenchCommand(command("/bench full"), io);

    expect(outcome.kind).toBe("replied");
    expect(calls.replies[0]).toContain("Merge `develop` into the branch");
    expect(calls.reruns).toEqual([]);
    expect(calls.reactions).toEqual([]);
  });

  test("surfaces GitHub's refusal of the dispatch with its status and message", async () => {
    const { io, calls } = setup({
      dispatchError: new GithubRequestError(403, "Resource not accessible by integration", "u"),
    });

    await handleBenchCommand(command("/bench full"), io);

    expect(calls.replies[0]).toContain("403");
    expect(calls.replies[0]).toContain("Resource not accessible by integration");
    expect(calls.reactions).toEqual([]);
  });

  test.each([
    ["a draft", pr({ draft: true }), "draft"],
    ["a fork", pr({ headRepoFullName: "someone/cli" }), "from this repository"],
    ["a pull request into another branch", pr({ baseRef: "release" }), "into develop"],
  ])("replies that %s is not benchmarked and starts nothing", async (_name, head, text) => {
    const { io, calls } = setup({ pr: head });

    await handleBenchCommand(command("/bench full"), io);

    expect(calls.replies[0]).toContain(text);
    expect(calls.dispatches).toEqual([]);
  });

  test("ignores a commenter without write permission without a reply", async () => {
    const { io, calls } = setup({ permissions: { maintainer: "read" } });

    const outcome = await handleBenchCommand(command("/bench full", "MEMBER"), io);

    expect(outcome.kind).toBe("ignored");
    expect(calls.replies).toEqual([]);
    expect(calls.dispatches).toEqual([]);
  });

  test("keeps a started full run when re-running the lightweight run is refused", async () => {
    const { io, calls } = setup({
      lightweightSha: "bbbbbbb",
      rerunError: new GithubRequestError(403, "nope", "u"),
    });

    const outcome = await handleBenchCommand(command("/bench full"), io);

    expect(outcome).toEqual({
      kind: "dispatched",
      workloads: "integration-heavy",
      rerunId: undefined,
    });
    expect(calls.dispatches).toHaveLength(1);
    expect(calls.reactions).toEqual([99]);
  });
});

describe("coversIntegrationHeavy", () => {
  test.each([
    ["CLI benchmark full (all): develop", true],
    ["CLI benchmark full (integration-heavy): feature/x", true],
    ["CLI benchmark full (lightweight): feature/x", false],
    ["CLI benchmark full (scheduled)", false],
  ])("reads %p as %p", (title, expected) => {
    expect(coversIntegrationHeavy(title)).toBe(expected);
  });
});

describe("measuredSha", () => {
  const run = "https://github.com/o/r/actions/runs/7";
  const recorded = (sha: string, headline: string) =>
    makeEntry({ sha, now: NOW, headline, url: run });
  const entries = (...list: Array<ReturnType<typeof recorded>>) =>
    list.flatMap((item) => (item === undefined ? [] : [item]));

  test("names the commit of a lightweight comment that reports a result", () => {
    const body = composeBody(
      "lightweight",
      "## CLI benchmark (Lightweight Commands): no changes found",
      entries(recorded("abc1234", "no changes found")),
    );

    expect(measuredSha(body)).toBe("abc1234");
  });

  test("names the commit of a lightweight comment still under the previous heading", () => {
    const body = composeBody(
      "lightweight",
      "## CLI benchmark: no changes found",
      entries(recorded("abc1234", "no changes found")),
    );

    expect(measuredSha(body)).toBe("abc1234");
  });

  test("names no commit when the run failed", () => {
    const body = composeBody(
      "lightweight",
      failureMarkdown("lightweight", "abc1234def"),
      entries(recorded("abc1234", "could not run")),
    );

    expect(measuredSha(body)).toBeUndefined();
  });

  test("names no commit while a run is in progress", () => {
    const body = composeBody(
      "integration-heavy",
      runningContent("integration-heavy", "abc1234def", NOW, run),
      entries(recorded("1111111", "no changes found")),
      true,
    );

    expect(measuredSha(body)).toBeUndefined();
  });
});
