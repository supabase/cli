import { describe, expect, test } from "bun:test";
import {
  AI_DOGFOOD_MARKER,
  assertDogfoodReport,
  extractDogfoodVerdict,
  fetchDogfoodReport,
  fetchDogfoodReportOrEmpty,
  makeCrashStub,
  pickLatestDogfoodComment,
  postDogfoodComment,
  renderDogfoodComment,
  type DogfoodReport,
  type IssueComment,
  type ReportIo,
} from "./post-report.ts";

const VALID_REPORT: DogfoodReport = {
  verdict: "go",
  summary: "Schema apply and migrations push succeeded on basejump.",
  head_sha: "abc123def456",
  journeys: [
    {
      id: "create-link-push",
      commands: ["projects create", "link", "migrations push"],
      result: "pass",
      notes: "Pending files applied on staging.",
    },
  ],
  blockers: [],
  cleanup: { projects_deleted: ["abcdefghijklmnopqrst"] },
};

describe("assertDogfoodReport", () => {
  test("accepts a valid report", () => {
    expect(() => assertDogfoodReport(VALID_REPORT)).not.toThrow();
  });

  test("accepts an empty journeys array", () => {
    expect(() => assertDogfoodReport({ ...VALID_REPORT, journeys: [] })).not.toThrow();
  });

  test.each([
    ["a bare string", "not an object", /expected an object, got string/],
    ["missing verdict", { ...VALID_REPORT, verdict: undefined }, /\$\.verdict.*expected a string/],
    [
      "an invalid verdict",
      { ...VALID_REPORT, verdict: "ship-it" },
      /verdict must be one of go, conditional, no-go/,
    ],
    [
      "an unexpected top-level property",
      { ...VALID_REPORT, extra: true },
      /unexpected property "extra"/,
    ],
    [
      "a journey that isn't an object",
      { ...VALID_REPORT, journeys: [null] },
      /\$\.journeys\[0\].*expected an object/,
    ],
    [
      "an invalid journey result",
      {
        ...VALID_REPORT,
        journeys: [{ ...VALID_REPORT.journeys[0], result: "ok" }],
      },
      /result must be one of pass, fail, skip/,
    ],
  ])("rejects %s", (_label, doc, expectedMessage) => {
    expect(() => assertDogfoodReport(doc)).toThrow(expectedMessage);
  });
});

describe("makeCrashStub", () => {
  test("is a valid no-go report", () => {
    const stub = makeCrashStub("deadbeef", "Codex exited 1.");
    expect(() => assertDogfoodReport(stub)).not.toThrow();
    expect(stub.verdict).toBe("no-go");
    expect(stub.journeys).toEqual([]);
    expect(stub.blockers).toEqual(["Codex exited 1."]);
  });
});

describe("renderDogfoodComment", () => {
  const footer = {
    runUrl: "https://example.com/run/9",
    model: "gpt-5.6-luna",
  };

  test("carries the marker, verdict heading, and run URL", () => {
    const body = renderDogfoodComment(VALID_REPORT, footer);
    expect(body).toContain(AI_DOGFOOD_MARKER);
    expect(body).toContain("## Functional dogfood: `go`");
    expect(body).toContain(footer.runUrl);
    expect(body).toContain("`gpt-5.6-luna`");
    expect(body).toContain("create-link-push");
  });

  test("redacts a secret-shaped substring in model-provided text", () => {
    const body = renderDogfoodComment(
      {
        ...VALID_REPORT,
        summary: `leaked sbp_${"a".repeat(40)}`,
      },
      footer,
    );
    expect(body).not.toContain(`sbp_${"a".repeat(40)}`);
    expect(body).toContain("«redacted»");
  });

  test("neutralizes @mentions in notes", () => {
    const body = renderDogfoodComment(
      {
        ...VALID_REPORT,
        journeys: [
          {
            id: "x",
            commands: ["db start"],
            result: "fail",
            notes: "Ask @maintainer about #123",
          },
        ],
      },
      footer,
    );
    expect(body).not.toContain("@maintainer");
    expect(body).toContain("@<!---->maintainer");
  });
});

describe("extractDogfoodVerdict", () => {
  test("reads the verdict from a rendered comment", () => {
    const body = renderDogfoodComment(
      { ...VALID_REPORT, verdict: "conditional" },
      { runUrl: "https://example.com/run/1", model: "gpt-5.6-luna" },
    );
    expect(extractDogfoodVerdict(body)).toBe("conditional");
  });

  test("returns undefined without the marker", () => {
    expect(extractDogfoodVerdict("## Functional dogfood: `go`")).toBeUndefined();
  });
});

describe("pickLatestDogfoodComment", () => {
  test("returns the last bot-authored marker comment", () => {
    const comments: IssueComment[] = [
      { id: 1, authorLogin: "github-actions[bot]", body: `old\n${AI_DOGFOOD_MARKER}` },
      { id: 2, authorLogin: "human", body: `fake\n${AI_DOGFOOD_MARKER}` },
      { id: 3, authorLogin: "github-actions[bot]", body: `new\n${AI_DOGFOOD_MARKER}` },
    ];
    expect(pickLatestDogfoodComment(comments)?.id).toBe(3);
  });

  test("ignores a marker pasted by a non-bot", () => {
    const comments: IssueComment[] = [
      { id: 1, authorLogin: "rando", body: `spoof\n${AI_DOGFOOD_MARKER}` },
    ];
    expect(pickLatestDogfoodComment(comments)).toBeUndefined();
  });
});

describe("fetchDogfoodReport / postDogfoodComment", () => {
  test("fetch returns empty body when no report exists", async () => {
    const io: ReportIo = {
      listIssueComments: () => Promise.resolve([]),
      postIssueComment: () => Promise.resolve(),
    };
    const result = await fetchDogfoodReport(io, 42);
    expect(result).toEqual({ body: "", verdict: undefined });
  });

  test("fetch returns the latest bot report and its verdict", async () => {
    const body = renderDogfoodComment(
      { ...VALID_REPORT, verdict: "no-go" },
      { runUrl: "https://example.com/run/1", model: "gpt-5.6-luna" },
    );
    const io: ReportIo = {
      listIssueComments: () =>
        Promise.resolve([{ id: 9, authorLogin: "github-actions[bot]", body }]),
      postIssueComment: () => Promise.resolve(),
    };
    const result = await fetchDogfoodReport(io, 42);
    expect(result.verdict).toBe("no-go");
    expect(result.body).toContain(AI_DOGFOOD_MARKER);
  });

  test("fetchDogfoodReportOrEmpty returns empty on list failure instead of throwing", async () => {
    const io: ReportIo = {
      listIssueComments: () => Promise.reject(new Error("GitHub request failed (403)")),
      postIssueComment: () => Promise.resolve(),
    };
    const result = await fetchDogfoodReportOrEmpty(io, 42);
    expect(result).toEqual({ body: "", verdict: undefined });
  });

  test("post sends a marker-bearing comment", async () => {
    const posted: string[] = [];
    const io: ReportIo = {
      listIssueComments: () => Promise.resolve([]),
      postIssueComment: (_pr, body) => {
        posted.push(body);
        return Promise.resolve();
      },
    };
    await postDogfoodComment(io, 7, VALID_REPORT, {
      runUrl: "https://example.com/run/2",
      model: "gpt-5.6-luna",
    });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain(AI_DOGFOOD_MARKER);
    expect(posted[0]).toContain("## Functional dogfood: `go`");
  });
});
