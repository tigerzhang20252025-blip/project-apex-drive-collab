import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { launchTestBrowser } from './test-browser.mjs';

const base = process.argv[2] ?? 'http://127.0.0.1:4187/';
const output = process.argv[3] ?? 'test-evidence/multiplayer';
await mkdir(output, { recursive: true });
const browser = await launchTestBrowser();
const summary = { errors: [], combos: [], coverage: {}, frames: { sent: 0, heard: 0, maxSent: 0, maxHeard: 0 } };
const state = page => page.evaluate(() => window.apexDiagnostics.state());
const network = page => page.evaluate(() => window.apexDiagnostics.multiplayer());
const screenshot = (page, name, hideCode = false) => page.screenshot({
  path: join(output, name + '.jpg'), quality: 91,
  mask: hideCode ? [page.locator('#online-code')] : [],
  maskColor: '#25313a',
});
const ready = (page, enabled) => page.waitForFunction(
  enabled => document.querySelector('#online-ready').disabled !== enabled, enabled, { timeout: 30_000 },
);
function recordTraffic(page) {
  page.on('websocket', socket => {
    if (!new URL(socket.url()).pathname.startsWith('/socket/')) return;
    for (const [event, count, maximum] of [['framesent','sent','maxSent'],['framereceived','heard','maxHeard']]) {
      socket.on(event, frame => {
        const payload = frame.payload.toString();
        if (!payload.startsWith('{"type":"snapshot"')) return;
        summary.frames[count]++;
        summary.frames[maximum] = Math.max(summary.frames[maximum], Buffer.byteLength(payload));
      });
    }
  });
}
async function visit(name) {
  const context = await browser.newContext({ viewport: {width: 1280, height: 800}, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.addInitScript(()=>{
    const NativeSocket=window.WebSocket;
    window.WebSocket=class extends NativeSocket {
      constructor(...args){
        super(...args);
        if(new URL(this.url).pathname.startsWith('/socket/'))window.apexTestRelaySocket=this;
      }
    };
  });
  page.on('pageerror', error => summary.errors.push(error.message));
  recordTraffic(page);
  await page.goto(new URL('?diagnostics&garage=1', base).href);
  await page.locator('#stage[data-ready=true]').waitFor({timeout:90_000});
  await page.locator('#play-online').click();
  await page.locator('#online-name').fill(name);
  return page;
}
async function waitText(page, selector, expected) {
  await page.locator(selector).filter({hasText:expected}).waitFor({timeout:30_000});
}
async function selectCar(page, id) {
  await page.locator('#online-vehicle').selectOption(id);
  await page.locator('#stage[data-vehicle=' + id + ']').waitFor({timeout:40_000});
  await page.waitForFunction(id => document.querySelector('#online-vehicle').value === id &&
    !document.querySelector('#online-vehicle').disabled, id, {timeout:30_000});
}
async function start(a,b) {
  await ready(a,true);
  await ready(b,true);
  await a.locator('#online-ready').click();
  await b.locator('#online-ready').click();
  await a.locator('#online-start').click();
  await Promise.all([a,b].map(page=>page.locator('#online-hud').waitFor({timeout:15_000})));
  const startTime = await Promise.all([a,b].map(page=>page.evaluate(()=>new Promise(resolve=>{
    const sample=()=>{
      const info=window.apexDiagnostics.multiplayer();
      if(info.remaining<=0)resolve(performance.timeOrigin+performance.now());
      else requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }))));
  assert.ok(Math.abs(startTime[0]-startTime[1]) < 150, 'start wall-clock skew');
  return Math.round(Math.abs(startTime[0]-startTime[1]));
}
async function waitRemote(page, model) {
  await page.waitForFunction(model => {
    const {remote} = window.apexDiagnostics.multiplayer();
    return remote.visible && remote.model === model && remote.received >= 3;
  }, model, {timeout:30_000});
}
async function stats(page, ms=1200) {
  const before = await state(page);
  await delay(ms);
  const after = await state(page);
  const sorted=after.fpsSamples.slice(before.fpsSamples.length).sort((a,b)=>a-b);
  const at=p=>sorted[Math.max(0,Math.ceil(sorted.length*p)-1)];
  return {frames:sorted.length, medianFrameMs:at(.5), p95FrameMs:at(.95), draws:after.draws, triangles:after.triangles};
}

try {
  const a = await visit('Apex Driver');
  await a.locator('#play-solo').click();
  await a.locator('#garage-drive').click();
  await a.locator('[data-camera=chase]').click();
  summary.baseline = await stats(a);
  await a.locator('#open-garage').click();
  await a.locator('#play-online').click();

  const b = await visit('Alpine Driver');
  await a.locator('#online-create').click();
  await a.locator('#online-room').waitFor();
  await b.locator('#online-code-input').fill(await a.locator('#online-code').textContent());
  await b.locator('#online-join button').click();
  await waitText(a,'#online-drivers','Alpine Driver');
  await waitText(b,'#online-drivers','Apex Driver');
  await ready(a,true);
  await screenshot(a,'lobby',true);

  for (const [first,second] of [['f40','f40'],['f40','r35'],['r35','f40'],['r35','r35']]) {
    await selectCar(a,first);
    await selectCar(b,second);
    const skewMs = await start(a,b);
    await Promise.all([waitRemote(a,second),waitRemote(b,first)]);
    assert.equal((await state(a)).liveRigidBodies, 1);
    assert.equal((await state(b)).liveRigidBodies, 1);
    if (!summary.combos.length) {
      summary.online = await stats(a);
      const before=(await state(a)).position;
      await a.keyboard.down('w');
      await a.waitForFunction(()=>window.apexDiagnostics.state().speed>6,null,{timeout:12_000});
      await a.keyboard.up('w');
      assert.ok(Math.hypot(...(await state(a)).position.map((n,i)=>n-before[i]))>1);
      await screenshot(b,'free-drive-chase');
      const plate = await b.evaluate(()=>{
        const {scene,camera}=window.apexDiagnostics.inspect;
        const target=scene.children.find(n=>n.userData.remoteVehicle);
        const values={main:0,mirror:0};
        window.apexDrawChecks=values;
        target.traverse(node=>{
          if(!node.isMesh||node.userData.shadowOnly)return;
          const previous=node.onBeforeRender;
          node.onBeforeRender=function(renderer,scene,view,...args){
            if(view===camera) values.main++;
            else if(view.fov===30) values.mirror++;
            return previous.call(this,renderer,scene,view,...args);
          };
        });
        return target.children.length;
      });
      assert.ok(plate>0);
      for(const view of ['cockpit','hood']){
        await b.locator('[data-camera='+view+']').click();
        await b.evaluate(()=>{window.apexDrawChecks.main=0;});
        await b.waitForFunction(()=>window.apexDrawChecks.main>0,null,{timeout:8_000});
        await screenshot(b,'free-drive-'+view);
        summary.coverage[view]=true;
      }
      await b.locator('[data-camera=cockpit]').click();
      // Move the sender behind the stationary receiver to exercise the mirror frustum.
      const receiver=await state(b);
      await a.evaluate(({position,direction})=>{
        const car=window.apexDiagnostics.inspect.car;
        car.body.setTranslation({x:position[0]-direction[0]*10,y:position[1],z:position[2]-direction[2]*10},true);
        car.body.setLinvel({x:0,y:0,z:0},true);
      },receiver);
      await b.waitForFunction(()=>window.apexDrawChecks.mirror>0,null,{timeout:10_000});
      await screenshot(b,'free-drive-mirror');
      summary.coverage.mirror=true;
      const pixels=await b.evaluate(()=>{
        const source=document.querySelector('#minimap');
        const data=source.getContext('2d').getImageData(0,0,source.width,source.height).data;
        let count=0;
        for(let i=0;i<data.length;i+=4)if(data[i]<130&&data[i+1]>185&&data[i+2]>205)count++;
        return count;
      });
      assert.ok(pixels>0,'opponent minimap dot');
      summary.coverage.minimap=pixels;
      const peerSpawn=(await state(b)).position;
      await a.keyboard.press('r');
      await delay(600);
      assert.equal((await network(a)).session.id,(await network(b)).session.id);
      assert.ok(Math.hypot(...(await state(b)).position.map((n,i)=>n-peerSpawn[i]))<3,'reset remains local');
      const offline = Date.now();
      await a.context().setOffline(true);
      await a.evaluate(()=>window.apexTestRelaySocket.close(4000,'Simulated interruption'));
      await a.waitForFunction(()=>!window.apexDiagnostics.multiplayer().online);
      await delay(1100);
      await a.context().setOffline(false);
      await a.waitForFunction(()=>window.apexDiagnostics.multiplayer().online,null,{timeout:18_000});
      await waitRemote(b,first);
      assert.equal((await network(a)).slot,1);
      summary.coverage.offlineTestMs=Date.now()-offline;
    }
    summary.combos.push({first,second,skewMs,remoteA:(await network(a)).remote,remoteB:(await network(b)).remote});
    console.log('Free Drive',first,second,'start skew',skewMs,'ms');
    await a.locator('#online-end').click();
    await Promise.all([a,b].map(page=>page.locator('#online-room').waitFor({timeout:12_000})));
  }

  await a.locator('#online-mode').selectOption('challenge');
  await b.waitForFunction(()=>document.querySelector('#online-mode').value==='challenge');
  const skewMs=await start(a,b);
  const invalid=await a.evaluate(()=>window.apexDiagnostics.timeLapPath(185,true));
  assert.equal(invalid.count,0);
  await delay(29_000);
  const [lapA,lapB]=await Promise.all([a,b].map((page,i)=>page.evaluate(speed=>window.apexDiagnostics.timeLapPath(speed),[185,175][i])));
  assert.equal(lapA.count,1);
  assert.equal(lapB.count,1);
  await a.waitForFunction(()=>window.apexDiagnostics.multiplayer().session.results.every(row=>row.best!==null),null,{timeout:6_000});
  await Promise.all([a,b].map(page=>page.locator('#online-finish').waitFor({timeout:20_000})));
  await screenshot(a,'challenge-results');
  const results=(await network(a)).session.results;
  assert.ok(results[0].best<results[1].best);
  assert.ok(results.every(row=>row.sectors.every(Boolean)));
  assert.equal(await a.evaluate(()=>localStorage.getItem('apex.laps.alpine-proving-ground-v1.r35')),null);
  summary.challenge={skewMs,results};
  await b.locator('#online-return').click();
  await a.locator('#online-room').waitFor();
  await a.locator('#online-leave').click();
  await waitText(b,'#online-drivers','You · Host');
  await b.locator('#online-leave').click();
  await b.locator('#online-entry').waitFor();
  assert.deepEqual(summary.errors,[]);
} finally {
  await writeFile(join(output,'metrics.json'),JSON.stringify(summary,null,2)+'\n');
  await browser.close();
}
