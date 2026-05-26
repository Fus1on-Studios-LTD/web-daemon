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
    return {
      id,
      name: String(name).trim(),
      runtime: 'node',
      image: 'node:18-alpine',
      internalPort: 3000,
      hostPort,
      env: { NODE_ENV: 'production', SITE_NAME: String(name).trim() },
      cmd: ['node', '-e', "require('http').createServer((req, res) => res.end('Hello from ' + process.env.SITE_NAME + '\\n')).listen(3000)"]
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

  sites.push(site);
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

const port = process.env.PORT || 3008;
app.listen(port, () => console.log(`Daemon listening on ${port}`));
