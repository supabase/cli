/**
 * ImgProxy container spec builder.
 *
 * Enabled when `storage.enabled && storage.image_transformation.enabled &&
 * !isContainerExcluded(...)` — ImgProxy mounts Storage's own volumes via
 * `VolumesFrom`, so it can't run without Storage. Gating the actual start is
 * the `start` orchestrator's job; this module only builds the spec. The
 * caller must pass the same enabled value into `storage.service.ts`'s
 * `StorageEnvInput.imageTransformationEnabled`.
 */

import { serviceContainerName } from "../../../command-internal/docker-ids.ts";
import type { StartContainerSpec } from "../../../command-internal/db-bootstrap/docker-create-args.ts";

/**
 * The ImgProxy env — entirely static, no `config.toml` field feeds any of
 * these values.
 */
export function buildImgproxyEnv(): Record<string, string> {
  return {
    IMGPROXY_BIND: ":5001",
    IMGPROXY_LOCAL_FILESYSTEM_ROOT: "/",
    // `"/"` is the correct value here, not a boolean-looking typo.
    IMGPROXY_USE_ETAG: "/",
    IMGPROXY_MAX_SRC_RESOLUTION: "50",
    IMGPROXY_MAX_SRC_FILE_SIZE: "25000000",
    IMGPROXY_MAX_ANIMATION_FRAMES: "60",
    IMGPROXY_ENABLE_WEBP_DETECTION: "true",
    IMGPROXY_PRESETS: "default=width:3000/height:8192",
    IMGPROXY_FORMAT_QUALITY: "jpeg=80,avif=62,webp=80",
  };
}

export interface ImgproxyContainerSpecInput {
  /** The sanitized project id — see `serviceContainerName`'s callers. */
  readonly projectId: string;
  /** Docker network to attach to — the `--network-id` override or the project's default network. */
  readonly networkId: string;
  /** Already resolved/pulled by the caller (`image-prepull.ts`). */
  readonly image: string;
}

/**
 * Builds the `docker create` spec for the ImgProxy container. `volumesFrom`
 * mounts Storage's own volumes — no `ports`/`exposedPorts`; ImgProxy is
 * reached only via its Docker network alias, from Storage's own
 * `IMGPROXY_URL` env var (`storage.service.ts`'s `buildStorageEnv`).
 */
export function buildImgproxyContainerSpec(input: ImgproxyContainerSpecInput): StartContainerSpec {
  return {
    image: input.image,
    containerName: serviceContainerName("imgproxy", input.projectId),
    env: buildImgproxyEnv(),
    binds: [],
    volumesFrom: [serviceContainerName("storage", input.projectId)],
    healthcheck: {
      test: ["CMD", "imgproxy", "health"],
      intervalSeconds: 10,
      timeoutSeconds: 2,
      retries: 3,
    },
    restartPolicy: "unless-stopped",
    networkId: input.networkId,
    networkAliases: ["imgproxy"],
    labels: {},
  };
}
