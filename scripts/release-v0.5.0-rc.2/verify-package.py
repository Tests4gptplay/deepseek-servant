"""Compare the RC2 package with its fixed source tree and archive manifest."""
from pathlib import Path
import hashlib
import json
import re
import subprocess
import sys
import tarfile

ROOT = Path(__file__).resolve().parents[2]
META = Path(__file__).resolve().parent
ALLOWED = {
    'package.json', 'lib/host.js', 'lib/client.js', 'icon.png',
    'assets/page-icon.png', 'assets/welcome-character.png',
    'assets/task-empty-character.png', 'assets/statusbar-icon.png',
    'assets/statusbar-icon-black.png', 'cordis.patch.yml', 'LICENSE', 'NOTICE',
    'README.md', 'SPONSOR.md', 'PRIVATE_GIT.md', 'IMPLEMENTATION.md', 'RETENTION.md',
    'docs/INSTALLATION.md', 'docs/USAGE.md', 'docs/TESTING.md',
    'THIRD_PARTY_NOTICES.md', 'CHANGELOG.md', 'docs/releases/0.5.0.md',
}

def require(condition, message):
    if not condition:
        raise SystemExit(message)

def git(*args):
    return subprocess.check_output(['git', '-C', str(ROOT), *args])

m = json.loads((META / 'manifest.json').read_text())
archive = Path(sys.argv[1])
require(archive.name == m['archive'] == 'deepseek-servant-0.5.0-rc.2.tgz', 'Wrong asset filename.')
require(m['version'] == '0.5.0' and m['tag'] == 'v0.5.0-rc.2', 'Wrong release identity.')
require(re.fullmatch('[0-9a-f]{40}', m['sourceCommit']) is not None, 'Invalid source commit.')
require(git('rev-parse', m['sourceCommit'] + '^{tree}').decode().strip() == m['sourceTree'], 'Source tree mismatch.')
require(subprocess.run(['git', '-C', str(ROOT), 'merge-base', '--is-ancestor', m['sourceCommit'], 'HEAD']).returncode == 0,
        'Release does not descend from its fixed source commit.')
changed = git('diff', '--name-only', m['sourceCommit'], 'HEAD').decode().splitlines()
require(all(p.startswith('scripts/release-v0.5.0-rc.2/') or p == '.github/workflows/release-v0.5.0-rc.2.yml' for p in changed),
        'Product files changed after the package was verified.')
require(not git('status', '--porcelain', '--untracked-files=no').strip(), 'Tracked files are dirty.')
data = archive.read_bytes()
digest = hashlib.sha256(data).hexdigest()
require(len(data) == m['bytes'] and digest == m['sha256'], 'Archive differs from the verified package.')
with tarfile.open(archive) as tar:
    members = tar.getmembers()
    require(all(f.isfile() and f.name.startswith('package/') and f.mode == 0o644 for f in members), 'Unexpected archive entry.')
    names = [f.name.removeprefix('package/') for f in members]
    require(len(names) == len(set(names)) == 23 and set(names) == ALLOWED, 'Production allowlist mismatch.')
    payload = {name: tar.extractfile(f).read() for name, f in zip(names, members)}
require({name: hashlib.sha256(value).hexdigest() for name, value in payload.items()} == m['payloadSHA256'], 'Payload hash mismatch.')
for name, value in payload.items():
    require(value == git('show', 'HEAD:' + name), 'Package differs from install tree: ' + name)
pkg = json.loads(payload['package.json'])
require(pkg['name'] == 'deepseek-servant' and pkg['version'] == '0.5.0', 'Package identity mismatch.')
require(set(pkg['files']) | {'package.json'} == ALLOWED, 'package.files differs from the reviewed allowlist.')
require('dsh' not in pkg.get('engines', {}), 'Unexpected Host version gate.')
require(all(value == '*' for name, value in pkg['peerDependencies'].items() if name.startswith('@deepseek-ai/')), 'Unexpected Host peer-version gate.')
spec = 'github:Tests4gptplay/deepseek-servant#v0.5.0-rc.2'
for name in ('README.md', 'docs/INSTALLATION.md', 'docs/releases/0.5.0.md'):
    require(spec in payload[name].decode(), 'Wrong fixed Git installation source: ' + name)
notes = (META / 'NOTES.md').read_text()
url = 'https://github.com/Tests4gptplay/deepseek-servant/releases/download/v0.5.0-rc.2/' + m['archive']
require(spec in notes and url in notes and m['sha256'] in notes, 'Release notes do not match the package.')
print(json.dumps({'sourceCommit': m['sourceCommit'], 'releaseCommit': git('rev-parse', 'HEAD').decode().strip(),
                  'archive': archive.name, 'bytes': len(data), 'sha256': digest, 'payloadFiles': len(payload),
                  'scope': 'fixed package consistency'}, indent=2))
