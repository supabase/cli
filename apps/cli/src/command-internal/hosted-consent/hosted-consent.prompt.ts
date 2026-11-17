import { Effect, Option } from "effect";

import { Output } from "../../shared/output/output.service.ts";
import { isMachineResourceFormat } from "../../shared/output/resource-format.ts";
import { Tty } from "../../shared/runtime/tty.service.ts";
import { agentDetected } from "../agent-mode.ts";
import { OutputFlag } from "../global-flags.ts";

export interface PromptBlocker {
  readonly reason: string;
  readonly agent: boolean;
}

/**
 * Why this run cannot ask a question, or `None` when it can: text output on an interactive
 * stdout with a TTY stdin, no machine `-o` format, and no agent driving it.
 */
export const promptBlocker = Effect.gen(function* () {
  const output = yield* Output;
  const tty = yield* Tty;
  const outputFlag = yield* OutputFlag;
  if (yield* agentDetected) {
    return Option.some<PromptBlocker>({ reason: "it is running in agent mode", agent: true });
  }
  const blocked = (reason: string) => Option.some<PromptBlocker>({ reason, agent: false });
  if (output.format !== "text") return blocked(`its output format is ${output.format}`);
  if (isMachineResourceFormat(outputFlag)) {
    return blocked(
      `it writes machine-readable -o ${Option.getOrElse(outputFlag, () => "")} output`,
    );
  }
  if (!output.interactive) return blocked("stdout is not a terminal");
  if (!tty.stdinIsTty) return blocked("stdin is not a terminal");
  return Option.none<PromptBlocker>();
});

export const canPrompt = Effect.map(promptBlocker, Option.isNone);
