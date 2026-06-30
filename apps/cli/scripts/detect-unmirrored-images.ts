// Detects which images pinned in apps/cli-go/pkg/config/templates/Dockerfile are
// not yet present on the ghcr.io mirror and emits the list as JSON. Used by the
// mirror-template-images workflow to drive the backfill matrix.
//
// It checks every image and skips the ones already mirrored, so re-running after
// a successful mirror is a no-op. The check itself (`docker buildx imagetools
// inspect`) is the only side effect; the partitioning logic lives in
// src/shared/services/mirror-images.ts and is unit-tested there.
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import process from "node:process";
import { dockerfileServiceImages } from "../src/shared/services/dockerfile-images.ts";
import {
  mirrorImageTarget,
  partitionUnmirroredImages,
} from "../src/shared/services/mirror-images.ts";

function imageExistsOnMirror(target: string): Promise<boolean> {
  const result = spawnSync("docker", ["buildx", "imagetools", "inspect", target], {
    stdio: "ignore",
  });
  return Promise.resolve(result.status === 0);
}

const images = dockerfileServiceImages.map((spec) => spec.image);
const { mirrored, missing } = await partitionUnmirroredImages(images, imageExistsOnMirror);

for (const image of mirrored) {
  console.error(`already mirrored: ${mirrorImageTarget(image)}`);
}
for (const image of missing) {
  console.error(`needs mirror: ${image} -> ${mirrorImageTarget(image)}`);
}

const json = JSON.stringify(missing);
console.log(json);

// Expose the list to the workflow as a step output when running in CI.
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `missing=${json}\n`);
}
