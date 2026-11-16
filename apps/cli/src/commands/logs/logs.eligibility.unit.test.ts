import { expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, Option } from "effect";
import { OutputFormatFlag } from "../../command-internal/global-flags.ts";
import { mockOutput, mockTty } from "../../../tests/helpers/mocks.ts";
import { useLogsBrowser } from "./logs.browser.ts";

it.effect.each([
  { explicit: false, env: {}, expected: true },
  { explicit: true, env: {}, expected: false },
  { explicit: false, env: { CI: "true" }, expected: false },
  { explicit: false, env: { TERM: "dumb" }, expected: false },
  { explicit: false, env: { CI: "false", TERM: "xterm" }, expected: true },
])(
  "selects browser with explicit text $explicit and environment $env",
  ({ explicit, env, expected }) =>
    Effect.gen(function* () {
      expect(yield* useLogsBrowser()).toBe(expected);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          mockOutput({ format: "text", interactive: true }).layer,
          mockTty({ stdinIsTty: true, stdoutIsTty: true }),
          Layer.succeed(OutputFormatFlag, explicit ? Option.some("text") : Option.none()),
          ConfigProvider.layer(ConfigProvider.fromUnknown(env)),
        ),
      ),
    ),
);
