const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {createDataLocation}=require('../standalone/data-location.cjs');
function fixture(){const base=fs.mkdtempSync(path.join(os.tmpdir(),'data-location-'));const from=path.join(base,'old');const to=path.join(base,'new');fs.mkdirSync(path.join(from,'rooms'),{recursive:true});fs.writeFileSync(path.join(from,'catalog.json'),JSON.stringify({agents:[{id:'a'}],conversations:[]}));fs.writeFileSync(path.join(from,'rooms','history.log.jsonl'),'history');return {base,from,to,config:path.join(base,'location.json')};}
test('data directory is switched only after restart and complete manual copy; original is retained',()=>{
 const f=fixture();const location=createDataLocation(f.from,f.config);location.schedule(f.to);
 assert.equal(location.current,f.from);assert.equal(fs.existsSync(f.to),false);
 const missing=createDataLocation(f.from,f.config);assert.equal(missing.current,f.from);assert.match(missing.status().warning,/仍使用原目录/);
 fs.cpSync(f.from,f.to,{recursive:true});
 const switched=createDataLocation(f.from,f.config);assert.equal(switched.current,f.to);assert.equal(switched.status().pending,null);
 assert.equal(fs.readFileSync(path.join(f.from,'rooms','history.log.jsonl'),'utf8'),'history');
 assert.equal(createDataLocation(f.from,f.config).current,f.to);
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
