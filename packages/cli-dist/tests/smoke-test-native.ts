import { $ } from "bun";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../../..");

const NATIVE_MAP: Record<string, Record<string, { pkg: string; bin: string }>> = {
  darwin: {
    arm64: { pkg: "cli-darwin-arm64", bin: "supabase" },
    x64: { pkg: "cli-darwin-x64", bin: "supabase" },
  },
  linux: {
    arm64: { pkg: "cli-linux-arm64", bin: "supabase" },
    x64: { pkg: "cli-linux-x64", bin: "supabase" },
  },
  win32: {
    x64: { pkg: "cli-windows-x64", bin: "supabase.exe" },
  },
};

const platform = process.platform;
const arch = process.arch;
const target = NATIVE_MAP[platform]?.[arch];

if (!target) {
  console.error(`No binary available for ${platform}/${arch}`);
  process.exit(1);
}

const name = `${platform === "win32" ? "windows" : platform}-${arch}`;
const binPath = path.join(root, "packages", target.pkg, "bin", target.bin);

console.log(`[${name}] Running ${binPath} --version...`);

const output = await $`${binPath} --version`.text();
const trimmed = output.trim();
const passed = /^\d+\.\d+\.\d+/.test(trimmed);

console.log(`[${name}] ${passed ? "PASS" : "FAIL"} — ${trimmed}`);

if (!passed) {
  process.exit(1);
}
