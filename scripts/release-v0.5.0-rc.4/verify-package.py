from pathlib import Path
import hashlib,json,sys,tarfile
root=Path(__file__).resolve().parents[2]
m=json.loads(Path(__file__).with_name('manifest.json').read_text())
p=Path(sys.argv[1]); assert hashlib.sha256(p.read_bytes()).hexdigest()==m['sha256']
with tarfile.open(p) as t:
 members=t.getmembers();assert all(x.isfile() and x.name.startswith('package/') for x in members)
 data={x.name.removeprefix('package/'):t.extractfile(x).read() for x in members}
assert len(data)==len(members)==40
assert {n:hashlib.sha256(b).hexdigest() for n,b in data.items()}==m['payloadSHA256']
assert all((root/n).read_bytes()==b for n,b in data.items())
assert json.loads(data['package.json'])['version']=='0.5.0-rc.4'
print('Verified exact RC4 payload: 40 files; candidate.1 runtime preserved.')
