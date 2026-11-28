from pathlib import Path
import hashlib, json, subprocess, sys, tarfile
root = Path(__file__).resolve().parents[2]
p = Path(sys.argv[1])
with tarfile.open(p) as t:
    members = t.getmembers()
    assert all(x.isfile() and x.name.startswith("package/") and ".." not in Path(x.name).parts for x in members)
    data = {x.name.removeprefix("package/"): t.extractfile(x).read() for x in members}
assert len(data) == len(members)
assert all((root / n).read_bytes() == b for n, b in data.items())
assert json.loads(data["package.json"])["version"] == "0.5.0"
for n in ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md", "python/licenses/Dulwich-COPYING", "python/licenses/urllib3-LICENSE.txt", "docs/releases/0.5.0.md", "docs/testing/0.5.0.md"]:
    assert data[n]
# Preserve the previously verified runtime payload; only release metadata and documentation change.
baseline = "fd4ea2ee2daf8d6cb895309af78e7acf7130f2f8"
for n, b in data.items():
    if n.startswith(("lib/", "python/", "upgrades/")) or n == "cordis.patch.yml":
        assert subprocess.check_output(["git", "show", baseline + ":" + n], cwd=root) == b, n
m = {"version": "0.5.0", "commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip(), "sha256": hashlib.sha256(p.read_bytes()).hexdigest(), "bytes": p.stat().st_size, "payloadSHA256": {n: hashlib.sha256(b).hexdigest() for n,b in sorted(data.items())}}
p.with_name("MANIFEST.json").write_text(json.dumps(m, indent=2) + "\n")
print("Verified 0.5.0 package:", len(data), "files; runtime payload unchanged.")
