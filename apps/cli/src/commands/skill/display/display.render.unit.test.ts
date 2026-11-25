import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Sink, Stdio, Stream } from "effect";

import { mockTty } from "../../../../tests/helpers/mocks.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { outputLayerFor } from "../../../shared/output/output.layer.ts";
import type { OutputFormat } from "../../../shared/output/types.ts";
import { topics } from "../content/topics.ts";
import { releaseNotesUrl, renderTopic } from "./display.render.ts";

const [overview] = topics;

const secondTopic = {
  slug: "second",
  title: "Second",
  summary: "Second summary.",
  body: "Second body\n",
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

  it("omits the more-topics section when the topic is the only one", () => {
    expect(renderTopic(overview, "3.4.5")).not.toContain("## More topics");
  });
});

describe("renderTopic with several topics", () => {
  it("lists every other topic in registry order and not the current one", () => {
    const text = renderTopic(overview, "3.4.5", [overview, secondTopic]);
    expect(text).toContain(
      "## More topics\n\n- `supabase skill display second`: Second summary.\n",
    );
    expect(text).not.toContain(`supabase skill display ${overview.slug}\``);
  });
});

function captureStdout() {
  const chunks: Array<string> = [];
  const layer = Layer.succeed(
    Stdio.Stdio,
    Stdio.make({
      args: Effect.succeed([]),
      stdin: Stream.empty,
      stdout: () =>
        Sink.forEach((item: string | Uint8Array) =>
          Effect.sync(() => {
            chunks.push(typeof item === "string" ? item : new TextDecoder().decode(item));
          }),
        ),
      stderr: () => Sink.forEach(() => Effect.void),
    }),
  );
  return { layer, chunks };
}

describe("output.raw with rendered markdown", () => {
  it.effect("writes identical bytes in text, json, and stream-json output", () =>
    Effect.gen(function* () {
      const text = renderTopic(overview, "3.4.5");
      const written: Array<string> = [];
      const formats: ReadonlyArray<OutputFormat> = ["text", "json", "stream-json"];
      for (const format of formats) {
        const stdout = captureStdout();
        yield* Effect.gen(function* () {
          const output = yield* Output;
          yield* output.raw(text);
        }).pipe(
          Effect.provide(
            outputLayerFor(format).pipe(
              Layer.provide(Layer.mergeAll(stdout.layer, mockTty({ stdoutIsTty: false }))),
            ),
          ),
        );
        written.push(stdout.chunks.join(""));
      }
      expect(written).toEqual([text, text, text]);
    }),
  );
});
