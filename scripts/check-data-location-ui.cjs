const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');const {_electron}=require('playwright-core');
(async()=>{
 const home=fs.mkdtempSync(path.resolve('output/data-location-ui-'));const from=path.join(home,'data');const target=path.join(home,'relocated');fs.mkdirSync(from);
 fs.writeFileSync(path.join(from,'discovery-consent.json'),JSON.stringify({choice:'manual'}));
 fs.writeFileSync(path.join(from,'catalog.json'),JSON.stringify({version:1,agents:[{id:'agent-test',label:'保留的伙伴',backend:'dsh',workspace:home}],conversations:[{id:'chat-test',kind:'direct',title:'保留的伙伴',agentIds:['agent-test'],updatedAt:new Date().toISOString()}]}));
 const env={...process.env,AGENT_ROOM_DESKTOP_HOME:home};delete env.ELECTRON_RUN_AS_NODE;let app;
 const launch=async()=>{app=await _electron.launch({executablePath:path.resolve('dist/win-unpacked/Agent Room.exe'),env});const page=await app.firstWindow();await page.locator('[data-room="chat-test"]').waitFor();return page;};
 try {
  let page=await launch();await page.locator('#backends').click();await page.locator('#data-location-settings').click();
  await page.locator('[name="dataPath"]').fill(target);await page.getByRole('button',{name:'保存，下次启动生效'}).click();
  await page.locator('#cancel-data-change').waitFor();
  let info=await page.evaluate(async()=>await (await fetch('/api/data-location')).json());assert.equal(info.current,from);assert.equal(info.pending,target);assert.equal(fs.existsSync(target),false);
  await page.screenshot({path:path.join(home,'settings.png')});await app.close();app=null;
  page=await launch();info=await page.evaluate(async()=>await (await fetch('/api/data-location')).json());assert.equal(info.current,from);assert.ok(info.warning);await app.close();app=null;
  fs.cpSync(from,target,{recursive:true});
  page=await launch();info=await page.evaluate(async()=>await (await fetch('/api/data-location')).json());assert.equal(info.current,target);assert.equal(info.pending,null);
  const catalog=await page.evaluate(async()=>await (await fetch('/api/catalog')).json());assert.equal(catalog.agents[0].label,'保留的伙伴');assert.ok(fs.existsSync(from));
  console.log(JSON.stringify({home,ok:true,checks:['UI saves pending without copying','Restart without migration falls back and warns','Manual copy activates on restart with Agent preserved and original retained']}));
  fs.writeFileSync(path.join(home,'report.json'),JSON.stringify({ok:true,current:info.current,oldRetained:true}));
 }finally{if(app)await app.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
