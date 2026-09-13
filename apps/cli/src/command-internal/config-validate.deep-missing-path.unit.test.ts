import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

/**
 * Exercises `canonicalPathForContainment`'s ancestor walk-up with a 5,000-component missing
 * path — deeper than any real filesystem allows (`PATH_MAX` caps a real OS at a few thousand
 * components), so `node:fs` is mocked here to drive the loop's own iteration count directly.
 * Isolated into its own file because `vi.mock` is file-scoped and would break
 * `config-validate.unit.test.ts`'s reliance on a real filesystem.
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

describe("canonicalPathForContainment (via resolveEmailTemplateContentPath)", () => {
  it("resolves a 5,000-component-deep missing content_path without blowing the call stack", async () => {
    const { resolveEmailTemplateContentPath } = await import("./config-validate.ts");

    const missingSegments = Array.from({ length: 5000 }, (_, i) => `missing-${i}`);
    const contentPath = `${missingSegments.join("/")}/invite.html`;

    const resolved = resolveEmailTemplateContentPath({
      section: "template",
      name: "invite",
      contentPath,
      contentPresent: false,
      base: FAKE_EXISTING_BASE,
    });

    expect(resolved).toBe(join(FAKE_EXISTING_BASE, contentPath));
  });
});
