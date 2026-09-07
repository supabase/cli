"""Read the target catalog and verify public release metadata without warming caches."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

WORKLOADS = ('database:database', 'rest:rest', 'auth:auth', 'realtime:realtime',
             'storage:storage', 'functions:edge-runtime', 'studio:studio',
             'studio:pgmeta', 'mail:mail', 'analytics:analytics', 'pooler:pooler')


TRANSIENT_HTTP = {429, 500, 502, 503, 504}


def fetch(url, headers=None):
    for attempt in range(3):
        request_url = url
        if attempt:
            request_url += '&' if '?' in request_url else '?'
            request_url += f'_sbr_retry={attempt}'
        request = urllib.request.Request(
            request_url,
            headers={'User-Agent': 'supabase-stack-benchmark', 'Cache-Control': 'no-cache', **(headers or {})},
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return response.read()
        except urllib.error.HTTPError as error:
            if error.code not in TRANSIENT_HTTP or attempt == 2:
                raise RuntimeError(f'fetch failed {url}: HTTP {error.code}') from error
            time.sleep(1 << attempt)
        except (urllib.error.URLError, TimeoutError) as error:
            if attempt == 2:
                reason = getattr(error, 'reason', error)
                raise RuntimeError(f'fetch failed {url}: {reason}') from error
            time.sleep(1 << attempt)
    raise RuntimeError(f'fetch failed {url}: exhausted retries')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def catalog_provenance(source: Path):
    catalog = source / 'packages/stack/src/model/WorkloadCatalog.ts'
    script = r'''
const catalogPath = process.argv[1];
const { createRequire } = await import("node:module");
const require = createRequire(catalogPath);
const { Effect } = await import(require.resolve("effect"));
const { WORKLOAD_CATALOG, resolveNativeArtifactForWorkload } = await import(catalogPath);
const resolved = {};
for (const [id, entry] of Object.entries(WORKLOAD_CATALOG)) {
  const workload = { id, artifacts: { native: { release: entry.defaultVersion } } };
  resolved[id] = {};
  for (const [os, target] of [["darwin", "darwin-arm64"], ["linux", "linux-arm64"]]) {
    resolved[id][target] = await Effect.runPromise(
      resolveNativeArtifactForWorkload(workload, { os, arch: "arm64" }),
    );
  }
}
console.log(JSON.stringify({ entries: WORKLOAD_CATALOG, resolved }));
'''
    probe = json.loads(subprocess.check_output(['bun', '-e', script, str(catalog)], cwd=source))
    entries, resolved = probe['entries'], probe['resolved']
    def inspect(workload):
        entry = entries[workload]
        service, version = entry['service'], entry['defaultVersion']
        image = entry['releases'][version]
        tag = f'{service}-{version}'
        base = f'https://github.com/supabase/slim-services/releases/download/{tag}'
        sums = dict((line.split()[1].lstrip('*'), line.split()[0])
                    for line in fetch(f'{base}/SHA256SUMS').decode().splitlines() if line.strip())
        release = json.loads(subprocess.check_output([
            'gh', 'api', f'repos/supabase/slim-services/releases/tags/{tag}']))
        assets = {asset['name']: asset for asset in release['assets']}
        archives = []
        for target in ('darwin-arm64', 'linux-arm64'):
            name = f'{tag}-{target}.tar.zst'
            artifact = resolved[workload][target]
            expected = {
                'downloadUrl': f'{base}/{name}',
                'manifestUrl': f'{base}/{tag}-{target}.manifest.json',
                'checksumUrl': f'{base}/SHA256SUMS',
            }
            for field, url in expected.items():
                if artifact.get(field) != url:
                    raise RuntimeError(
                        f'Native resolver {field} differs from public release URL: '
                        f'{workload} {target}'
                    )
            sha = sums[name]
            asset = assets[name]
            if asset.get('digest') != f'sha256:{sha}':
                raise RuntimeError(f'GitHub asset digest differs from SHA256SUMS: {name}')
            raw_manifest = fetch(f'{base}/{tag}-{target}.manifest.json')
            manifest = json.loads(raw_manifest)
            if (manifest['service'], manifest['version'], manifest['target']) != (service, version, target):
                raise RuntimeError(f'Artifact manifest identity mismatch: {name}')
            archives.append({'target': target, 'name': name, 'sha256': sha,
                             'bytes': asset['size'], 'updatedAt': asset['updated_at'],
                             'manifestSha256': digest(raw_manifest), 'manifest': manifest})
        if not image.startswith('ghcr.io/'):
            raise RuntimeError(f'Unsupported public container registry: {image}')
        repository, ref = image.removeprefix('ghcr.io/').rsplit(':', 1)
        if '@sha256' in repository:
            repository = repository.split(':', 1)[0]
            ref = 'sha256:' + ref
        token_url = 'https://ghcr.io/token?' + urllib.parse.urlencode({'scope': f'repository:{repository}:pull', 'service': 'ghcr.io'})
        token = json.loads(fetch(token_url))['token']
        index = fetch(f'https://ghcr.io/v2/{repository}/manifests/{ref}', {
            'Authorization': f'Bearer {token}',
            'Accept': 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json'})
        image_digest = 'sha256:' + digest(index)
        if ref.startswith('sha256:') and image_digest != ref:
            raise RuntimeError(f'Container manifest digest mismatch: {image}')
        return {'id': workload, 'service': service, 'version': version, 'image': image,
                'imageDigest': image_digest, 'imageManifest': json.loads(index),
                'releaseUrl': release['html_url'], 'archives': archives}
    with ThreadPoolExecutor(max_workers=4) as pool:
        artifacts = list(pool.map(inspect, WORKLOADS))
    return {'catalogSha256': digest(catalog.read_bytes()), 'artifacts': artifacts}


if __name__ == '__main__':
    import sys
    print(json.dumps(catalog_provenance(Path(sys.argv[1]).resolve()), indent=2))
