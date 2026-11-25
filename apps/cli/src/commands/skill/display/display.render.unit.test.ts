import { describe, expect, it } from "@effect/vitest";

import { topics } from "../content/topics.ts";
import { releaseNotesUrl, renderTopic } from "./display.render.ts";

const [overview] = topics;

const secondTopic = {
  slug: "second",
  title: "Second",
  summary: "Second summary.",
  body: "Second body\n",
};

const thirdTopic = {
  slug: "third",
  title: "Third",
  summary: "Third summary.",
  body: "Third body\n",
};

describe("releaseNotesUrl", () => {
  it.each([
    ["3.4.5", "https://github.com/supabase/cli/releases/tag/v3.4.5"],
    ["3.5.0-beta.2", "https://github.com/supabase/cli/releases/tag/v3.5.0-beta.2"],
    ["4.0.0-next.1", "https://github.com/supabase/cli/releases/tag/v4.0.0-next.1"],
    ["0.0.0-dev", "https://github.com/supabase/cli/releases"],
    ["0.0.0-test", "https://github.com/supabase/cli/releases"],
    ["not a version", "https://github.com/supabase/cli/releases"],
  ])("maps %s to its release page", (version, url) => {
    expect(releaseNotesUrl(version)).toBe(url);
  });
});

describe("renderTopic", () => {
  it("puts the title, the given version, and the body in the header", () => {
    const text = renderTopic(overview, "3.4.5");
    expect(text.startsWith(`# ${overview.title}\n\n> Guidance for Supabase CLI 3.4.5.`)).toBe(true);
    expect(text).toContain(overview.body.trim());
  });

  it("ends with the exact link set and a single trailing newline", () => {
    const text = renderTopic(overview, "3.4.5");
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
    expect(text.slice(text.lastIndexOf("## Links"))).toBe(
      "## Links\n\n" +
        "- Release notes for this version: https://github.com/supabase/cli/releases/tag/v3.4.5\n" +
        "- CLI reference: https://supabase.com/docs/reference/cli/introduction\n",
    );
  });

  it("labels the fallback link as the releases index for dev versions", () => {
    const text = renderTopic(overview, "0.0.0-dev");
    expect(text).toContain("- CLI releases: https://github.com/supabase/cli/releases\n");
    expect(text).not.toContain("Release notes for this version");
  });

  it("omits the more-topics section when the topic is the only one", () => {
    expect(renderTopic(overview, "3.4.5")).not.toContain("## More topics");
  });
});

describe("renderTopic with several topics", () => {
  it("lists every other topic in registry order and not the current one", () => {
    const text = renderTopic(overview, "3.4.5", [overview, secondTopic, thirdTopic]);
    expect(text).toContain(
      "## More topics\n\n" +
        "- `supabase skill display second`: Second summary.\n" +
        "- `supabase skill display third`: Third summary.\n",
    );
    expect(text).not.toContain(`supabase skill display ${overview.slug}\``);
  });
});
