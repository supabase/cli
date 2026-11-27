import { Option } from "effect";
import overviewBody from "./overview.md" with { type: "text" };

export const topics = [
  {
    slug: "overview",
    title: "Supabase CLI: agent overview",
    summary: "Core rules, targeting, consent, and the topic index.",
    body: overviewBody,
  },
] as const;

export type SkillTopic = (typeof topics)[number];
export type SkillTopicSlug = SkillTopic["slug"];

export const topicSlugs: ReadonlyArray<SkillTopicSlug> = topics.map((topic) => topic.slug);

/** Finds a topic by slug, ignoring surrounding whitespace and case. */
export const resolveTopic = (input: string): Option.Option<SkillTopic> => {
  const slug = input.trim().toLowerCase();
  return Option.fromNullishOr(topics.find((topic) => topic.slug === slug));
};
