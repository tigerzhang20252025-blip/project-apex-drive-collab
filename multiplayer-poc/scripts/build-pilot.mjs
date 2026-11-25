import { spawnSync } from 'node:child_process';
import { cp, mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const relay = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const game = resolve(relay, '..');
const assets = join(relay, '.cloudflare/output/v1/workers/default/assets');
const destination = join(assets, 'play');
const env = {...process.env, VITE_MULTIPLAYER_URL: ''};

function run(command, args, cwd, processEnv = process.env) {
  const result = spawnSync(command, args, {cwd, env:processEnv, stdio:'inherit'});
  if (result.status !== 0) throw new Error(command + ' failed', {cause:result.error});
}

run('npm', ['run','build'], game, env);
run(join(relay,'node_modules/.bin/cf'), ['build'], relay);

let count=0, bytes=0;
for (const file of await readdir(join(game,'dist'), {recursive:true, withFileTypes:true})) {
  if (!file.isFile()) continue;
  const { size } = await stat(join(file.parentPath,file.name));
  if (size > 25*1024*1024) throw new Error(file.name + ' exceeds the Workers asset size limit');
  count++;
  bytes+=size;
}
await mkdir(destination, {recursive:true});
await cp(join(game,'dist'),destination,{recursive:true});
console.log('Prepared /play with',count,'static files and',bytes,'bytes.');
