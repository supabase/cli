import { $ } from "bun";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

import { generateChecksums } from "./checksums.ts";

const MUSL_TARGETS = [
  {
    bunTarget: "bun-linux-arm64-musl",
    pkg: "cli-linux-arm64-musl",
    nfpmArch: "arm64",
    ext: "",
  },
  {
    bunTarget: "bun-linux-x64-musl",
    pkg: "cli-linux-x64-musl",
    nfpmArch: "amd64",
    ext: "",
  },
] as const;

const { values } = parseArgs({
  options: {
    version: { type: "string" },
    shell: { type: "string", default: "next" },
    target: { type: "string" },
  },
});

const version = values.version;
if (!version) {
  console.error(
    "Usage: pnpm exec bun apps/cli/scripts/build.ts --version <npm-version> --shell <legacy|next> [--target <pkg-name>]",
  );
  process.exit(1);
}

const shell = values.shell;
if (shell !== "legacy" && shell !== "next") {
  console.error(`Invalid --shell value: ${String(shell)}. Expected "legacy" or "next".`);
  process.exit(1);
}

const TARGETS = [
  {
    bunTarget: "bun-darwin-arm64",
    pkg: "cli-darwin-arm64",
    archive: `supabase_${version}_darwin_arm64.tar.gz`,
    ext: "",
  },
  {
    bunTarget: "bun-darwin-x64",
    pkg: "cli-darwin-x64",
    archive: `supabase_${version}_darwin_amd64.tar.gz`,
    ext: "",
  },
  {
    bunTarget: "bun-linux-arm64",
    pkg: "cli-linux-arm64",
    archive: `supabase_${version}_linux_arm64.tar.gz`,
    nfpmArch: "arm64",
    ext: "",
  },
  {
    bunTarget: "bun-linux-x64",
    pkg: "cli-linux-x64",
    archive: `supabase_${version}_linux_amd64.tar.gz`,
    nfpmArch: "amd64",
    ext: "",
  },
  {
    bunTarget: "bun-windows-x64",
    pkg: "cli-windows-x64",
    archive: `supabase_${version}_windows_amd64.zip`,
    ext: ".exe",
  },
  {
    bunTarget: "bun-windows-arm64",
    pkg: "cli-windows-arm64",
    archive: `supabase_${version}_windows_arm64.zip`,
    ext: ".exe",
  },
] as const;

const root = path.resolve(import.meta.dir, "../../..");
const entrypoint = path.join(root, "apps/cli/src", shell, "main.ts");
const distDir = path.join(root, "dist");
const goSource = path.resolve(root, "apps/cli-go");

const GO_TARGETS: Record<string, { goos: string; goarch: string }> = {
  "bun-darwin-arm64": { goos: "darwin", goarch: "arm64" },
  "bun-darwin-x64": { goos: "darwin", goarch: "amd64" },
  "bun-linux-arm64": { goos: "linux", goarch: "arm64" },
  "bun-linux-x64": { goos: "linux", goarch: "amd64" },
  "bun-linux-arm64-musl": { goos: "linux", goarch: "arm64" },
  "bun-linux-x64-musl": { goos: "linux", goarch: "amd64" },
  "bun-windows-x64": { goos: "windows", goarch: "amd64" },
  "bun-windows-arm64": { goos: "windows", goarch: "arm64" },
};

type CompileTarget = {
  readonly bunTarget: string;
  readonly pkg: string;
  readonly ext: string;
};

type StandardTarget = (typeof TARGETS)[number];

type LinuxGlibcTarget = StandardTarget & { readonly nfpmArch: "arm64" | "amd64" };

function isLinuxGlibcTarget(target: StandardTarget): target is LinuxGlibcTarget {
  return "nfpmArch" in target;
}

async function buildBunBinary(target: CompileTarget) {
  const binDir = path.join(root, "packages", target.pkg, "bin");
  await mkdir(binDir, { recursive: true });

  const outfile = path.join(binDir, `supabase${target.ext}`);

  console.log(`[${target.pkg}] Compiling Bun CLI...`);
  await $`bun build ${entrypoint} --compile --minify --target=${target.bunTarget} --define=process.env.SUPABASE_CLI_VERSION=${JSON.stringify(version)} --outfile=${outfile}`;
  console.log(`[${target.pkg}] Done.`);
}

async function buildGoBinary(target: CompileTarget) {
  const binDir = path.join(root, "packages", target.pkg, "bin");
  await mkdir(binDir, { recursive: true });

  const goSpec = GO_TARGETS[target.bunTarget];
  if (!goSpec) {
    throw new Error(`No Go target mapping for ${target.bunTarget}`);
  }

  const { goos, goarch } = goSpec;
  const outfile = path.join(binDir, `supabase-go${target.ext}`);

  console.log(`[${target.pkg}] Compiling Go CLI (${goos}/${goarch})...`);
  await $`go build -trimpath -ldflags="-s -w" -o ${outfile} .`.cwd(goSource).env({
    ...process.env,
    GOOS: goos,
    GOARCH: goarch,
    CGO_ENABLED: "0",
  });
  console.log(`[${target.pkg}] Go binary done.`);
}

async function archiveStandardTarget(target: StandardTarget) {
  const binDir = path.join(root, "packages", target.pkg, "bin");
  const archivePath = path.join(distDir, target.archive);

  console.log(`[${target.pkg}] Creating archive ${target.archive}...`);

  if (target.archive.endsWith(".zip")) {
    const files = [path.join(binDir, `supabase${target.ext}`)];
    if (shell === "legacy") files.push(path.join(binDir, `supabase-go${target.ext}`));
    await $`zip -j ${archivePath} ${files}`;
  } else {
    const files = [`supabase${target.ext}`];
    if (shell === "legacy") files.push(`supabase-go${target.ext}`);
    await $`tar -czf ${archivePath} -C ${binDir} ${files}`;
  }
}

type LinuxPackageTarget = {
  readonly pkg: string;
  readonly nfpmArch: "arm64" | "amd64";
};

async function buildLinuxPackagesForTarget(target: LinuxPackageTarget, variant: "glibc" | "musl") {
  const binDir = path.join(root, "packages", target.pkg, "bin");
  const formats = variant === "glibc" ? (["deb", "rpm"] as const) : (["apk"] as const);

  await Promise.all(
    formats.map(async (fmt) => {
      const outFile = `supabase_${version}_linux_${target.nfpmArch}.${fmt}`;
      const outPath = path.join(distDir, outFile);

      const contents: Array<{ src: string; dst: string }> = [
        { src: path.join(binDir, "supabase"), dst: "/usr/bin/supabase" },
      ];
      if (shell === "legacy") {
        contents.push({
          src: path.join(binDir, "supabase-go"),
          dst: "/usr/bin/supabase-go",
        });
      }

      const nfpmConfig: Record<string, unknown> = {
        name: "supabase",
        arch: target.nfpmArch,
        platform: "linux",
        version,
        maintainer: "Supabase <support@supabase.io>",
        description: "Supabase CLI",
        homepage: "https://supabase.com",
        license: "MIT",
        contents,
      };

      if (fmt === "apk") {
        nfpmConfig.depends = ["libstdc++", "libgcc"];
      }

      const configPath = path.join(distDir, `nfpm-${target.nfpmArch}-${fmt}.yaml`);
      await writeFile(configPath, JSON.stringify(nfpmConfig));

      console.log(`[${target.pkg}] Creating ${outFile}...`);
      await $`nfpm package --config ${configPath} --packager ${fmt} --target ${outPath}`;
      await rm(configPath);
    }),
  );
}

await mkdir(distDir, { recursive: true });

const requestedTarget = values.target;

if (requestedTarget) {
  const standard = TARGETS.find((t) => t.pkg === requestedTarget);
  const musl = MUSL_TARGETS.find((t) => t.pkg === requestedTarget);

  if (!standard && !musl) {
    const allowed = [...TARGETS, ...MUSL_TARGETS].map((t) => t.pkg).join(", ");
    console.error(`Invalid --target value: ${requestedTarget}. Expected one of: ${allowed}.`);
    process.exit(1);
  }

  const target: CompileTarget = standard ?? musl!;
  console.log(`Building ${shell} CLI for single target ${target.pkg}...\n`);

  await buildBunBinary(target);
  if (shell === "legacy") {
    await buildGoBinary(target);
  }

  if (standard) {
    await archiveStandardTarget(standard);
    if (isLinuxGlibcTarget(standard)) {
      await buildLinuxPackagesForTarget(standard, "glibc");
    }
  } else if (musl) {
    await buildLinuxPackagesForTarget(musl, "musl");
  }

  console.log(`\n[${target.pkg}] Build complete.`);
} else {
  console.log(`Building ${shell} CLI for ${TARGETS.length + MUSL_TARGETS.length} targets...\n`);

  await Promise.all(TARGETS.map(buildBunBinary));

  if (shell === "legacy") {
    console.log("\nCompiling Go CLI for all targets...");
    await Promise.all(TARGETS.map(buildGoBinary));
  }

  await Promise.all(TARGETS.map(archiveStandardTarget));

  await Promise.all(
    MUSL_TARGETS.map(async (t) => {
      await buildBunBinary(t);
      if (shell === "legacy") {
        await buildGoBinary(t);
      }
    }),
  );

  const linuxGlibcTargets = TARGETS.filter(isLinuxGlibcTarget);
  await Promise.all([
    ...linuxGlibcTargets.map((t) => buildLinuxPackagesForTarget(t, "glibc")),
    ...MUSL_TARGETS.map((t) => buildLinuxPackagesForTarget(t, "musl")),
  ]);

  await generateChecksums({ version, distDir });

  console.log(`\nAll ${shell} targets built successfully.`);
}
