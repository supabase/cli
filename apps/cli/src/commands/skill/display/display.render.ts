import { topics } from "../content/topics.ts";

interface RenderableTopic {
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly body: string;
}

const STABLE_OR_PRERELEASE = /^[1-9]\d*\.\d+\.\d+(-(beta|next)\.\d+)?$/;
const RELEASES_URL = "https://github.com/supabase/cli/releases";
const CLI_REFERENCE_URL = "https://supabase.com/docs/reference/cli/introduction";

/** Release page for a published version; the releases index for dev, test, and unrecognized versions. */
export const releaseNotesUrl = (version: string): string =>
  STABLE_OR_PRERELEASE.test(version) ? `${RELEASES_URL}/tag/v${version}` : RELEASES_URL;

/** Renders a topic as markdown ending in a single newline. */
export const renderTopic = (
  topic: RenderableTopic,
  version: string,
  registry: ReadonlyArray<RenderableTopic> = topics,
): string => {
  const others = registry.filter((other) => other.slug !== topic.slug);
  const moreTopics =
    others.length === 0
      ? []
      : [
          "## More topics",
          "",
          ...others.map((other) => `- \`supabase skill display ${other.slug}\`: ${other.summary}`),
          "",
        ];
  return [
    `# ${topic.title}`,
    "",
    `> Guidance for Supabase CLI ${version}. If a command or flag here fails, run \`supabase <command> --help\`; the help output is authoritative.`,
    "",
    topic.body.trim(),
    "",
    "---",
    "",
    ...moreTopics,
    "## Links",
    "",
    `- ${STABLE_OR_PRERELEASE.test(version) ? "Release notes for this version" : "CLI releases"}: ${releaseNotesUrl(version)}`,
    `- CLI reference: ${CLI_REFERENCE_URL}`,
    "",
  ].join("\n");
};
