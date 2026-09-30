import { describe, expect, it } from "vitest";

import { dockerfileServiceImageRaw } from "../../shared/services/dockerfile-images.ts";
import { toSlimImage } from "../../shared/services/slim-images.ts";
import { resolvePinnedImage } from "./pinned-image.ts";

const currentTag = (alias: string) => dockerfileServiceImageRaw(alias).split(":")[1] ?? "";
const currentAuth = dockerfileServiceImageRaw("gotrue");
const currentAuthTag = currentTag("gotrue");
const currentPooler = dockerfileServiceImageRaw("supavisor");
const currentPoolerTag = currentTag("supavisor");
const currentPostgres = dockerfileServiceImageRaw("pg");
const currentPostgresTag = currentTag("pg");

describe("resolvePinnedImage", () => {
  it("resolves docker.io images while the slim flag is off", () => {
    expect(resolvePinnedImage("gotrue", "auth", {}, false)).toBe(currentAuth);
    expect(resolvePinnedImage("gotrue", "auth", { auth: "v2.100.0" }, false)).toBe(
      "supabase/gotrue:v2.100.0",
    );
    expect(resolvePinnedImage("supavisor", "pooler", { pooler: "2.0.0" }, false)).toBe(
      "supabase/supavisor:2.0.0",
    );
  });

  it("resolves slim images when the flag is on and the pin is current", () => {
    expect(resolvePinnedImage("gotrue", "auth", {}, true)).toBe(toSlimImage("gotrue", currentAuth));
    expect(resolvePinnedImage("gotrue", "auth", { auth: currentAuthTag }, true)).toBe(
      toSlimImage("gotrue", currentAuth),
    );
  });

  it("keeps a historical pin on docker.io", () => {
    expect(resolvePinnedImage("gotrue", "auth", { auth: "v2.100.0" }, true)).toBe(
      "supabase/gotrue:v2.100.0",
    );
    expect(resolvePinnedImage("storage", "storage", { storage: "v1.67.0" }, true)).toBe(
      "supabase/storage-api:v1.67.0",
    );
    expect(resolvePinnedImage("supavisor", "pooler", { pooler: "2.0.0" }, true)).toBe(
      "supabase/supavisor:2.0.0",
    );
  });

  it("normalizes a current pooler pin onto the slim tag scheme", () => {
    expect(resolvePinnedImage("supavisor", "pooler", { pooler: currentPoolerTag }, true)).toBe(
      toSlimImage("supavisor", currentPooler),
    );
    expect(
      resolvePinnedImage(
        "supavisor",
        "pooler",
        {
          pooler: currentPoolerTag.startsWith("v")
            ? currentPoolerTag.slice(1)
            : `v${currentPoolerTag}`,
        },
        true,
      ),
    ).toBe(toSlimImage("supavisor", currentPooler));
  });

  it("keeps a historical postgres pin on docker.io", () => {
    expect(resolvePinnedImage("pg", "postgres", { postgres: "17.4.1.1" }, false)).toBe(
      "supabase/postgres:17.4.1.1",
    );
    expect(resolvePinnedImage("pg", "postgres", { postgres: "17.4.1.1" }, true)).toBe(
      "supabase/postgres:17.4.1.1",
    );
    expect(resolvePinnedImage("pg", "postgres", { postgres: currentPostgresTag }, true)).toBe(
      toSlimImage("pg", currentPostgres),
    );
  });
});
