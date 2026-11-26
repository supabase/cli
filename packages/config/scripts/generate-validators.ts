import { compileCliConfigValidators } from "./compile-validators.ts";

const target = new URL("../src/generated/cli-config-validators.js", import.meta.url);

if (import.meta.main) {
  await Bun.write(target, compileCliConfigValidators());
}
