import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  InvalidComputeTemplateError,
  parseComputeTemplate,
  type ComputeTemplateSpec,
} from "./compute-template.ts";

const parse = (raw: string): ComputeTemplateSpec => Effect.runSync(parseComputeTemplate(raw));

const refusal = (raw: string): InvalidComputeTemplateError =>
  Effect.runSync(parseComputeTemplate(raw).pipe(Effect.flip));

describe("parseComputeTemplate", () => {
  it("reads a GitHub owner/repo slug as an https clone URL", () => {
    expect(parse("supabase/compute-starters")).toEqual({
      url: "https://github.com/supabase/compute-starters.git",
      ref: undefined,
      subdir: [],
      display: "supabase/compute-starters",
    });
  });

  it("reads trailing slug segments as a subdirectory", () => {
    expect(parse("supabase/compute-starters/examples/hono")).toMatchObject({
      url: "https://github.com/supabase/compute-starters.git",
      subdir: ["examples", "hono"],
    });
  });

  it("pins a branch, tag or commit given after #", () => {
    expect(parse("supabase/starters#v2.1.0")).toMatchObject({ ref: "v2.1.0" });
    expect(parse("supabase/starters/api#3f4b0c0")).toMatchObject({
      ref: "3f4b0c0",
      subdir: ["api"],
    });
  });

  it("reads the github.com URL a browser produces, including /tree/<ref>/<subdir>", () => {
    expect(parse("https://github.com/supabase/starters")).toMatchObject({
      url: "https://github.com/supabase/starters.git",
      ref: undefined,
      subdir: [],
    });
    expect(parse("https://github.com/supabase/starters.git")).toMatchObject({
      url: "https://github.com/supabase/starters.git",
    });
    expect(parse("https://github.com/supabase/starters/tree/main/examples/api")).toMatchObject({
      url: "https://github.com/supabase/starters.git",
      ref: "main",
      subdir: ["examples", "api"],
    });
  });

  // `tree` is only a ref marker in a github.com URL; in a slug it is a directory
  // name like any other.
  it("treats a tree segment in a bare slug as a directory", () => {
    expect(parse("supabase/starters/tree/main")).toMatchObject({
      subdir: ["tree", "main"],
      ref: undefined,
    });
  });

  it("passes any other cloneable URL through untouched", () => {
    expect(parse("https://gitlab.com/acme/api.git#v2")).toEqual({
      url: "https://gitlab.com/acme/api.git",
      ref: "v2",
      subdir: [],
      display: "https://gitlab.com/acme/api.git#v2",
    });
    expect(parse("git@github.com:supabase/starters.git")).toMatchObject({
      url: "git@github.com:supabase/starters.git",
    });
    expect(parse("ssh://git@git.acme.dev:2222/acme/api")).toMatchObject({
      url: "ssh://git@git.acme.dev:2222/acme/api",
    });
    expect(parse("file:///srv/templates/api")).toMatchObject({
      url: "file:///srv/templates/api",
    });
    expect(parse("/srv/templates/api")).toMatchObject({ url: "/srv/templates/api" });
  });

  // A non-GitHub URL has no syntax marking where the repository ends, so the whole
  // repository is the template.
  it("does not read a subdirectory out of a non-GitHub URL", () => {
    expect(parse("https://gitlab.com/acme/api/examples/hono")).toMatchObject({
      url: "https://gitlab.com/acme/api/examples/hono",
      subdir: [],
    });
  });

  it.each([
    { raw: "", why: "is empty" },
    { raw: "   ", why: "is empty" },
    { raw: "--upload-pack=touch /tmp/x", why: "starts with a hyphen" },
    { raw: "#main", why: "names a ref with no repository" },
    { raw: "supabase/starters#--flag", why: "not a branch, tag or commit" },
    { raw: "supabase/starters#", why: "not a branch, tag or commit" },
    { raw: "supabase", why: "neither a GitHub owner/repo slug nor a URL" },
    { raw: "ext::sh -c whoami", why: "neither a GitHub owner/repo slug nor a URL" },
    { raw: "supabase/starters/../../etc", why: "not a path inside the repository" },
    { raw: "supabase/starters/a\\..\\b", why: "not a path inside the repository" },
    {
      raw: "https://github.com/supabase/starters/tree/main/api#dev",
      why: "names a ref twice",
    },
    { raw: "https://github.com/supabase/starters/tree", why: "ends at /tree" },
  ])("refuses $raw", ({ raw, why }) => {
    const error = refusal(raw);
    expect(error).toBeInstanceOf(InvalidComputeTemplateError);
    expect(error.detail).toContain(why);
    expect(error.suggestion).toContain("--template");
  });
});
