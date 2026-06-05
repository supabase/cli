import { describe, expect, it } from "vitest";

import { suggestAppStart } from "./bootstrap.suggest.ts";

// Ports Go's `bootstrap_test.go::TestSuggestAppStart`. Colour is identity here so
// the assertions match Go's non-TTY (uncoloured) output byte-for-byte.
describe("suggestAppStart", () => {
  it("suggests the start command when the workdir is the current directory", () => {
    expect(suggestAppStart("/home/me/app", "/home/me/app", "npm ci && npm run dev")).toBe(
      "To start your app:\n  npm ci && npm run dev",
    );
  });

  it("prefixes a cd line when the workdir is nested", () => {
    expect(suggestAppStart("/home/me", "/home/me/app", "npm ci && npm run dev")).toBe(
      "To start your app:\n  cd app\n  npm ci && npm run dev",
    );
  });

  it("omits the cd line for a '.' relative path", () => {
    expect(suggestAppStart("/home/me/app", "/home/me/app", "supabase start")).toBe(
      "To start your app:\n  supabase start",
    );
  });

  it("omits the command line when the start command is empty", () => {
    expect(suggestAppStart("/home/me", "/home/me/app", "")).toBe("To start your app:\n  cd app");
  });

  it("applies the colorize callback to each command line", () => {
    const aqua = (line: string) => `<${line}>`;
    expect(suggestAppStart("/home/me", "/home/me/app", "npm run dev", aqua)).toBe(
      "To start your app:\n  <cd app>\n  <npm run dev>",
    );
  });
});
