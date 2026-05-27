const fs = require('fs');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const Docker = require('dockerode');
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

const NGINX_CONFIG_DIR = process.env.NGINX_CONFIG_DIR || '/deploy/nginx';
const NGINX_CONTAINER_NAME = process.env.NGINX_CONTAINER_NAME || 'reverse';
const SITE_STORAGE_DIR = process.env.SITE_STORAGE_DIR || '/srv/web-hosting/sites';
const SITE_REGISTRY_PATH = path.join(SITE_STORAGE_DIR, 'sites.json');
const siteMapPath = path.join(NGINX_CONFIG_DIR, 'site-map.conf');

const app = express();
app.use(bodyParser.json());

const DEFAULT_SITES = [
  {
    id: 'site-node',
    name: 'example-node',
    runtime: 'node',
    image: 'node:18-alpine',
    internalPort: 3000,
    hostPort: 4001,
    env: { NODE_ENV: 'production' },
    cmd: ['node', '-e', "require('http').createServer((req, res) => res.end('Hello from example-node\\n')).listen(3000)"]
  },
  {
    id: 'site-php',
    name: 'example-php',
    runtime: 'php',
    image: 'php:8.2-apache',
    internalPort: 80,
    hostPort: 4002
  },
  {
    id: 'site-static',
    name: 'example-static',
    runtime: 'static',
    image: 'nginx:stable-alpine',
    internalPort: 80,
    hostPort: 4003
  }
];

let sites = [];

async function loadSiteRegistry() {
  try {
    const raw = await fs.promises.readFile(SITE_REGISTRY_PATH, 'utf8');
    sites = JSON.parse(raw);
    if (!Array.isArray(sites)) throw new Error('site registry missing array');
  } catch (e) {
    sites = DEFAULT_SITES.slice();
  }
}

async function saveSiteRegistry() {
  await fs.promises.mkdir(SITE_STORAGE_DIR, { recursive: true });
  await fs.promises.writeFile(SITE_REGISTRY_PATH, JSON.stringify(sites, null, 2), 'utf8');
}

function isValidBindSpec(bind) {
  if (typeof bind !== 'string') return false;
  const parts = bind.split(':');
  if (parts.length < 2) return false;
  const [hostPath, containerPath] = parts;
  if (!hostPath || !containerPath) return false;
  if (!path.isAbsolute(hostPath) || !path.isAbsolute(containerPath)) return false;
  return true;
}

function normalizeBindSpecs(volumes) {
  if (!Array.isArray(volumes)) return [];
  return volumes.filter(isValidBindSpec);
}

async function createSiteSourceFiles(site) {
  if (!site.volumes || !site.volumes.length) return;
  const hostPath = site.volumes[0].split(':')[0];
  await fs.promises.mkdir(hostPath, { recursive: true });

  if (site.runtime === 'node') {
    const pkgPath = path.join(hostPath, 'package.json');
    const indexPath = path.join(hostPath, 'index.js');
    if (!fs.existsSync(pkgPath)) {
      await fs.promises.writeFile(pkgPath, JSON.stringify({
        name: site.id,
        version: '0.1.0',
        main: 'index.js',
        scripts: { start: 'node index.js' }
      }, null, 2), 'utf8');
    }
    if (!fs.existsSync(indexPath)) {
      await fs.promises.writeFile(indexPath,
        `const http = require('http');\nhttp.createServer((req, res) => {\n  res.writeHead(200, { 'Content-Type': 'text/plain' });\n  res.end('Hello from ${site.name}!\\n');\n}).listen(3000);\n`, 'utf8');
    }
    return;
  }

  if (site.runtime === 'php') {
    const indexPath = path.join(hostPath, 'index.php');
    if (!fs.existsSync(indexPath)) {
      await fs.promises.writeFile(indexPath,
        `<?php\n echo '<h1>Hello from ${site.name}!</h1>';\n`, 'utf8');
    }
    return;
  }

  if (site.runtime === 'static') {
    const indexPath = path.join(hostPath, 'index.html');
    if (!fs.existsSync(indexPath)) {
      await fs.promises.writeFile(indexPath,
        `<!doctype html>\n<html><head><meta charset="utf-8"><title>${site.name}</title></head><body><h1>Hello from ${site.name}!</h1></body></html>`, 'utf8');
    }
    return;
  }
}

function nextHostPort() {
  const name = `site_${site.id}`;
  try {
    const container = docker.getContainer(name);
    const info = await container.inspect();
    return { container, info };
  } catch (e) {
    return { container: null, info: null };
  }
}

function isValidBindSpec(bind) {
  if (typeof bind !== 'string') return false;
  const parts = bind.split(':');
  if (parts.length < 2) return false;
  const [hostPath, containerPath] = parts;
  if (!hostPath || !containerPath) return false;
  if (!path.isAbsolute(hostPath) || !path.isAbsolute(containerPath)) return false;
  return true;
}

function normalizeBindSpecs(volumes) {
  if (!Array.isArray(volumes)) return [];
  return volumes.filter(isValidBindSpec);
}

function nextHostPort() {
  const used = new Set(sites.map(s => Number(s.hostPort)).filter(n => Number.isInteger(n)));
  let port = 4001;
  while (used.has(port)) port += 1;
  return port;
}

function createSiteConfig(name, runtime) {
  const normalized = String(runtime || '').trim().toLowerCase();
  const id = String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^[-]+|[-]+$/g, '');
  if (!id) return null;

  const hostPort = nextHostPort();
  if (normalized === 'node') {
    const hostPath = path.join(SITE_STORAGE_DIR, id);
    return {
      id,
      name: String(name).trim(),
      runtime: 'node',
      image: 'node:18-alpine',
      internalPort: 3000,
      hostPort,
      volumes: [`${hostPath}:/usr/src/app`],
      env: { NODE_ENV: 'production', SITE_NAME: String(name).trim() },
      cmd: ['sh', '-c', 'cd /usr/src/app && npm install && npm start']
    };
  }

  if (normalized === 'php') {
    const hostPath = path.join(SITE_STORAGE_DIR, id);
    return {
      id,
      name: String(name).trim(),
      runtime: 'php',
      image: 'php:8.2-apache',
      internalPort: 80,
      hostPort,
      volumes: [`${hostPath}:/var/www/html`]
    };
  }

  if (normalized === 'static') {
    const hostPath = path.join(SITE_STORAGE_DIR, id);
    return {
      id,
      name: String(name).trim(),
      runtime: 'static',
      image: 'nginx:stable-alpine',
      internalPort: 80,
      hostPort,
      volumes: [`${hostPath}:/usr/share/nginx/html`]
    };
  }

  if (normalized === 'php') {
    return {
      id,
      name: String(name).trim(),
      runtime: 'php',
      image: 'php:8.2-apache',
      internalPort: 80,
      hostPort
    };
  }

  if (normalized === 'static') {
    return {
      id,
      name: String(name).trim(),
      runtime: 'static',
      image: 'nginx:stable-alpine',
      internalPort: 80,
      hostPort
    };
  }

  return null;
}

async function ensureImage(image) {
  try {
    await docker.getImage(image).inspect();
    return;
  } catch (e) {
    console.log(`Image ${image} not found locally, pulling...`);
  }

  const stream = await docker.pull(image);
  await new Promise((resolve, reject) => {
    docker.modem.followProgress(stream, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
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

async function init() {
  await loadSiteRegistry();
  await writeSiteMap();
  const port = process.env.PORT || 3008;
  app.listen(port, () => console.log(`Daemon listening on ${port}`));
}

init().catch(err => console.error('init failed', err));

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

app.post('/sites', async (req, res) => {
  const { name, runtime } = req.body || {};
  if (!name || !runtime) {
    return res.status(400).json({ error: 'invalid_payload', required: ['name', 'runtime'] });
  }

  const id = String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^[-]+|[-]+$/g, '');
  if (!id) {
    return res.status(400).json({ error: 'invalid_name' });
  }
  if (sites.some(site => site.id === id)) {
    return res.status(409).json({ error: 'site_exists', id });
  }

  const site = createSiteConfig(name, runtime);
  if (!site) {
    return res.status(400).json({ error: 'invalid_runtime', allowed: ['node', 'php', 'static'] });
  }

  await createSiteSourceFiles(site);
  sites.push(site);
  await saveSiteRegistry();
  await writeSiteMap();
  return res.status(201).json({ site, status: 'absent' });
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
    const bindMounts = normalizeBindSpecs(s.volumes);
    const createOpts = {
      name,
      Image: s.image,
      ExposedPorts: {
        [`${s.internalPort}/tcp`]: {}
      },
      HostConfig: {
        RestartPolicy: { Name: 'always' },
        PortBindings: {
          [`${s.internalPort}/tcp`]: [{ HostPort: String(s.hostPort) }]
        }
      },
      Env: env
    };

    if (bindMounts.length) {
      createOpts.HostConfig.Binds = bindMounts;
    }

    if (s.cmd) {
      createOpts.Cmd = s.cmd;
    }
    if (s.runtime === 'node' && Array.isArray(s.volumes) && s.volumes.length > 0) {
      createOpts.WorkingDir = '/usr/src/app';
    }

    if (s.volumes && Array.isArray(s.volumes) && s.volumes.length > 0 && !bindMounts.length) {
      return res.status(400).json({ error: 'invalid_volume_specs', message: 'One or more volume mounts are invalid. Use absolute host and container paths.' });
    }

    if (!s.image) {
      return res.status(500).json({ error: 'missing_image', message: 'Site configuration has no image' });
    }

    try {
      await ensureImage(s.image);
    } catch (imageError) {
      console.error('image pull failed', imageError);
      return res.status(500).json({ error: 'image_pull_failed', message: imageError.message });
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
