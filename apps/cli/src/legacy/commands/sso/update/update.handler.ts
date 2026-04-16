import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacySsoUpdateFlags } from "./update.command.ts";

export const legacySsoUpdate = Effect.fn("legacy.sso.update")(function* (
  flags: LegacySsoUpdateFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["sso", "update"];
  if (Option.isSome(flags.projectRef)) args.push("--project-ref", flags.projectRef.value);
  for (const domain of flags.domains) args.push("--domains", domain);
  for (const domain of flags.addDomains) args.push("--add-domains", domain);
  for (const domain of flags.removeDomains) args.push("--remove-domains", domain);
  if (Option.isSome(flags.metadataFile)) args.push("--metadata-file", flags.metadataFile.value);
  if (Option.isSome(flags.metadataUrl)) args.push("--metadata-url", flags.metadataUrl.value);
  if (flags.skipUrlValidation) args.push("--skip-url-validation");
  if (Option.isSome(flags.attributeMappingFile))
    args.push("--attribute-mapping-file", flags.attributeMappingFile.value);
  if (Option.isSome(flags.nameIdFormat)) args.push("--name-id-format", flags.nameIdFormat.value);
  args.push(flags.providerId);
  yield* proxy.exec(args);
});
