import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

/**
 * Regression coverage for the iterative (not recursive) ancestor walk-up rewrite in
 * `canonicalPathForContainment` (CLI-2339's symlink-containment hardening pass) — a security
 * review found the earlier, fully-recursive walk-up blew the JS call stack around ~20,000 missing
 * path components.
 *
 * A REAL filesystem cannot actually construct a path this deep: every real syscall
 * (`realpathSync`/`lstatSync`) enforces the OS's own `PATH_MAX` (~1024 bytes on macOS, ~4096 on
 * Linux), which caps a real missing-component chain at a few hundred to low thousands of
 * components — nowhere near the 5,000 needed to meaningfully exercise (and rule out a stack-depth
 * regression in) the walk-up loop itself. This file mocks `node:fs` at the filesystem boundary
 * instead — the sanctioned seam for this kind of test per this workspace's testing conventions —
 * so the loop's OWN iteration count is what's under test, not the host OS's path-length limit.
 * Isolated into its own file (rather than folded into `legacy-config-validate.unit.test.ts`)
 * because `vi.mock` is file-scoped: every other test in that file relies on a REAL filesystem
 * (real symlinks, real dangling/looping targets), which a module-wide `node:fs` mock would break.
 */
vi.mock("node:fs", () => ({
  realpathSync: vi.fn((path: string) => {
    if (path === FAKE_EXISTING_BASE) return FAKE_EXISTING_BASE;
    throw Object.assign(new Error(`ENOENT: no such file or directory, realpath '${path}'`), {
      code: "ENOENT",
    });
  }),
  lstatSync: vi.fn(() => undefined),
  readlinkSync: vi.fn(() => {
    throw new Error("readlinkSync should never be reached — no path in this fixture is a symlink");
  }),
  statSync: vi.fn(() => {
    throw new Error("statSync should never be reached by the template content_path branch");
  }),
}));

const FAKE_EXISTING_BASE = "/fake/project-root";

describe("canonicalPathForContainment (via legacyResolveEmailTemplateContentPath)", () => {
  it("resolves a 5,000-component-deep missing content_path without blowing the call stack", async () => {
    const { legacyResolveEmailTemplateContentPath } = await import("./legacy-config-validate.ts");

    const missingSegments = Array.from({ length: 5000 }, (_, i) => `missing-${i}`);
    const contentPath = `${missingSegments.join("/")}/invite.html`;

    const resolved = legacyResolveEmailTemplateContentPath({
      section: "template",
      name: "invite",
      contentPath,
      contentPresent: false,
      base: FAKE_EXISTING_BASE,
    });

    expect(resolved).toBe(join(FAKE_EXISTING_BASE, contentPath));
  });
});
