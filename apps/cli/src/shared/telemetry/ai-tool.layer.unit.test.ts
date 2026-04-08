import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { processEnvLayer } from "../../../tests/helpers/mocks.ts";
import { aiToolLayer } from "./ai-tool.layer.ts";
import { AiTool } from "./ai-tool.service.ts";

describe("aiToolLayer", () => {
  it.live("detects Codex environments via @vercel/detect-agent", () =>
    Effect.gen(function* () {
      const aiTool = yield* AiTool;
      expect(aiTool.name).toEqual(Option.some("codex"));
    }).pipe(Effect.provide(aiToolLayer), Effect.provide(processEnvLayer({ CODEX_SANDBOX: "1" }))),
  );

  it.live("normalizes known agent names for analytics properties", () =>
    Effect.gen(function* () {
      const aiTool = yield* AiTool;
      expect(aiTool.name).toEqual(Option.some("github_copilot"));
    }).pipe(
      Effect.provide(aiToolLayer),
      Effect.provide(processEnvLayer({ AI_AGENT: "github-copilot-cli" })),
    ),
  );

  it.live("returns none when no supported agent is detected", () =>
    Effect.gen(function* () {
      const aiTool = yield* AiTool;
      expect(aiTool.name).toEqual(Option.none());
    }).pipe(Effect.provide(aiToolLayer), Effect.provide(processEnvLayer({}))),
  );
});
