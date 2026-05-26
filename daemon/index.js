const fs = require('fs');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const Docker = require('dockerode');
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

const NGINX_CONFIG_DIR = process.env.NGINX_CONFIG_DIR || '/deploy/nginx';
const NGINX_CONTAINER_NAME = process.env.NGINX_CONTAINER_NAME || 'reverse';
const siteMapPath = path.join(NGINX_CONFIG_DIR, 'site-map.conf');

const app = express();
app.use(bodyParser.json());

// Example site registry with real host port and volume mappings.
// In production, persist this registry to a database or config store.
const sites = [
  {
    id: 'site-node',
    name: 'example-node',
    runtime: 'node',
    image: 'node:18-alpine',
    internalPort: 3000,
    hostPort: 4001,
    volumes: ['/srv/web-hosting/sites/example-node:/usr/src/app'],
    env: { NODE_ENV: 'production' },
    cmd: ['sh', '-c', 'cd /usr/src/app && npm install && npm start']
  },
  {
    id: 'site-php',
    name: 'example-php',
    runtime: 'php',
    image: 'php:8.2-apache',
    internalPort: 80,
    hostPort: 4002,
    volumes: ['/srv/web-hosting/sites/example-php:/var/www/html']
  },
  {
    id: 'site-static',
    name: 'example-static',
    runtime: 'static',
    image: 'nginx:stable-alpine',
    internalPort: 80,
    hostPort: 4003,
    volumes: ['/srv/web-hosting/sites/example-static:/usr/share/nginx/html']
  }
];

async function containerForSite(site) {
  const name = `site_${site.id}`;
  try {
    const container = docker.getContainer(name);
    const info = await container.inspect();
    return { container, info };
  } catch (e) {
    return { container: null, info: null };
  }
}

function generateSiteMap() {
  const pairs = sites.map(site => `  ${site.id} ${site.hostPort};`).join('\n');
  return `map $site_id $site_port {\n  default 0;\n${pairs}\n}\n`;
}

async function writeSiteMap() {
  const content = generateSiteMap();
  await fs.promises.mkdir(NGINX_CONFIG_DIR, { recursive: true });
  await fs.promises.writeFile(siteMapPath, content, 'utf8');
}

async function reloadNginx() {
  try {
    const container = docker.getContainer(NGINX_CONTAINER_NAME);
    const exec = await container.exec({
      Cmd: ['nginx', '-s', 'reload'],
      AttachStdout: true,
      AttachStderr: true
    });
    const stream = await exec.start();
    await new Promise((resolve, reject) => {
      stream.on('end', resolve);
      stream.on('error', reject);
    });
    return true;
  } catch (e) {
    console.error('reload nginx failed', e);
    return false;
  }
}

writeSiteMap().catch(err => console.error('site map init failed', err));

app.get('/status', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.get('/sites', async (req, res) => {
  const results = await Promise.all(sites.map(async s => {
    const { info } = await containerForSite(s);
    const running = info ? info.State.Running : false;
    return {
      ...s,
      status: info ? (running ? 'running' : 'stopped') : 'absent',
      containerId: info ? info.Id : null,
      exposedUrl: `http://localhost:${s.hostPort}`,
      proxyUrl: `https://web-daemon.fus1on.host/site/${s.id}/`
    };
  }));
  res.json(results);
});

app.post('/sites/:id/start', async (req, res) => {
  const s = sites.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const name = `site_${s.id}`;
  try {
    const { container, info } = await containerForSite(s);
    if (container && info) {
      if (info.State.Running) return res.json({ status: 'running' });
      await container.start();
      return res.json({ status: 'started' });
    }

    const env = Object.entries(s.env || {}).map(([key, value]) => `${key}=${value}`);
    const createOpts = {
      name,
      Image: s.image,
      ExposedPorts: {
        [`${s.internalPort}/tcp`]: {}
      },
      HostConfig: {
        RestartPolicy: { Name: 'always' },
        Binds: s.volumes || [],
        PortBindings: {
          [`${s.internalPort}/tcp`]: [{ HostPort: String(s.hostPort) }]
        }
      },
      Env: env
    };

    if (s.cmd) {
      createOpts.Cmd = s.cmd;
    }
    if (s.runtime === 'node') {
      createOpts.WorkingDir = '/usr/src/app';
    }

    const created = await docker.createContainer(createOpts);
    await created.start();
    await writeSiteMap();
    await reloadNginx();
    return res.json({ status: 'created_and_started', exposedUrl: `http://localhost:${s.hostPort}` });
  } catch (e) {
    console.error('start error', e && e.message);
    return res.status(500).json({ error: e.message });
  }
});

app.post('/sites/:id/stop', async (req, res) => {
  const s = sites.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  try {
    const { container, info } = await containerForSite(s);
    if (!container || !info) return res.json({ status: 'absent' });
    if (!info.State.Running) return res.json({ status: 'stopped' });
    await container.stop();
    await writeSiteMap();
    await reloadNginx();
    return res.json({ status: 'stopped' });
  } catch (e) {
    console.error('stop error', e && e.message);
    return res.status(500).json({ error: e.message });
  }
});

app.post('/sites/:id/reload', async (req, res) => {
  const s = sites.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  try {
    await writeSiteMap();
    const success = await reloadNginx();
    if (!success) return res.status(500).json({ error: 'nginx_reload_failed' });
    return res.json({ status: 'reloaded' });
  } catch (e) {
    console.error('reload error', e && e.message);
    return res.status(500).json({ error: e.message });
  }
});

const port = process.env.PORT || 3008;
app.listen(port, () => console.log(`Daemon listening on ${port}`));
