import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workflow = Bun.YAML.parse(
  readFileSync(new URL("../../workflows/ai-review.yml", import.meta.url), "utf8"),
) as {
  jobs: Record<string, { steps: { name?: string; run?: string }[] }>;
};

function runStep(job: string, name: string, directory: string, env: Record<string, string> = {}) {
  const script = workflow.jobs[job]?.steps.find((step) => step.name === name)?.run;
  if (!script) throw new Error(`Missing runnable step: ${job}/${name}`);
  const result = spawnSync("bash", ["-euo", "pipefail", "-c", script], {
    cwd: directory,
    env: {
      ...process.env,
      GUIDANCE_DIRECTORY: directory,
      GITHUB_OUTPUT: join(directory, "output"),
      ...env,
    },
    encoding: "utf8",
  });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
}

describe("optional guidance workflow boundaries", () => {
  test("a trusted checkout without rollout files produces unavailable guidance and a visible review summary", () => {
    const directory = mkdtempSync(join(tmpdir(), "guidance-rollout-"));
    try {
      // The PR may contain support before the trusted checkout does.
      mkdirSync(join(directory, "pr/.github/scripts/ai-review"), { recursive: true });
      writeFileSync(
        join(directory, "pr/.github/scripts/ai-review/docs-guidance.ts"),
        'throw new Error("Untrusted code must not execute");',
      );
      writeFileSync(join(directory, "output"), "");
      runStep("docs-guidance", "Initialize unavailable guidance", directory);
      runStep("docs-guidance", "Check trusted guidance support", directory);
      expect(readFileSync(join(directory, "output"), "utf8")).toBe("");
      expect(JSON.parse(readFileSync(join(directory, "docs-guidance.json"), "utf8"))).toEqual({
        status: "unavailable",
        sha: null,
        files: [],
      });
      expect(readFileSync(join(directory, "cli-reference-procedure.md"), "utf8")).toContain(
        "Continue ordinary code review",
      );
      const review = {
        summary: "Ordinary review completed.",
        findings: [],
        stats: { claude_total: 0, codex_total: 0 },
      };
      writeFileSync(join(directory, "merged-review.json"), JSON.stringify(review));
      runStep("post-review", "Report guidance status before trusted poster rollout", directory);
      const updated = JSON.parse(readFileSync(join(directory, "merged-review.json"), "utf8"));
      expect(updated.summary).toContain("unavailable during trusted workflow rollout");
      expect(updated.summary).toContain("Ordinary review completed.");
      expect(updated.findings).toEqual([]);
      expect(updated.stats).toEqual(review.stats);
      mkdirSync(join(directory, ".github/scripts/ai-review"), { recursive: true });
      mkdirSync(join(directory, ".agents/skills/cli-reference"), { recursive: true });
      for (const path of [
        ".github/scripts/ai-review/docs-guidance.ts",
        ".github/scripts/ai-review/docs-guidance-status.ts",
        ".agents/skills/cli-reference/review-procedure.md",
      ]) {
        writeFileSync(join(directory, path), "Support exists, but this check must not execute it.");
      }
      runStep("docs-guidance", "Check trusted guidance support", directory);
      expect(readFileSync(join(directory, "output"), "utf8")).toBe("available=true\n");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test.each(["claude-review", "codex-review", "adjudicate", "post-review"])(
    "%s discards a partial download and preserves a successful snapshot",
    (job) => {
      const directory = mkdtempSync(join(tmpdir(), "guidance-delivery-"));
      try {
        mkdirSync(join(directory, "docs-guidance"));
        writeFileSync(join(directory, "docs-guidance/README.md"), "# Partial guide\n");
        const manifest = JSON.stringify({ status: "available", sha: "a".repeat(40), files: [] });
        writeFileSync(join(directory, "docs-guidance.json"), manifest);
        runStep(job, "Handle unavailable guidance", directory, { GUIDANCE_DOWNLOAD_OK: "true" });
        expect(readFileSync(join(directory, "docs-guidance.json"), "utf8")).toBe(manifest);
        runStep(job, "Handle unavailable guidance", directory, { GUIDANCE_DOWNLOAD_OK: "false" });
        expect(JSON.parse(readFileSync(join(directory, "docs-guidance.json"), "utf8"))).toEqual({
          status: "unavailable",
          sha: null,
          files: [],
        });
        expect(Bun.file(join(directory, "docs-guidance/README.md")).size).toBe(0);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  test("poster validation remains runnable without installed Effect dependencies", () => {
    const directory = mkdtempSync(join(tmpdir(), "guidance-poster-"));
    try {
      for (const name of ["post-review.ts", "docs-guidance-status.ts"]) {
        copyFileSync(new URL(name, import.meta.url), join(directory, name));
      }
      writeFileSync(
        join(directory, "findings.json"),
        JSON.stringify({ summary: "Reviewed", findings: [] }),
      );
      const result = spawnSync(
        process.execPath,
        [join(directory, "post-review.ts"), "validate-findings", join(directory, "findings.json")],
        {
          cwd: directory,
          encoding: "utf8",
          env: { PATH: process.env.PATH },
        },
      );
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("matches the findings schema");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
