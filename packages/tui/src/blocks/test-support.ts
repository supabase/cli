import { Effect, Option, Schema } from "effect";

import { makeProgram, run } from "../runtime/public.ts";
import { dropTrailingBlank, withTerminal } from "../runtime/test-support.ts";
import { supabaseTheme } from "../supabase/theme.ts";
import { TestTerminal } from "../terminal/testing.ts";
import type { TestTerminalOptions } from "../terminal/testing.ts";
import * as Theme from "../theme/public.ts";
import { screen } from "../view/public.ts";
import type { Node } from "../view/public.ts";

/**
 * Runs a one-frame program for `node` under the Supabase theme and returns the text and bytes the
 * terminal ended up with; the live region is one column narrower than the terminal.
 */
export const render = (node: Node, options: Partial<TestTerminalOptions> = {}) =>
  withTerminal(
    Effect.gen(function* () {
      const test = yield* TestTerminal;
      yield* run(
        makeProgram({
          Model: Schema.Undefined,
          init: () => ({ model: undefined }),
          update: (model) => ({ model }),
          view: () => screen(node),
          result: () => Option.some("done"),
        }),
      ).pipe(Effect.provide(Theme.layer(supabaseTheme)));
      return {
        lines: dropTrailingBlank(yield* test.scrollback),
        bytes: yield* test.rawBytes,
      };
    }),
    options,
  );
