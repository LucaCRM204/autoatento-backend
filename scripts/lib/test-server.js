/** Helpers de los smokes: levantar el server en un puerto libre y esperar a que responda. */
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const axios = require('axios');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function puertoLibre() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

/** Devuelve { child, base, logs, stop() }. envExtra pisa variables del .env. */
async function levantarServer(envExtra = {}) {
  const port = await puertoLibre();
  const logs = [];
  const child = spawn(process.execPath, [path.join(__dirname, '..', '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), TENANT_CACHE_TTL_MS: '500', NODE_ENV: 'development', ...envExtra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => logs.push(d.toString()));
  child.stderr.on('data', (d) => logs.push(d.toString()));
  const base = `http://127.0.0.1:${port}`;
  const stop = () => new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    child.kill();
  });
  for (let i = 0; i < 60; i++) {
    try {
      await axios.get(`${base}/api/health`, { timeout: 1000 });
      return { child, base, logs, stop };
    } catch {
      await sleep(500);
    }
  }
  await stop();
  throw new Error(`El server no levantó:\n${logs.join('')}`);
}

module.exports = { levantarServer, puertoLibre, sleep };
