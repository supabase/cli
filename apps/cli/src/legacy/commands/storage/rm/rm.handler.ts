import { Effect } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";

interface LegacyStorageRmFlags {
  readonly files: ReadonlyArray<string>;
  readonly recursive: boolean;
  readonly local: boolean;
  readonly linked: boolean;
}

export const legacyStorageRm = Effect.fn("legacy.storage.rm")(function* (
  flags: LegacyStorageRmFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["storage", "rm"];
  if (flags.recursive) args.push("--recursive");
  if (flags.local) args.push("--local");
  if (flags.linked) args.push("--linked");
  args.push(...flags.files);
  yield* proxy.exec(args);
});
