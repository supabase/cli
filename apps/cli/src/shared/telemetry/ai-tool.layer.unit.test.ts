import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { makeAiToolLayer } from "./ai-tool.layer.ts";
import { AiTool } from "./ai-tool.service.ts";

describe("aiToolLayer", () => {
  it.live("detects Codex environments via @vercel/detect-agent", () =>
    Effect.gen(function* () {
      const aiTool = yield* AiTool;
      expect(aiTool.name).toEqual(Option.some("codex"));
    }).pipe(
      Effect.provide(
        makeAiToolLayer(() => Promise.resolve({ isAgent: true, agent: { name: "codex" } })),
      ),
    ),
  );

  it.live("normalizes known agent names for analytics properties", () =>
    Effect.gen(function* () {
      const aiTool = yield* AiTool;
      expect(aiTool.name).toEqual(Option.some("github_copilot"));
    }).pipe(
      Effect.provide(
        makeAiToolLayer(() =>
          Promise.resolve({ isAgent: true, agent: { name: "github-copilot" } }),
        ),
      ),
    ),
  );

  it.live("returns none when no supported agent is detected", () =>
    Effect.gen(function* () {
      const aiTool = yield* AiTool;
      expect(aiTool.name).toEqual(Option.none());
    }).pipe(
      Effect.provide(makeAiToolLayer(() => Promise.resolve({ isAgent: false, agent: undefined }))),
    ),
  );
});
