/**
 * Builds the CLI for the current platform and publishes it to the local
 * Verdaccio registry. Never modifies any git-tracked files — all version
 * mutations happen inside a system temp directory that is deleted on exit.
 *
 * Usage:
 *   pnpm cli-release --next [--version 0.0.0-local.1234567890]
 *   pnpm cli-release --legacy [--version 0.0.0-local.1234567890]
 *
 * Requires `pnpm local-registry` to be running in another terminal.
 * Requires Go in PATH when using --legacy.
 */

import { $ } from "bun";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

const PORT = 4873;
const REGISTRY = `http://localhost:${PORT}`;
const root = path.resolve(import.meta.dir, "../..");
const tokenPath = path.join(root, "tmp", "verdaccio-token");

// All seven platform packages that appear in optionalDependencies.
const PLATFORM_PACKAGES = [
	"cli-darwin-arm64",
	"cli-darwin-x64",
	"cli-linux-arm64",
	"cli-linux-arm64-musl",
	"cli-linux-x64",
	"cli-linux-x64-musl",
	"cli-windows-x64",
] as const;

type PlatformInfo = {
	bunTarget: string;
	platformPkg: string;
	ext: string;
	goos: string;
	goarch: string;
};

const PLATFORM_MAP: Record<string, PlatformInfo> = {
	"darwin-arm64": {
		bunTarget: "bun-darwin-arm64",
		platformPkg: "cli-darwin-arm64",
		ext: "",
		goos: "darwin",
		goarch: "arm64",
	},
	"darwin-x64": {
		bunTarget: "bun-darwin-x64",
		platformPkg: "cli-darwin-x64",
		ext: "",
		goos: "darwin",
		goarch: "amd64",
	},
	"linux-arm64": {
		bunTarget: "bun-linux-arm64",
		platformPkg: "cli-linux-arm64",
		ext: "",
		goos: "linux",
		goarch: "arm64",
	},
	"linux-x64": {
		bunTarget: "bun-linux-x64",
		platformPkg: "cli-linux-x64",
		ext: "",
		goos: "linux",
		goarch: "amd64",
	},
	"win32-x64": {
		bunTarget: "bun-windows-x64",
		platformPkg: "cli-windows-x64",
		ext: ".exe",
		goos: "windows",
		goarch: "amd64",
	},
};

function getPlatformInfo(): PlatformInfo {
	const key = `${process.platform}-${process.arch}`;
	const info = PLATFORM_MAP[key];
	if (!info) {
		console.error(`\nError: Unsupported platform: ${key}`);
		console.error(
			"Supported: darwin-arm64, darwin-x64, linux-arm64, linux-x64, win32-x64\n",
		);
		process.exit(1);
	}
	return info;
}

async function checkRegistry(): Promise<void> {
	try {
		const res = await fetch(`${REGISTRY}/-/ping`, {
			signal: AbortSignal.timeout(3000),
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
	} catch {
		console.error(`\nError: Local registry not responding at ${REGISTRY}`);
		console.error("Start it first with: pnpm local-registry\n");
		process.exit(1);
	}
}

async function readToken(): Promise<string> {
	try {
		return (await Bun.file(tokenPath).text()).trim();
	} catch {
		console.error(`\nError: Auth token not found at ${tokenPath}`);
		console.error(
			"The local registry must be running before you release: pnpm local-registry\n",
		);
		process.exit(1);
	}
}

async function checkGo(): Promise<void> {
	try {
		await $`go version`.quiet();
	} catch {
		console.error("\nError: `go` not found in PATH.");
		console.error("Install Go from https://go.dev/dl/ to build the legacy shell.\n");
		process.exit(1);
	}
}

async function checkGoSource(): Promise<string> {
	const goSource = path.join(root, ".repos", "supabase-cli-go");
	const goMod = Bun.file(path.join(goSource, "go.mod"));
	if (!(await goMod.exists())) {
		console.error("\nError: Go CLI source not found at .repos/supabase-cli-go");
		console.error("Run: pnpm repos:install\n");
		process.exit(1);
	}
	return goSource;
}

async function main() {
	const { values } = parseArgs({
		options: {
			legacy: { type: "boolean", default: false },
			next: { type: "boolean", default: false },
			version: { type: "string" },
		},
	});

	if (!values.legacy && !values.next) {
		console.error("Usage: pnpm cli-release --next | --legacy [--version <v>]");
		process.exit(1);
	}
	if (values.legacy && values.next) {
		console.error("Error: Specify either --next or --legacy, not both.");
		process.exit(1);
	}

	const shell = values.legacy ? "legacy" : "next";
	const version = values.version ?? `0.0.0-local.${Math.floor(Date.now() / 1000)}`;

	await checkRegistry();
	const token = await readToken();
	const platform = getPlatformInfo();

	let goSource: string | undefined;
	if (shell === "legacy") {
		await checkGo();
		goSource = await checkGoSource();

		if (process.platform === "linux") {
			console.warn(
				"Note: local-release builds the glibc variant only (cli-linux-*). " +
					"The musl variant is skipped for local dev.\n",
			);
		}
	}

	// All build output goes into a system temp directory — never into the git repo.
	const tmpDir = await mkdtemp(path.join(tmpdir(), "supabase-local-release-"));

	try {
		console.log(
			`\nBuilding @supabase/cli@${version} (${shell}, ${platform.platformPkg})...\n`,
		);

		// ── Build platform package ────────────────────────────────────────────

		const tmpPlatformDir = path.join(tmpDir, platform.platformPkg);
		const tmpPlatformBinDir = path.join(tmpPlatformDir, "bin");
		await mkdir(tmpPlatformBinDir, { recursive: true });

		const entrypoint = path.join(root, "apps", "cli", "src", shell, "main.ts");
		const bunBinary = path.join(tmpPlatformBinDir, `supabase${platform.ext}`);

		console.log(`[1/${shell === "legacy" ? 3 : 2}] Compiling ${shell} CLI binary...`);
		await $`bun build ${entrypoint} --compile --target=${platform.bunTarget} --outfile=${bunBinary}`;

		if (shell === "legacy" && goSource) {
			const goBinary = path.join(tmpPlatformBinDir, `supabase-go${platform.ext}`);
			console.log(
				`[2/3] Compiling Go CLI binary (${platform.goos}/${platform.goarch})...`,
			);
			// Run go build from within the Go source directory so Go can find
			// the go.mod there. Passing an absolute path as a positional arg
			// causes Go to resolve the module from CWD instead, which fails
			// because the repo root has no go.mod.
			await $`go build -trimpath -ldflags="-s -w" -o ${goBinary} .`
				.cwd(goSource)
				.env({
					...process.env,
					GOOS: platform.goos,
					GOARCH: platform.goarch,
					CGO_ENABLED: "0",
				});
		}

		// ── Build umbrella package shim ───────────────────────────────────────

		const tmpCliDir = path.join(tmpDir, "cli");
		const tmpCliDistDir = path.join(tmpCliDir, "dist");
		await mkdir(tmpCliDistDir, { recursive: true });

		const shimSrc = path.join(root, "apps", "cli", "src", "shared", "cli", "bin.ts");
		const shimOut = path.join(tmpCliDistDir, "supabase.js");
		const shimStep = shell === "legacy" ? 3 : 2;
		console.log(`[${shimStep}/${shimStep}] Building Node.js shim...`);
		await $`bun build ${shimSrc} --outfile=${shimOut} --target=node`;

		// ── Write package.json files ──────────────────────────────────────────

		// Platform package: copy as-is, bump version.
		const platformPkgJson = await Bun.file(
			path.join(root, "packages", platform.platformPkg, "package.json"),
		).json();
		platformPkgJson.version = version;
		await Bun.write(
			path.join(tmpPlatformDir, "package.json"),
			`${JSON.stringify(platformPkgJson, null, "\t")}\n`,
		);

		// Umbrella package: build a minimal package.json.
		// The shim only uses Node built-ins — all @supabase/* and catalog: deps
		// are bundled in the platform binary and must not appear in the published
		// package.json (catalog: and workspace:* are invalid outside pnpm workspaces).
		const cliPkgJson = await Bun.file(
			path.join(root, "apps", "cli", "package.json"),
		).json();

		const resolvedOptionalDeps: Record<string, string> = {};
		for (const pkg of PLATFORM_PACKAGES) {
			resolvedOptionalDeps[`@supabase/${pkg}`] = version;
		}

		const publishPkgJson = {
			name: cliPkgJson.name,
			version,
			type: cliPkgJson.type,
			bin: cliPkgJson.bin,
			files: cliPkgJson.files,
			publishConfig: cliPkgJson.publishConfig,
			optionalDependencies: resolvedOptionalDeps,
		};
		await Bun.write(
			path.join(tmpCliDir, "package.json"),
			`${JSON.stringify(publishPkgJson, null, "\t")}\n`,
		);

		// ── Write .npmrc with registry and auth token ─────────────────────────

		const npmrc = [
			`registry=${REGISTRY}`,
			`//localhost:${PORT}/:_authToken=${token}`,
			"",
		].join("\n");
		await Bun.write(path.join(tmpPlatformDir, ".npmrc"), npmrc);
		await Bun.write(path.join(tmpCliDir, ".npmrc"), npmrc);

		// ── Publish ───────────────────────────────────────────────────────────

		console.log(
			`\nPublishing @supabase/${platform.platformPkg}@${version} to local registry...`,
		);
		// Use bun publish for the platform binary package: pnpm normalises file
		// modes in tarballs and strips the execute bit from files not in the
		// package's `bin` field. bun publish preserves modes, matching production.
		await $`bun publish --access public --tag local --registry ${REGISTRY} --no-git-checks`.cwd(
			tmpPlatformDir,
		);

		console.log(`Publishing @supabase/cli@${version} to local registry...`);
		await $`pnpm publish --access public --tag local --registry ${REGISTRY} --no-git-checks`.cwd(
			tmpCliDir,
		);

		console.log(`
✓ Published @supabase/cli@${version}

Test with npx:
  npx --registry ${REGISTRY} @supabase/cli@${version} --version

Or install globally:
  npm install -g --registry ${REGISTRY} @supabase/cli@${version}
  supabase --version
`);
	} finally {
		// Always remove the temp directory — even on failure.
		await rm(tmpDir, { recursive: true, force: true });
	}
}

await main();
