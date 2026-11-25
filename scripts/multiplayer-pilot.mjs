import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { launchTestBrowser } from './test-browser.mjs';

const url = process.argv[2];
assert.ok(url, 'Pass the complete pilot URL');
const output = process.argv[3] ?? 'test-evidence/multiplayer-pilot';
const origin = new URL(url).origin;
const endpoint = process.env.APEX_TEST_RELAY_ORIGIN ?? origin;
const staticBuild = process.env.APEX_TEST_STATIC_DIR ? resolve(process.env.APEX_TEST_STATIC_DIR) : undefined;
await mkdir(output, {recursive:true});
const browser = await launchTestBrowser();
const measurements = [];
const errors = [];
const percentile = (values,p) => {
  const sorted = [...values].sort((a,b)=>a-b);
  return sorted.length ? Math.round(sorted[Math.ceil(sorted.length*p)-1]*10)/10 : null;
};
async function open(name) {
  const page = await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:1});
  const metrics = { sent:0, received:0, uploadBytes:0, downloadBytes:0, rtt:[], intervals:[],
    framesMissed:0, maxUploadBytes:0, maxDownloadBytes:0 };
  measurements.push(metrics);
  page.on('pageerror',error=>errors.push(error.message));
  page.on('websocket',socket=>{
    if(!new URL(socket.url()).pathname.startsWith('/socket/'))return;
    const pings=new Map();
    let previous;
    socket.on('framesent',({payload})=>{
      const data=JSON.parse(payload.toString());
      const size=Buffer.byteLength(payload);
      if(data.type==='ping')pings.set(data.n,performance.now());
      if(data.type==='snapshot'){
        metrics.sent++;metrics.uploadBytes+=size;
        metrics.maxUploadBytes=Math.max(metrics.maxUploadBytes,size);
      }
    });
    socket.on('framereceived',({payload})=>{
      const data=JSON.parse(payload.toString());
      const size=Buffer.byteLength(payload);
      if(data.type==='pong'&&pings.has(data.n)){
        metrics.rtt.push(performance.now()-pings.get(data.n));
        pings.delete(data.n);
      }
      if(data.type==='snapshot'){
        const now=performance.now();
        if(previous && data.live.session===previous.session && previous.generation===data.generation){
          metrics.intervals.push(now-previous.at);
          metrics.framesMissed+=Math.max(0,data.seq-previous.seq-1);
        }
        previous={at:now,seq:data.seq,session:data.live.session,generation:data.generation};
        metrics.received++;metrics.downloadBytes+=size;
        metrics.maxDownloadBytes=Math.max(metrics.maxDownloadBytes,size);
      }
    });
  });
  if(staticBuild){
    await page.route(origin+'/**',async route=>{
      const pathname=new URL(route.request().url()).pathname;
      const file=resolve(staticBuild, '.'+(pathname==='/'?'/index.html':pathname));
      if(!file.startsWith(staticBuild+sep))return route.abort();
      try{await route.fulfill({path:file});}catch{await route.fulfill({status:404});}
    });
  }
  await page.goto(url);
  await page.locator('#stage[data-ready=true]').waitFor({timeout:90_000});
  await page.locator('#play-online').click();
  await page.locator('#online-name').fill(name);
  return page;
}
async function start(first,second) {
  await first.locator('#online-ready').click({timeout:25_000});
  await second.locator('#online-ready').click({timeout:25_000});
  await first.locator('#online-start').click();
  await Promise.all([first,second].map(page=>page.locator('#online-hud').waitFor({timeout:15_000})));
}
try {
  const health=await fetch(endpoint+'/api/health');
  assert.equal(health.status,200);
  assert.ok((await health.json()).gameVersion);
  const mismatch=await fetch(endpoint+'/api/create',{
    method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},
    body:JSON.stringify({gameVersion:'obsolete-test-build'}),
  });
  assert.equal(mismatch.status,409);
  const a=await open('Apex Driver');
  const b=await open('Alpine Driver');
  await a.locator('#online-create').click();
  await a.locator('#online-code').filter({hasText:/^[A-Z2-9]{4}-[A-Z2-9]{4}$/}).waitFor();
  await b.locator('#online-code-input').fill(await a.locator('#online-code').textContent());
  await b.locator('#online-join button').click();
  await b.locator('#online-vehicle').selectOption('r35');
  await b.locator('#stage[data-vehicle=r35]').waitFor({timeout:35_000});
  await a.locator('#online-drivers').filter({hasText:'Nissan GT-R R35'}).waitFor();
  await a.screenshot({path:join(output,'lobby.jpg'),quality:91,mask:[a.locator('#online-code')],maskColor:'#25313a'});
  await start(a,b);
  await a.locator('#online-clock').filter({hasText:'On track'}).waitFor({timeout:12_000});
  await b.keyboard.down('w');
  await b.waitForFunction(()=>Number(document.querySelector('#speed').textContent)>32,null,{timeout:15_000});
  await b.keyboard.up('w');
  await a.screenshot({path:join(output,'free-drive-chase.jpg'),quality:91});
  await a.locator('[data-camera=cockpit]').click();
  await a.screenshot({path:join(output,'free-drive-cockpit.jpg'),quality:91});
  await delay(24_000);
  await a.locator('#online-end').click();
  await b.locator('#online-room').waitFor();
  await a.locator('#online-mode').selectOption('challenge');
  await b.waitForFunction(()=>document.querySelector('#online-mode').value==='challenge');
  await start(a,b);
  await a.locator('#online-clock').filter({hasText:/9:5\d remaining/}).waitFor({timeout:12_000});
  await a.screenshot({path:join(output,'challenge.jpg'),quality:91});
  await b.locator('#online-track-leave').click();
  await a.locator('#online-track-leave').click();
  assert.deepEqual(errors,[]);
  assert.ok(measurements.every(row=>row.sent>250&&row.received>250&&row.rtt.length>8));
} finally {
  const data=measurements.map(({rtt,intervals,...record})=>({
    ...record,rttSamples:rtt.length,rttMedianMs:percentile(rtt,.5),rttP95Ms:percentile(rtt,.95),
    intervalMedianMs:percentile(intervals,.5),intervalP95Ms:percentile(intervals,.95),
    longDeliveryGaps:intervals.filter(n=>n>200).length,
  }));
  await writeFile(join(output,'metrics.json'),JSON.stringify({data,errors},null,2)+'\n');
  console.log(JSON.stringify({data,errors}));
  await browser.close();
}
