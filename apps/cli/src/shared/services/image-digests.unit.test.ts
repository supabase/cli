import { describe, expect, it } from "vitest";

import { dockerfileServiceImages } from "./dockerfile-images.ts";
import { IMAGE_DIGESTS } from "./image-digests.generated.ts";
import { imageDigest } from "./image-digests.ts";

describe("imageDigest", () => {
  it("pins every Dockerfile image, and nothing else", () => {
    const pinned = dockerfileServiceImages.map(({ image }) => image).sort();
    expect(
      Object.keys(IMAGE_DIGESTS).sort(),
      "run `pnpm images:digests` after changing the Dockerfile pins",
    ).toEqual(pinned);
    for (const image of pinned) {
      expect(imageDigest(image), image).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
    expect(new Set(pinned.map((image) => image.slice(image.lastIndexOf("/") + 1))).size).toBe(
      pinned.length,
    );
  });

  it("matches a pin on any registry, only by its name:tag segment, never for a slim build", () => {
    expect(imageDigest("public.ecr.aws/supabase/postgres-meta:v0.99.0")).toBe(
      imageDigest("supabase/postgres-meta:v0.99.0"),
    );
    expect(imageDigest("supabase/postgres-meta:v0.98.0")).toBeUndefined();
    expect(imageDigest("ghcr.io/supabase/cli/postgres-meta:v0.99.0")).toBeUndefined();
  });
});
