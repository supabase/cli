#!/usr/bin/env node

/**
 * Wrapper script that delegates to the platform-specific binary.
 * The actual binary is provided by one of the optional dependencies:
 * - supabase-darwin-amd64
 * - supabase-darwin-arm64
 * - supabase-linux-amd64
 * - supabase-linux-arm64
 * - supabase-windows-amd64
 * - supabase-windows-arm64
 */

import { spawnSync } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Mapping from Node's process.arch to package names
const ARCH_MAPPING = {
	x64: "amd64",
	arm64: "arm64",
};

// Mapping from Node's process.platform to package names
const PLATFORM_MAPPING = {
	darwin: "darwin",
	linux: "linux",
	win32: "windows",
};

const arch = ARCH_MAPPING[process.arch];
const platform = PLATFORM_MAPPING[process.platform];

if (!arch || !platform) {
	console.error(`Unsupported platform: ${process.platform} ${process.arch}`);
	process.exit(1);
}

// Construct the package name
const packageName = `supabase-${platform}-${arch}`;

// Construct the path to the binary
// The binary is in node_modules/{packageName}/bin/supabase[.exe]
const binaryName = platform === "windows" ? "supabase.exe" : "supabase";
const binaryPath = join(
	__dirname,
	"..",
	"node_modules",
	packageName,
	"bin",
	binaryName,
);

// Run the binary with all arguments
const result = spawnSync(binaryPath, process.argv.slice(2), {
	stdio: "inherit",
});

// Exit with the same code as the binary
process.exit(result.status ?? 1);
