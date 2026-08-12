/**
 * ImgProxy container spec builder.
 *
 * Enabled gate: `isStorageEnabled && isImgProxyEnabled` — i.e.
 * `config.storage.enabled && config.storage.image_transformation?.enabled
 * && !isContainerExcluded(imgproxyImage, excluded)`, AND Storage itself must
 * be enabled (ImgProxy mounts Storage's own volumes via `VolumesFrom` below,
 * so it cannot meaningfully run without it). Gating the actual container
 * start is the future `start.handler.ts` orchestrator's responsibility —
 * see `start.services.ts`'s `imgproxy` catalog entry (`enabledGate:
 * "storage.enabled && storage.image_transformation.enabled"`, `dependsOn:
 * ["storage"]`) — this module only builds the container spec once called.
 * The caller must pass the SAME `isImgProxyEnabled` boolean it used for this
 * gating decision into `storage.service.ts`'s `LegacyStorageEnvInput.
 * imageTransformationEnabled` — see that file's header.
 */

import { legacyServiceContainerName } from "../../../shared/legacy-docker-ids.ts";
import type { LegacyStartContainerSpec } from "../../../shared/db-bootstrap/docker-create-args.ts";

/**
 * The ImgProxy env — entirely static, no `config.toml` field feeds any of
 * these values.
 */
export function legacyBuildImgproxyEnv(): Record<string, string> {
  return {
    IMGPROXY_BIND: ":5001",
    IMGPROXY_LOCAL_FILESYSTEM_ROOT: "/",
    // The literal value here really is `"/"`, not a boolean-looking value —
    // this is not a typo.
    IMGPROXY_USE_ETAG: "/",
    IMGPROXY_MAX_SRC_RESOLUTION: "50",
    IMGPROXY_MAX_SRC_FILE_SIZE: "25000000",
    IMGPROXY_MAX_ANIMATION_FRAMES: "60",
    IMGPROXY_ENABLE_WEBP_DETECTION: "true",
    IMGPROXY_PRESETS: "default=width:3000/height:8192",
    IMGPROXY_FORMAT_QUALITY: "jpeg=80,avif=62,webp=80",
  };
}

export interface LegacyImgproxyContainerSpecInput {
  /** The sanitized project id — see `legacyServiceContainerName`'s callers. */
  readonly projectId: string;
  /** `container.HostConfig.NetworkMode`/`network.NetworkingConfig` target — the `--network-id` override or `utils.NetId`. */
  readonly networkId: string;
  /** `utils.Config.Storage.ImgProxyImage`, already resolved/pulled by the caller (`image-prepull.ts`). */
  readonly image: string;
}

/**
 * Builds the `docker create` spec for the ImgProxy container. `volumesFrom`
 * mounts Storage's own volumes — no `ports`/`exposedPorts`; ImgProxy is
 * reached only via its Docker network alias, from Storage's own
 * `IMGPROXY_URL` env var (`storage.service.ts`'s `legacyBuildStorageEnv`).
 */
export function legacyBuildImgproxyContainerSpec(
  input: LegacyImgproxyContainerSpecInput,
): LegacyStartContainerSpec {
  return {
    image: input.image,
    containerName: legacyServiceContainerName("imgproxy", input.projectId),
    env: legacyBuildImgproxyEnv(),
    binds: [],
    volumesFrom: [legacyServiceContainerName("storage", input.projectId)],
    healthcheck: {
      test: ["CMD", "imgproxy", "health"],
      intervalSeconds: 10,
      timeoutSeconds: 2,
      retries: 3,
    },
    restartPolicy: "unless-stopped",
    networkId: input.networkId,
    // The ImgProxy network alias.
    networkAliases: ["imgproxy"],
    labels: {},
  };
}
