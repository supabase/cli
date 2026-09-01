import { describe, expect, test } from "vitest";
import { renderStepSummary, toGithubOutputLines, type ReleasePlan } from "./release-plan.ts";

const duePublicPlan: ReleasePlan = {
  due: true,
  version: "0.2.0",
  bumpType: "minor",
  notes: "### Features\n\n* **config:** add a thing\n",
  isPrivate: false,
};

describe("toGithubOutputLines", () => {
  test("a due release on a public package releases under the latest dist-tag", () => {
    expect(toGithubOutputLines(duePublicPlan)).toEqual([
      "should_release=true",
      "version=0.2.0",
      "npm_tag=latest",
      "blocked_on_private=false",
    ]);
  });

  test("a due release on a still-private package keeps the version but blocks the release", () => {
    expect(toGithubOutputLines({ ...duePublicPlan, isPrivate: true })).toEqual([
      "should_release=false",
      "version=0.2.0",
      "npm_tag=latest",
      "blocked_on_private=true",
    ]);
  });

  test("no due release emits an empty version sentinel the workflow's if: guards key off", () => {
    expect(toGithubOutputLines({ due: false })).toEqual([
      "should_release=false",
      "version=",
      "npm_tag=latest",
      "blocked_on_private=false",
    ]);
  });
});

describe("renderStepSummary", () => {
  test("reports when no releasable commits touched the package", () => {
    const summary = renderStepSummary({ due: false });

    expect(summary).toContain("## @supabase/config release plan");
    expect(summary).toContain("No release:");
  });

  test("warns prominently when the package is still private", () => {
    const summary = renderStepSummary({ ...duePublicPlan, isPrivate: true });

    expect(summary).toContain("**0.2.0**");
    expect(summary).toContain("> [!WARNING]");
    expect(summary).toContain("private: true");
  });

  test("fences the commit-derived notes so they cannot render as live markdown", () => {
    const summary = renderStepSummary(duePublicPlan);

    expect(summary).toContain("```markdown");
    expect(summary).toContain("* **config:** add a thing");
  });

  test("a backtick fence inside the notes cannot close the summary's fence", () => {
    const notesWithFence = 'feat: docs with an example\n\n```ts\nconst x = "y";\n```\n';
    const summary = renderStepSummary({ ...duePublicPlan, notes: notesWithFence });

    expect(summary).toContain("````markdown");
    expect(summary).not.toMatch(/^```markdown/m);
  });
});
