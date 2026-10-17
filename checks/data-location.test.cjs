const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {createDataLocation}=require('../standalone/data-location.cjs');
function fixture(){const base=fs.mkdtempSync(path.join(os.tmpdir(),'data-location-'));const from=path.join(base,'old');const to=path.join(base,'new');fs.mkdirSync(path.join(from,'rooms'),{recursive:true});fs.writeFileSync(path.join(from,'catalog.json'),JSON.stringify({agents:[{id:'a'}],conversations:[]}));fs.writeFileSync(path.join(from,'rooms','history.log.jsonl'),'history');return {base,from,to,config:path.join(base,'location.json')};}
test('data directory automatically copies on restart; original is retained',()=>{
 const f=fixture();const location=createDataLocation(f.from,f.config);location.schedule(f.to);
 assert.equal(location.current,f.from);assert.equal(fs.existsSync(f.to),false);
 const switched=createDataLocation(f.from,f.config);assert.equal(switched.current,f.to);assert.equal(switched.status().pending,null);
 assert.equal(fs.readFileSync(path.join(f.from,'rooms','history.log.jsonl'),'utf8'),'history');
 assert.equal(createDataLocation(f.from,f.config).current,f.to);
});
test('migration remaps internal workspaces, retains external paths, copies alarms and recovers committed copy',()=>{
 const f=fixture();const internal=path.join(f.from,'workspaces','a');fs.mkdirSync(internal,{recursive:true});fs.writeFileSync(path.join(internal,'work.txt'),'real work');
 fs.writeFileSync(path.join(f.from,'catalog.json'),JSON.stringify({agents:[{workspace:internal},{workspace:f.base}],conversations:[{nativeSessions:{a:'old'},id:'room'}]}));
 fs.writeFileSync(path.join(f.from,'alarms.json'),'[]');
 const location=createDataLocation(f.from,f.config);location.schedule(f.to);
 const next=createDataLocation(f.from,f.config);assert.equal(next.current,f.to);
 const catalog=JSON.parse(fs.readFileSync(path.join(f.to,'catalog.json')));
 assert.equal(catalog.agents[0].workspace,path.join(f.to,'workspaces','a'));assert.equal(catalog.agents[1].workspace,f.base);assert.equal(catalog.conversations[0].nativeSessions,undefined);
 assert.equal(fs.readFileSync(path.join(f.to,'workspaces','a','work.txt'),'utf8'),'real work');assert.equal(fs.readFileSync(path.join(f.to,'alarms.json'),'utf8'),'[]');
 fs.writeFileSync(f.config,JSON.stringify({current:f.from,pending:f.to}));assert.equal(createDataLocation(f.from,f.config).current,f.to);
});
test('conflicting destination is never overwritten and reserved application paths are rejected',()=>{
 const f=fixture();fs.mkdirSync(f.to);fs.writeFileSync(path.join(f.to,'keep.txt'),'keep');
 const location=createDataLocation(f.from,f.config,{installDir:path.join(f.base,'app')});assert.throws(()=>location.schedule(f.to));assert.equal(fs.readFileSync(path.join(f.to,'keep.txt'),'utf8'),'keep');
 assert.throws(()=>location.schedule(path.join(f.base,'app')),/独立/);assert.throws(()=>location.schedule(path.join(f.base,'app','resources','data')),/独立/);
 fs.writeFileSync(f.config,JSON.stringify({current:f.from,pending:f.to}));const failed=createDataLocation(f.from,f.config);assert.equal(failed.current,f.from);assert.match(failed.status().warning,/自动迁移未完成/);
});
test('incomplete, stale and nested copies are rejected; pending selection can be cancelled',()=>{
 const f=fixture();const location=createDataLocation(f.from,f.config);
 assert.throws(()=>location.schedule(path.join(f.from,'nested')),/相互包含/);
 assert.throws(()=>location.schedule(f.base),/相互包含/);
 assert.throws(()=>location.schedule('relative'),/绝对路径/);
 location.schedule(f.to);fs.cpSync(f.from,f.to,{recursive:true});
 fs.writeFileSync(path.join(f.to,'rooms','history.log.jsonl'),'stale');
 assert.equal(createDataLocation(f.from,f.config).current,f.from);
 location.cancel();assert.equal(createDataLocation(f.from,f.config).status().pending,null);
});
