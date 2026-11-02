"""Replace RC2 while preserving the previous tag target and release asset IDs."""
from pathlib import Path
import hashlib
import json
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
META = Path(__file__).resolve().parent
DIST = ROOT / 'dist'
EVIDENCE = ROOT / 'replacement-evidence'
REPO = 'Tests4gptplay/deepseek-servant'
RELEASE = 430959523
TAG = 'v0.5.0-rc.2'
OLD = '69630b2a63d14652eb73e596019d1b9cd6a360ec'
NEW = '485d5062c5eaf1e3a5dba075c5e0f16d747c98f8'
OLD_SHA = '85b39854a14ffbfc1322d702e75db5b4711a53c2dbbb1debacbaadff59c47268'
OLD_SUM_SHA = 'a21b274c137771d01e88b6a0834fed9ab626dd7bf1126b01bba1dbec93c89792'
NEW_SHA = '247e7fbf644ae287c9e835671cf975bac4e4bda710bad362bc7ff402365b15ea'
CANONICAL = 'deepseek-servant-0.5.0-rc.2.tgz'
FIXED = 'deepseek-servant-0.5.0-rc.2-485d5062c5ea.tgz'
STAGED = 'deepseek-servant-0.5.0-rc.2-staged-485d5062c5ea.tgz'
ARCHIVE = 'deepseek-servant-0.5.0-rc.2-archive-69630b2.tgz'
ORIGINAL_SUMS = 'SHA256SUMS-original-69630b2.txt'
STAGED_SUMS = 'SHA256SUMS-staged-485d5062c5ea.txt'
MANIFEST = 'RC2-MANIFEST-485d5062c5ea.json'
ARCHIVE_REF = 'tags/archive/v0.5.0-rc.2-69630b2'

def require(condition, message):
    if not condition:
        raise RuntimeError(message)

def run(*args, data=None):
    return subprocess.check_output(args, input=data)

def api(path, method='GET', data=None):
    args = ['gh', 'api', '-X', method, f'repos/{REPO}/{path}']
    encoded = None
    if data is not None:
        args += ['--input', '-']
        encoded = json.dumps(data).encode()
    return json.loads(run(*args, data=encoded))

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def release():
    return api(f'releases/{RELEASE}')

def tag_sha():
    ref = api(f'git/ref/tags/{TAG}')
    require(ref['object']['type'] == 'commit', 'Expected a lightweight RC2 tag.')
    return ref['object']['sha']

def snapshot(name):
    state = {'tagCommit': tag_sha(), 'release': release()}
    (EVIDENCE / name).write_text(json.dumps(state, indent=2) + '\n')
    return state

def assets():
    return {item['name']: item for item in release()['assets']}

def check_asset(item, asset_id, name, sha, size=None):
    require(item['id'] == asset_id and item['name'] == name, f'Asset identity changed: {name}')
    require(item.get('digest') == 'sha256:' + sha, f'Asset digest mismatch: {name}')
    if size is not None:
        require(item['size'] == size, f'Asset size mismatch: {name}')

def download(name, sha, directory):
    directory.mkdir(parents=True, exist_ok=True)
    run('gh', 'release', 'download', TAG, '--repo', REPO,
        '--pattern', name, '--dir', str(directory))
    require(digest(directory / name) == sha, f'Downloaded bytes mismatch: {name}')

def upload(path):
    require(path.name not in assets(), f'Asset already exists: {path.name}')
    run('gh', 'release', 'upload', TAG, str(path), '--repo', REPO)
    item = assets()[path.name]
    check_asset(item, item['id'], path.name, digest(path), path.stat().st_size)
    download(path.name, digest(path), EVIDENCE / 'staged-download')
    print(json.dumps({'uploadedAsset': path.name, 'id': item['id'], 'sha256': digest(path)}), flush=True)
    return item

def rename(asset_id, current_name, next_name, sha, label):
    current = assets()
    require(next_name not in current, f'Rename destination already exists: {next_name}')
    check_asset(current[current_name], asset_id, current_name, sha)
    api(f'releases/assets/{asset_id}', 'PATCH', {'name': next_name, 'label': label})
    check_asset(api(f'releases/assets/{asset_id}'), asset_id, next_name, sha)
    print(json.dumps({'renamedAssetId': asset_id, 'from': current_name, 'to': next_name}), flush=True)

def main():
    EVIDENCE.mkdir(exist_ok=True)
    subprocess.run(['python3', str(META / 'verify-package.py'), str(DIST / CANONICAL)], check=True)
    manifest = json.loads((DIST / MANIFEST).read_text())
    require(manifest['sourceCommit'] == NEW and manifest['sha256'] == NEW_SHA, 'Wrong replacement manifest.')
    require(digest(DIST / CANONICAL) == NEW_SHA, 'Wrong local package.')
    old = snapshot('before.json')
    require(old['tagCommit'] == OLD, 'RC2 no longer points at the expected old commit.')
    require(old['release']['id'] == RELEASE and old['release']['tag_name'] == TAG,
            'Release identity changed.')
    require(not old['release'].get('immutable') and not old['release']['draft']
            and old['release']['prerelease'], 'Release cannot be replaced as a mutable prerelease.')
    current = {item['name']: item for item in old['release']['assets']}
    check_asset(current[CANONICAL], 699978111, CANONICAL, OLD_SHA, 5565610)
    check_asset(current['SHA256SUMS.txt'], 699978115, 'SHA256SUMS.txt', OLD_SUM_SHA, 98)
    for name in (FIXED, STAGED, ARCHIVE, ORIGINAL_SUMS, STAGED_SUMS, MANIFEST):
        require(name not in current, f'Destination asset already exists: {name}')
    download(CANONICAL, OLD_SHA, EVIDENCE / 'original-download')
    download('SHA256SUMS.txt', OLD_SUM_SHA, EVIDENCE / 'original-download')

    # Preserve the old commit before changing any release asset or the RC2 tag.
    existing = run('git', 'ls-remote', 'origin', 'refs/' + ARCHIVE_REF).decode().strip()
    if existing:
        require(existing.split()[0] == OLD, 'Rollback ref exists at a different commit.')
    else:
        api('git/refs', 'POST', {'ref': 'refs/' + ARCHIVE_REF, 'sha': OLD})
    require(api('git/ref/' + ARCHIVE_REF)['object']['sha'] == OLD, 'Rollback ref verification failed.')

    (DIST / FIXED).write_bytes((DIST / CANONICAL).read_bytes())
    (DIST / STAGED).write_bytes((DIST / CANONICAL).read_bytes())
    sums = f'{NEW_SHA}  {CANONICAL}\n{NEW_SHA}  {FIXED}\n{OLD_SHA}  {ARCHIVE}\n'
    (DIST / STAGED_SUMS).write_text(sums)
    fixed = upload(DIST / FIXED)
    staged = upload(DIST / STAGED)
    checksum = upload(DIST / STAGED_SUMS)
    manifest_asset = upload(DIST / MANIFEST)
    snapshot('staged.json')
    require(tag_sha() == OLD, 'RC2 changed while replacement assets were staged.')

    # Renames retain the original asset IDs and bytes. No delete/clobber operation is used.
    rename(699978111, CANONICAL, ARCHIVE, OLD_SHA, 'Previous RC2 build; rollback only')
    rename(699978115, 'SHA256SUMS.txt', ORIGINAL_SUMS, OLD_SUM_SHA, 'Original checksum receipt for previous RC2')
    rename(staged['id'], STAGED, CANONICAL, NEW_SHA, 'RC2 update 485d5062c5ea')
    rename(checksum['id'], STAGED_SUMS, 'SHA256SUMS.txt', digest(DIST / STAGED_SUMS), 'Current and archived RC2 checksums')
    snapshot('assets-switched.json')

    # The exact lease refuses an intervening tag update. GITHUB_TOKEN avoids retriggering the old tag workflow.
    run('git', 'push', '--force-with-lease=refs/tags/' + TAG + ':' + OLD,
        'origin', NEW + ':refs/tags/' + TAG)
    require(tag_sha() == NEW, 'RC2 tag did not resolve to the approved commit.')
    api(f'releases/{RELEASE}', 'PATCH', {
        'name': 'DeepSeek Servant 0.5.0 RC2 — UI update',
        'body': (META / 'NOTES.md').read_text(),
        'target_commitish': NEW,
        'prerelease': True,
        'make_latest': 'false',
    })
    final = snapshot('after.json')
    require(final['release']['body'] == (META / 'NOTES.md').read_text(), 'Release notes mismatch.')
    for name, sha in ((CANONICAL, NEW_SHA), (FIXED, NEW_SHA), (ARCHIVE, OLD_SHA),
                      ('SHA256SUMS.txt', digest(DIST / STAGED_SUMS)), (ORIGINAL_SUMS, OLD_SUM_SHA),
                      (MANIFEST, digest(DIST / MANIFEST))):
        download(name, sha, EVIDENCE / 'final-download')
    require((EVIDENCE / 'final-download/SHA256SUMS.txt').read_text() == sums, 'Checksum filenames mismatch.')
    final_assets = {item['name']: item for item in final['release']['assets']}
    check_asset(final_assets[ARCHIVE], 699978111, ARCHIVE, OLD_SHA, 5565610)
    check_asset(final_assets[ORIGINAL_SUMS], 699978115, ORIGINAL_SUMS, OLD_SUM_SHA, 98)
    result = {'tagCommit': NEW, 'rollbackCommit': OLD, 'releaseURL': final['release']['html_url'],
              'packageSHA256': NEW_SHA, 'canonicalAssetId': staged['id'], 'fixedAssetId': fixed['id'],
              'manifestAssetId': manifest_asset['id'], 'oldAssetIdsPreserved': [699978111, 699978115],
              'downloadedAndVerified': [CANONICAL, FIXED, ARCHIVE, 'SHA256SUMS.txt', ORIGINAL_SUMS, MANIFEST]}
    (EVIDENCE / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2), flush=True)

if __name__ == '__main__':
    try:
        main()
    except Exception:
        if EVIDENCE.exists():
            try:
                snapshot('failure-state.json')
            except Exception as error:
                print(f'Could not read back failure state: {type(error).__name__}', file=sys.stderr)
        raise
