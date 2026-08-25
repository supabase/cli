import { dockerImageForService } from "@supabase/stack/versions";
import { dockerfileServiceImage } from "../../../shared/services/dockerfile-images.ts";
import { slimImagesEnabled } from "../../../shared/services/slim-images.ts";
import {
  replaceImageTag,
  type LocalServiceVersionName,
  type LocalServiceVersionOverrides,
} from "../../../shared/services/services.shared.ts";

/**
 * The embedded Dockerfile default image for `alias`, with its tag replaced by
 * `serviceVersions`' pin for `localServiceName` when one is present — Go's
 * `Config.Load` rewriting `c.Auth.Image`/etc. from `supabase/.temp/*-version`
 * (`pkg/config/config.go:827-863`) before `start`/`db start` ever read them.
 * Reused by `start.gates.ts`'s own `legacyResolveStartImagePlan` AND by both
 * `supabase start` and `db start`'s fresh-DB one-shot setup jobs
 * (`realtime`/`storage`/`auth`), which Go runs regardless of `--exclude` and
 * therefore can't go through `legacyResolveStartImagePlan`'s gate-filtered
 * plan — hoisted here (was defined directly in `start.gates.ts`) once `db
 * start`'s own native container bootstrap became a second caller across the
 * `start`/`db` family boundary, see `apps/cli/CLAUDE.md`'s "Hoist Before You
 * Duplicate" rule.
 */
export function legacyResolvePinnedImage(
  alias: string,
  localServiceName: LocalServiceVersionName,
  serviceVersions: LocalServiceVersionOverrides,
): string {
  const baseImage = dockerfileServiceImage(alias);
  const pinnedVersion = serviceVersions[localServiceName];
  if (pinnedVersion === undefined) {
    return baseImage;
  }
  // A verbatim tag swap would be wrong on slim refs whose tag scheme differs
  // from docker.io's (`pooler`/`analytics` pins are unprefixed on docker.io but
  // `v`-prefixed under `ghcr.io/supabase/cli`), so let the catalog normalize.
  return slimImagesEnabled()
    ? dockerImageForService(localServiceName, pinnedVersion)
    : replaceImageTag(baseImage, pinnedVersion);
}
