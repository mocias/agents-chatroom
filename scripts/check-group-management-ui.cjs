const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {_electron}=require('playwright-core');
(async()=>{
 const home=fs.mkdtempSync(path.resolve('output/group-management-ui-')),data=path.join(home,'data');fs.mkdirSync(data);
 fs.writeFileSync(path.join(data,'discovery-consent.json'),JSON.stringify({choice:'manual'}));
 fs.writeFileSync(path.join(data,'catalog.json'),JSON.stringify({version:1,agents:[],conversations:[{id:'group-old',kind:'group',title:'较早的群聊',agentIds:[],updatedAt:'2026-01-01T00:00:00Z'},{id:'group-new',kind:'group',title:'较新的群聊',agentIds:[],updatedAt:'2026-02-01T00:00:00Z'}]}));
 const env={...process.env,AGENT_ROOM_DESKTOP_HOME:home};delete env.ELECTRON_RUN_AS_NODE;let app;const errors=[];
 const launch=async()=>{app=await _electron.launch({executablePath:process.env.SMOKE_EXECUTABLE||path.resolve('dist/win-unpacked/Agent Room.exe'),env});await app.evaluate(()=>{process.on('uncaughtException',e=>console.log('MAIN_ERROR:'+e.message));});app.on('console',m=>{if(m.text().includes('MAIN_ERROR:'))errors.push(m.text());});const page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));await page.locator('[data-room="group-new"]').waitFor();return page;};
 try {
  let page=await launch();assert.equal(await page.locator('[data-room]').first().getAttribute('data-room'),'group-new');
  await page.locator('[data-room="group-old"]').click({button:'right'});await page.getByRole('menuitem',{name:'置顶',exact:true}).click();
  await page.locator('[data-room="group-old"] .pin-mark').waitFor();assert.equal(await page.locator('[data-room]').first().getAttribute('data-room'),'group-old');
  await app.close();app=null;page=await launch();assert.equal(await page.locator('[data-room]').first().getAttribute('data-room'),'group-old');
  await page.locator('[data-room="group-old"]').click();await page.getByRole('button',{name:'群聊管理',exact:true}).click();await page.getByRole('menuitem',{name:'取消置顶',exact:true}).click();
  await page.locator('[data-room="group-old"] .pin-mark').waitFor({state:'detached'});assert.equal(await page.locator('[data-room]').first().getAttribute('data-room'),'group-new');
  await page.getByRole('button',{name:'群聊管理',exact:true}).click();await page.getByRole('menuitem',{name:'删除群聊',exact:true}).click();
  await page.screenshot({path:path.join(home,'delete-confirmation.png')});
  await page.getByRole('button',{name:'取消',exact:true}).click();assert.equal(await page.locator('[data-room="group-old"]').count(),1);
  await page.getByRole('button',{name:'群聊管理',exact:true}).click();await page.getByRole('menuitem',{name:'删除群聊',exact:true}).click();await page.getByRole('button',{name:'确认删除群聊',exact:true}).click();
  await page.locator('[data-room="group-old"]').waitFor({state:'detached'});await page.locator('#welcome').waitFor({state:'visible'});assert.equal(await page.evaluate(()=>localStorage.getItem('agent-room:selected')),null);
  await app.close();app=null;page=await launch();assert.equal(await page.locator('[data-room="group-old"]').count(),0);assert.equal(await page.locator('[data-room="group-new"]').count(),1);
  await app.close();app=null;assert.deepEqual(errors,[]);
  const result={ok:true,home,checks:['right-click pin and sorting','pin survives app restart','header menu unpin','delete cancel retains group','confirmed deletion clears current view','deleted group stays removed after restart','no renderer or main errors'],realModelCalls:0};fs.writeFileSync(path.join(home,'report.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }finally{if(app)await app.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
