"""Verify the already-built RC3 package against its fixed source and manifest.

Offline verification only; no Git transport, tag mutation or publication.
"""
from pathlib import Path, PurePosixPath
import hashlib
import json
import subprocess
import sys
import tarfile

ROOT = Path(__file__).resolve().parents[2]
META = Path(__file__).resolve().parent


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def git(*args):
    return subprocess.check_output(['git', '-C', str(ROOT), *args])


m = json.loads((META / 'manifest.json').read_text())
archive = Path(sys.argv[1])
require(m['repository'] == 'Tests4gptplay/deepseek-servant', 'Wrong repository identity.')
require(m['packageName'] == 'deepseek-servant' and m['packageVersion'] == '0.5.0-rc.3', 'Wrong package identity.')
require(m['releaseTag'] == 'v0.5.0-rc.3' and m['prerelease'] is True, 'Wrong prerelease identity.')
require(archive.name == m['canonicalAsset'] == 'deepseek-servant-0.5.0-rc.3.tgz', 'Wrong asset filename.')
require(m['plannedAssetURL'] == 'https://github.com/' + m['repository'] + '/releases/download/' + m['releaseTag'] + '/' + archive.name,
        'Download URL does not match the package.')
require(m['plannedTagInstallSpec'] == 'github:' + m['repository'] + '#' + m['releaseTag'], 'Wrong tag installation source.')
require(git('rev-parse', m['sourceCommit'] + '^{tree}').decode().strip() == m['sourceTree'], 'Source tree mismatch.')
require(git('rev-parse', m['sourceCommit'] + ':src').decode().strip() == m['productionSourceTree'], 'Production source tree mismatch.')
require(git('rev-parse', m['productionBaseCommit'] + ':src').decode().strip() == m['productionSourceTree'], 'Production code differs from fixed base.')
require(subprocess.run(['git', '-C', str(ROOT), 'merge-base', '--is-ancestor', m['sourceCommit'], 'HEAD']).returncode == 0,
        'Candidate does not descend from its fixed source commit.')
changed = git('diff', '--name-only', '-z', m['sourceCommit'], 'HEAD').decode().rstrip('\0').split('\0')
require(all(not p or p.startswith('scripts/release-v0.5.0-rc.3/') or p == '.github/workflows/release-v0.5.0-rc.3.yml' for p in changed),
        'Non-release files changed after the package was verified.')
require(not git('status', '--porcelain', '--untracked-files=no').strip(), 'Tracked files are dirty.')

expected = m['payloadSHA256']
require(len(expected) == m['payloadFiles'] == 39, 'Wrong fixed payload manifest.')
require(m['fileMode'] == '0644', 'Wrong fixed payload mode.')
data = archive.read_bytes()
digest = hashlib.sha256(data).hexdigest()
require(len(data) == m['bytes'] and digest == m['sha256'], 'Archive differs from the verified RC3 package.')
with tarfile.open(archive) as tar:
    members = tar.getmembers()
    require(all(f.isfile() and f.name.startswith('package/') and f.mode == 0o644 for f in members), 'Unexpected archive entry.')
    names = [f.name.removeprefix('package/') for f in members]
    require(all(not PurePosixPath(n).is_absolute() and '..' not in PurePosixPath(n).parts for n in names), 'Unsafe package path.')
    require(len(names) == len(set(names)) == len(expected) and set(names) == set(expected), 'Production allowlist mismatch.')
    payload = {name: tar.extractfile(f).read() for name, f in zip(names, members)}
require({name: hashlib.sha256(value).hexdigest() for name, value in payload.items()} == expected, 'Payload hash mismatch.')
for name, value in payload.items():
    require(value == git('show', m['sourceCommit'] + ':' + name), 'Package differs from fixed source: ' + name)
    require(value == git('show', 'HEAD:' + name), 'Package differs from install tree: ' + name)
pkg = json.loads(payload['package.json'])
require(pkg['name'] == m['packageName'] and pkg['version'] == m['packageVersion'], 'Packed package identity mismatch.')
require(set(pkg['files']) | {'package.json'} == set(expected), 'package.files differs from the reviewed allowlist.')
require('dsh' not in pkg.get('engines', {}), 'Unexpected Host version gate.')
require(all(value == '*' for name, value in pkg['peerDependencies'].items() if name.startswith('@deepseek-ai/')), 'Unexpected Host peer-version gate.')
for row in payload['python/SHA256SUMS'].decode().splitlines():
    expected_hash, name = row.split('  ', 1)
    require(name in payload and hashlib.sha256(payload[name]).hexdigest() == expected_hash, 'Git runtime checksum mismatch: ' + name)
print(json.dumps({'sourceCommit': m['sourceCommit'], 'candidateCommit': git('rev-parse', 'HEAD').decode().strip(),
                  'archive': archive.name, 'bytes': len(data), 'sha256': digest, 'payloadFiles': len(payload),
                  'scope': 'fixed compiled package consistency; no rebuild, installation or functional regression'}, indent=2))
