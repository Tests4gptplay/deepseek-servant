"""Owner-authorized same-version replacement; never deletes an asset."""
import datetime,hashlib,json,os,pathlib,subprocess
R='repos/Tests4gptplay/deepseek-servant'; OLD='021ddb63a332253c94730692037693327a113db2'; RELEASE=447696620
NAMES=['deepseek-servant-0.5.0-rc.5.tgz','deepseek-servant-0.5.0-rc.5-source.zip','RC5-MANIFEST.json','SHA256SUMS.txt']
OLD_HASH={'deepseek-servant-0.5.0-rc.5.tgz':'998759d6c7968a0aec261424dc964605a11a2b5bcda9aaa95151fe8264a3a3d6','deepseek-servant-0.5.0-rc.5-source.zip':'8118318aaaf69f2f44ececd16247839725537bc378877eb5e1a0eeb4951345a2','RC5-MANIFEST.json':'c84098e302f62b2a643a0ee99f263e670fd6ee350b3878c1767006db22faab07','SHA256SUMS.txt':'abe168db43e9978a6407f63c905c1a40bd3f8c5c0cbc7ffb322b3202ae97c7f8'}
def api(path,method='GET',data=None):
 cmd=['gh','api',path,'--method',method]
 if data is not None:cmd+=['--input','-']
 return json.loads(subprocess.check_output(cmd,input=None if data is None else json.dumps(data).encode()))
def ref(name):return api(R+'/git/ref/'+name)['object']['sha']
def rename(a,n):return api(R+'/releases/assets/'+str(a['id']),'PATCH',{'name':n})
new=os.environ['GITHUB_SHA']; assert ref('heads/release/0.5.0-rc.5')==new
assert ref('tags/v0.5.0-rc.5')==OLD
release=api(R+'/releases/'+str(RELEASE)); assert release['tag_name']=='v0.5.0-rc.5'
assets={a['name']:a for a in release['assets']}
for n in NAMES:
 assert assets[n]['digest']=='sha256:'+OLD_HASH[n],n
 assert 'superseded-021ddb63-'+n not in assets,n
backup={'observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'release':release,'oldCommit':OLD,'newCommit':new}
pathlib.Path('replacement-audit.json').write_text(json.dumps(backup,indent=2))
# Retain old commit under a non-triggering archival branch as well as ancestry.
archived = api(R+'/git/matching-refs/heads/archive/rc5-before-dependency-fix-021ddb63')
if archived:
 assert len(archived)==1 and archived[0]['object']['sha']==OLD
else:
 api(R+'/git/refs','POST',{'ref':'refs/heads/archive/rc5-before-dependency-fix-021ddb63','sha':OLD})
staged={}
for n in NAMES:
 stage='staged-'+new[:12]+'-'+n
 # upload name must be supplied as API query, not gh's display label.
 url=release['upload_url'].split('{')[0]+'?name='+stage
 a=assets.get(stage)
 if a is None:
  a=json.loads(subprocess.check_output(['gh','api',url,'--method','POST','-H','Content-Type: application/octet-stream','--input','dist/'+n]))
 expected='sha256:'+hashlib.sha256(pathlib.Path('dist',n).read_bytes()).hexdigest()
 assert a['digest']==expected,(n,a.get('digest'),expected)
 staged[n]=a
# At this point all new bytes are uploaded and digest-verified; tag remains old.
assert ref('tags/v0.5.0-rc.5')==OLD
assert ref('heads/release/0.5.0-rc.5')==new
renamed_old=[];renamed_new=[]
try:
 for n in NAMES:
  rename(assets[n],'superseded-021ddb63-'+n);renamed_old.append(n)
  rename(staged[n],n);renamed_new.append(n)
 api(R+'/git/refs/tags/v0.5.0-rc.5','PATCH',{'sha':new,'force':False})
except Exception:
 for n in reversed(renamed_new):rename(staged[n],'staged-'+new[:12]+'-'+n)
 for n in reversed(renamed_old):rename(assets[n],n)
 raise
api(R+'/releases/'+str(RELEASE),'PATCH',{'target_commitish':new,'body':pathlib.Path('scripts/release-v0.5.0-rc.5/NOTES.md').read_text(),'prerelease':True,'make_latest':'false'})
final=api(R+'/releases/'+str(RELEASE)); lookup={a['name']:a for a in final['assets']}
for n in NAMES:
 assert lookup[n]['id']==staged[n]['id']
 assert lookup['superseded-021ddb63-'+n]['id']==assets[n]['id']
 assert lookup[n]['digest']=='sha256:'+hashlib.sha256(pathlib.Path('dist',n).read_bytes()).hexdigest()
assert ref('tags/v0.5.0-rc.5')==new
backup.update(completedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),finalRelease=final)
pathlib.Path('replacement-audit.json').write_text(json.dumps(backup,indent=2))
print('Replacement verified; old asset IDs retained; tag and current assets match',new)
