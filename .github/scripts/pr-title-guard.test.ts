import { describe, expect, test } from "bun:test";
import { evaluateTitle } from "./pr-title-guard.ts";

describe("evaluateTitle", () => {
  const cases: [string, string, string, string | undefined, boolean][] = [
    ["breaking into develop fails", "feat(cli)!: drop thing", "develop", "feature/x", false],
    ["breaking into next passes", "feat(cli)!: drop thing", "next", "feature/x", true],
    ["next to develop cut from this repo passes", "feat(cli)!: v3", "develop", "next", true],
    ["next to main still fails", "feat(cli)!: v3", "main", "next", false],
    ["non-breaking into develop passes", "fix(cli): repair", "develop", "feature/x", true],
    ["non-conventional title passes", "Update readme", "develop", "feature/x", true],
    ["breaking into v2.x fails", "feat!: drop thing", "v2.x", "hotfix/x", false],
    ["breaking into main fails", "fix(cli)!: drop thing", "main", "hotfix/x", false],
    [
      "merge_group ref form fails",
      "feat(cli)!: drop thing (#12)",
      "refs/heads/develop",
      undefined,
      false,
    ],
    [
      "merge_group ref form into next passes",
      "feat(cli)!: drop thing (#12)",
      "refs/heads/next",
      undefined,
      true,
    ],
    ["only the first line counts", "fix: a\n\nfeat!: b", "develop", undefined, true],
    ["multi-line breaking first line fails", "feat!: a\n\nbody", "develop", undefined, false],
  ];

  test.each(cases)("%s", (_name, title, baseRef, headRef, ok) => {
    const repo = "supabase/cli";
    expect(evaluateTitle({ title, baseRef, headRef, headRepo: repo, baseRepo: repo }).ok).toBe(ok);
  });

  test("a fork branch named next does not get the cut exemption", () => {
    const result = evaluateTitle({
      title: "feat(cli)!: v3",
      baseRef: "develop",
      headRef: "next",
      headRepo: "someone/cli",
      baseRepo: "supabase/cli",
    });
    expect(result.ok).toBe(false);
  });

  test("the cut exemption needs both repositories to be known", () => {
    const result = evaluateTitle({ title: "feat(cli)!: v3", baseRef: "develop", headRef: "next" });
    expect(result.ok).toBe(false);
  });

  test("failure message names the base and the target", () => {
    const result = evaluateTitle({ title: "feat!: x", baseRef: "refs/heads/develop" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("`next`");
      expect(result.message).toContain("`develop`");
    }
  });
});
