import { expect, it } from "@effect/vitest";
import { slimImageMirrors } from "./Artifacts.ts";

it("rewrites a GHCR catalog image onto ECR Public and keeps the tag and digest", () => {
  expect(
    slimImageMirrors(
      "ghcr.io/supabase/cli/postgres:17.6.1.173@sha256:1581c433d71a48a81e356a3ed2d4aa5ecfc8fc0465ea98661da7a88023317dcf",
    ),
  ).toEqual([
    "public.ecr.aws/supabase/cli/postgres:17.6.1.173@sha256:1581c433d71a48a81e356a3ed2d4aa5ecfc8fc0465ea98661da7a88023317dcf",
  ]);
});

it("returns no mirror for an image outside the slim catalog registry", () => {
  expect(slimImageMirrors("public.ecr.aws/supabase/postgres:17.6.1.173")).toEqual([]);
});
