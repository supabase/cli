import { describe, expect, test } from "vitest";

import {
  buildImgproxyContainerSpec,
  buildImgproxyEnv,
  type ImgproxyContainerSpecInput,
} from "./imgproxy.service.ts";

describe("buildImgproxyEnv", () => {
  test("matches Go's fully static Env literal, including the literal (non-boolean) IMGPROXY_USE_ETAG value", () => {
    expect(buildImgproxyEnv()).toEqual({
      IMGPROXY_BIND: ":5001",
      IMGPROXY_LOCAL_FILESYSTEM_ROOT: "/",
      IMGPROXY_USE_ETAG: "/",
      IMGPROXY_MAX_SRC_RESOLUTION: "50",
      IMGPROXY_MAX_SRC_FILE_SIZE: "25000000",
      IMGPROXY_MAX_ANIMATION_FRAMES: "60",
      IMGPROXY_ENABLE_WEBP_DETECTION: "true",
      IMGPROXY_PRESETS: "default=width:3000/height:8192",
      IMGPROXY_FORMAT_QUALITY: "jpeg=80,avif=62,webp=80",
    });
  });
});

describe("buildImgproxyContainerSpec", () => {
  const input: ImgproxyContainerSpecInput = {
    projectId: "proj",
    networkId: "supabase_network_proj",
    image: "supabase/imgproxy:v3",
  };

  test("derives its own container name and mounts Storage's volumes via VolumesFrom", () => {
    const spec = buildImgproxyContainerSpec(input);
    expect(spec.containerName).toBe("supabase_imgproxy_proj");
    expect(spec.volumesFrom).toEqual(["supabase_storage_proj"]);
    expect(spec.binds).toEqual([]);
  });

  test("has no ports/exposedPorts — reached only via its network alias", () => {
    const spec = buildImgproxyContainerSpec(input);
    expect(spec.ports).toBeUndefined();
    expect(spec.exposedPorts).toBeUndefined();
  });

  test("builds the imgproxy-native healthcheck", () => {
    const spec = buildImgproxyContainerSpec(input);
    expect(spec.healthcheck).toEqual({
      test: ["CMD", "imgproxy", "health"],
      intervalSeconds: 10,
      timeoutSeconds: 2,
      retries: 3,
    });
  });

  test("network alias is 'imgproxy'", () => {
    const spec = buildImgproxyContainerSpec(input);
    expect(spec.networkAliases).toEqual(["imgproxy"]);
    expect(spec.networkId).toBe("supabase_network_proj");
    expect(spec.restartPolicy).toBe("unless-stopped");
    expect(spec.labels).toEqual({});
  });

  test("derives the storage volume-source name from a different projectId", () => {
    const spec = buildImgproxyContainerSpec({ ...input, projectId: "other" });
    expect(spec.containerName).toBe("supabase_imgproxy_other");
    expect(spec.volumesFrom).toEqual(["supabase_storage_other"]);
  });
});
