import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacySsoAddFlags } from "./add.command.ts";

export const legacySsoAdd = Effect.fn("legacy.sso.add")(function* (flags: LegacySsoAddFlags) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["sso", "add"];
  if (Option.isSome(flags.projectRef)) args.push("--project-ref", flags.projectRef.value);
  if (Option.isSome(flags.type)) args.push("--type", flags.type.value);
  for (const domain of flags.domains) args.push("--domains", domain);
  if (Option.isSome(flags.metadataFile)) args.push("--metadata-file", flags.metadataFile.value);
  if (Option.isSome(flags.metadataUrl)) args.push("--metadata-url", flags.metadataUrl.value);
  if (flags.skipUrlValidation) args.push("--skip-url-validation");
  if (Option.isSome(flags.attributeMappingFile))
    args.push("--attribute-mapping-file", flags.attributeMappingFile.value);
  if (Option.isSome(flags.nameIdFormat)) args.push("--name-id-format", flags.nameIdFormat.value);
  yield* proxy.exec(args);
});
