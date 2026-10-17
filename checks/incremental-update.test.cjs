const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const {execFileSync}=require('node:child_process');
const {build}=require('../scripts/build-incremental.cjs');
test('binary delta reconstructs, truncates and adds files without touching user data; wrong base is rejected', {skip:process.platform!=='win32'},()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'agent-update-test-'));const base=path.join(root,'old'),next=path.join(root,'next'),out=path.join(root,'patch');
 for(const dir of [base,next])fs.mkdirSync(path.join(dir,'resources'),{recursive:true});
 const old=Buffer.alloc(200000,4),updated=Buffer.from(old);updated[80000]=99;
 fs.writeFileSync(path.join(base,'Agent Room.exe'),old);fs.writeFileSync(path.join(next,'Agent Room.exe'),updated);
 fs.writeFileSync(path.join(base,'resources','app.asar'),'long old content');fs.writeFileSync(path.join(next,'resources','app.asar'),'new');fs.writeFileSync(path.join(next,'extra.dll'),'added');
 fs.mkdirSync(path.join(base,'my data'));fs.writeFileSync(path.join(base,'my data','keep.txt'),'untouched');
 const result=build(base,next,out,'1','2');assert.ok(result.payloadBytes<70000);
 const run=()=>execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(out,'Apply-Update.ps1'),'-InstallDir',base,'-NoLaunch'],{windowsHide:true,timeout:60000,stdio:'pipe'});
 fs.writeFileSync(path.join(base,'Agent Room.exe'),'wrong');assert.throws(run);assert.equal(fs.readFileSync(path.join(base,'resources','app.asar'),'utf8'),'long old content');
 fs.writeFileSync(path.join(base,'Agent Room.exe'),old);
 const manifestPath=path.join(out,'manifest.json');const valid=fs.readFileSync(manifestPath);const broken=JSON.parse(valid);broken.files[0].newHash='bad';fs.writeFileSync(manifestPath,JSON.stringify(broken));assert.throws(run);assert.deepEqual(fs.readFileSync(path.join(base,'Agent Room.exe')),old);fs.writeFileSync(manifestPath,valid);
 run();assert.deepEqual(fs.readFileSync(path.join(base,'Agent Room.exe')),updated);assert.equal(fs.readFileSync(path.join(base,'resources','app.asar'),'utf8'),'new');assert.equal(fs.readFileSync(path.join(base,'extra.dll'),'utf8'),'added');assert.equal(fs.readFileSync(path.join(base,'my data','keep.txt'),'utf8'),'untouched');
 assert.ok(fs.readdirSync(base).some(name=>name.startsWith('.update-backup-')));
});
