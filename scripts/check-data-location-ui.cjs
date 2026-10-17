const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');const {_electron}=require('playwright-core');
(async()=>{
 const home=fs.mkdtempSync(path.resolve('output/data-location-ui-'));const from=path.join(home,'data');const target=path.join(home,'relocated');fs.mkdirSync(from);fs.mkdirSync(path.join(from,'workspaces','test'),{recursive:true});fs.writeFileSync(path.join(from,'workspaces','test','keep.txt'),'keep');
 fs.writeFileSync(path.join(from,'discovery-consent.json'),JSON.stringify({choice:'manual'}));
 fs.writeFileSync(path.join(from,'catalog.json'),JSON.stringify({version:1,agents:[{id:'agent-test',label:'保留的伙伴',backend:'dsh',workspace:path.join(from,'workspaces','test')}],conversations:[{id:'chat-test',kind:'direct',title:'保留的伙伴',agentIds:['agent-test'],updatedAt:new Date().toISOString()}]}));
 const env={...process.env,AGENT_ROOM_DESKTOP_HOME:home};delete env.ELECTRON_RUN_AS_NODE;let app;
 const launch=async()=>{app=await _electron.launch({executablePath:path.resolve('dist/win-unpacked/Agent Room.exe'),env});const page=await app.firstWindow();await page.locator('[data-room="chat-test"]').waitFor();return page;};
 try {
  let page=await launch();await app.evaluate(({app})=>{app.relaunch=()=>{};});await page.locator('#backends').click();await page.locator('#data-location-settings').click();
  await page.locator('[name="dataPath"]').fill(target);
  await page.screenshot({path:path.join(home,'settings.png')});
  const closed=app.waitForEvent('close');await page.getByRole('button',{name:'迁移并重启',exact:true}).click();await closed;app=null;
  assert.equal(JSON.parse(fs.readFileSync(path.join(home,'data-location.json'))).pending,target);
  page=await launch();const info=await page.evaluate(async()=>await (await fetch('/api/data-location')).json());assert.equal(info.current,target);assert.equal(info.pending,null);
  const catalog=await page.evaluate(async()=>await (await fetch('/api/catalog')).json());assert.equal(catalog.agents[0].label,'保留的伙伴');assert.ok(fs.existsSync(from));assert.equal(catalog.agents[0].workspace,path.join(target,'workspaces','test'));assert.equal(fs.readFileSync(path.join(target,'workspaces','test','keep.txt'),'utf8'),'keep');
  console.log(JSON.stringify({home,ok:true,checks:['UI schedules automatic restart','Next launch automatically copies data','Agent and workspace preserved, path remapped, original retained']}));
  fs.writeFileSync(path.join(home,'report.json'),JSON.stringify({ok:true,current:info.current,oldRetained:true}));
 }finally{if(app)await app.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
