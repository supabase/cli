import { expect, it } from "@effect/vitest";
import { slimImageMirrors } from "./Artifacts.ts";

it("rewrites a GHCR catalog image onto ECR Public and keeps the tag and digest", () => {
  expect(
    slimImageMirrors(
      "ghcr.io/supabase/cli/postgres:17.6.1.173@sha256:9d6e542382946cad5eb1f11f1c8108a51297902ee42fe5098358816d3784ba5a",
    ),
  ).toEqual([
    "public.ecr.aws/supabase/cli/postgres:17.6.1.173@sha256:9d6e542382946cad5eb1f11f1c8108a51297902ee42fe5098358816d3784ba5a",
  ]);
});

it("returns no mirror for an image outside the slim catalog registry", () => {
  expect(slimImageMirrors("public.ecr.aws/supabase/postgres:17.6.1.173")).toEqual([]);
});
