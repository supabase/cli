#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "Usage: $0 <OUTPUT_DIR> <rootfs.tar> <core-file>" >&2
  exit 2
fi

output_dir=$(cd "$1" && pwd)
rootfs_tar=$(cd "$(dirname "$2")" && pwd)/$(basename "$2")
core_file=$(cd "$(dirname "$3")" && pwd)/$(basename "$3")
rootfs="$output_dir/rootfs"
trap 'rm -rf -- "$rootfs"' EXIT
mkdir -p "$rootfs"
tar -xf "$rootfs_tar" -C "$rootfs"

runtime=$(find "$rootfs" -type f \( -name edge-runtime -o -name supabase-edge-runtime \) -print -quit)
if [[ -z "$runtime" ]]; then
  echo "No Edge Runtime executable found in exported container rootfs." >&2
  exit 1
fi

{
  echo "=== Runtime executable ==="
  file "$runtime"
  python3 - "$runtime" <<'PY'
import hashlib
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
digest = hashlib.sha256(path.read_bytes()).hexdigest()
print(f"sha256={digest} size={path.stat().st_size} bytes path={path}")
PY
  echo "=== Deno cache database files ==="
  python3 - "$rootfs/root/.cache/deno" <<'PY'
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
if root.exists():
    for path in sorted(root.rglob("*")):
        if path.is_file() and ("_cache_v2" in path.name or path.name.endswith(("-wal", "-shm"))):
            print(f"size={path.stat().st_size} bytes path={path}")
PY
} | tee "$output_dir/runtime-files.txt"

if ! command -v gdb >/dev/null 2>&1; then
  echo "gdb is required; rootfs extracted to $rootfs and executable is $runtime" >&2
  exit 127
fi

gdb -nx -batch \
  -iex "set sysroot $rootfs" \
  -ex "set solib-search-path $rootfs/lib:$rootfs/lib64:$rootfs/usr/lib:$rootfs/usr/local/lib" \
  -ex "info files" \
  -ex "info sharedlibrary" \
  -ex "p \$_siginfo" \
  -ex "info registers" \
  -ex "x/8i \$pc" \
  -ex "info threads" \
  -ex "info proc mappings" \
  -ex "thread apply all bt full" \
  "$runtime" "$core_file" | tee "$output_dir/gdb-core-report.txt"
