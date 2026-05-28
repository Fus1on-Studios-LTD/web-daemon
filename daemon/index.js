const fs = require('fs');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const Docker = require('dockerode');
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

const EventStore = require('./event-store');
const HealthMonitor = require('./health-monitor');
const ResourceTracker = require('./resource-tracker');

const NGINX_CONFIG_DIR = process.env.NGINX_CONFIG_DIR || '/deploy/nginx';
const NGINX_CONTAINER_NAME = process.env.NGINX_CONTAINER_NAME || 'reverse';
const SITE_STORAGE_DIR = process.env.SITE_STORAGE_DIR || '/srv/web-hosting/sites';
const SITE_REGISTRY_PATH = path.join(SITE_STORAGE_DIR, 'sites.json');
const BACKUPS_DIR = path.join(SITE_STORAGE_DIR, 'backups');
const EVENTS_PATH = path.join(SITE_STORAGE_DIR, 'events.log');
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
    cmd: ['node', '-e', "require('http').createServer((req, res) => res.end('Hello from example-node\\n')).listen(3000)"],
    aliases: [],
    quotas: { cpu: 2, memory: 512, disk: 1024 },
    backups: []
  },
  {
    id: 'site-php',
    name: 'example-php',
    runtime: 'php',
    image: 'php:8.2-apache',
    internalPort: 80,
    hostPort: 4002,
    aliases: [],
    quotas: { cpu: 2, memory: 512, disk: 2048 },
    backups: []
  },
  {
    id: 'site-static',
    name: 'example-static',
    runtime: 'static',
    image: 'nginx:stable-alpine',
    internalPort: 80,
    hostPort: 4003,
    aliases: [],
    quotas: { cpu: 1, memory: 256, disk: 512 },
    backups: []
  }
];

let sites = [];
const eventStore = new EventStore(EVENTS_PATH);
let healthMonitor;
let resourceTracker;

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
  await fs.promises.mkdir(BACKUPS_DIR, { recursive: true });

  healthMonitor = new HealthMonitor(sites, containerForSite, eventStore);
  resourceTracker = new ResourceTracker(sites, containerForSite);

  healthMonitor.start();
  resourceTracker.start();

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

app.get('/sites/:id/stats', async (req, res) => {
  const s = sites.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  try {
    const { container, info } = await containerForSite(s);
    if (!info) return res.json({ status: 'absent' });
    return res.json({
      status: info.State.Running ? 'running' : 'stopped',
      containerId: info.Id,
      startedAt: info.State.StartedAt,
      pid: info.State.Pid
    });
  } catch (e) {
    console.error('stats error', e && e.message);
    return res.status(500).json({ error: e.message });
  }
});

app.get('/sites/:id/logs', async (req, res) => {
  const s = sites.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const tail = parseInt(req.query.tail || '200', 10) || 200;
  try {
    const { container, info } = await containerForSite(s);
    if (!container || !info) return res.status(404).json({ error: 'no_container' });
    container.logs({ stdout: true, stderr: true, tail }, (err, data) => {
      if (err) {
        console.error('logs error', err && err.message);
        return res.status(500).json({ error: err.message });
      }
      res.set('Content-Type', 'text/plain');
      res.send((data || '').toString());
    });
  } catch (e) {
    console.error('logs error', e && e.message);
    return res.status(500).json({ error: e.message });
  }
});

// Health & Metrics endpoints
app.get('/sites/:id/health', (req, res) => {
  const s = sites.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const health = healthMonitor.getStatus(s.id);
  return res.json(health);
});

app.get('/health', (req, res) => {
  const allHealth = healthMonitor.getAllStatus();
  return res.json(allHealth);
});

app.get('/sites/:id/metrics', (req, res) => {
  const s = sites.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const metrics = resourceTracker.getMetrics(s.id);
  return res.json(metrics);
});

app.get('/metrics', (req, res) => {
  const allMetrics = resourceTracker.getAllMetrics();
  return res.json(allMetrics);
});

// Event log endpoint
app.get('/events', (req, res) => {
  const events = eventStore.query({
    limit: req.query.limit ? parseInt(req.query.limit, 10) : 100
  });
  res.json(events);
});

app.get('/sites/:id/events', (req, res) => {
  const s = sites.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const events = eventStore.query({
    siteId: s.id,
    limit: req.query.limit ? parseInt(req.query.limit, 10) : 50
  });
  res.json(events);
});

// Backup & restore endpoints
app.post('/sites/:id/backup', async (req, res) => {
  const s = sites.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  if (!s.volumes || !s.volumes.length) return res.status(400).json({ error: 'no_volumes' });

  const backupId = `backup-${Date.now()}`;
  const hostPath = s.volumes[0].split(':')[0];
  const backupPath = path.join(BACKUPS_DIR, s.id, backupId);

  try {
    await fs.promises.mkdir(backupPath, { recursive: true });
    const child_process = require('child_process');
    // Simple copy for Windows/Unix compatibility
    await new Promise((resolve, reject) => {
      const cp = child_process.exec(`cp -r "${hostPath}" "${backupPath}/data"`, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });

    if (!s.backups) s.backups = [];
    s.backups.push({ id: backupId, timestamp: new Date().toISOString(), path: backupPath });
    await saveSiteRegistry();

    eventStore.append({ siteId: s.id, action: 'backup_created', backupId });
    return res.status(201).json({ backupId, timestamp: new Date().toISOString() });
  } catch (e) {
    console.error('backup failed', e.message);
    return res.status(500).json({ error: 'backup_failed', message: e.message });
  }
});

app.get('/sites/:id/backups', (req, res) => {
  const s = sites.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  res.json(s.backups || []);
});

app.post('/sites/:id/restore/:backupId', async (req, res) => {
  const s = sites.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });

  const backup = s.backups && s.backups.find(b => b.id === req.params.backupId);
  if (!backup) return res.status(404).json({ error: 'backup_not_found' });

  const hostPath = s.volumes[0].split(':')[0];
  const backupDataPath = path.join(backup.path, 'data');

  try {
    await fs.promises.rm(hostPath, { recursive: true, force: true });
    const child_process = require('child_process');
    await new Promise((resolve, reject) => {
      const cp = child_process.exec(`cp -r "${backupDataPath}" "${hostPath}"`, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });

    eventStore.append({ siteId: s.id, action: 'restore_completed', backupId: req.params.backupId });
    return res.json({ status: 'restored' });
  } catch (e) {
    console.error('restore failed', e.message);
    return res.status(500).json({ error: 'restore_failed', message: e.message });
  }
});

// DNS aliases endpoint
app.post('/sites/:id/alias', async (req, res) => {
  const s = sites.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const { alias } = req.body || {};
  if (!alias) return res.status(400).json({ error: 'alias_required' });

  if (!s.aliases) s.aliases = [];
  if (!s.aliases.includes(alias)) {
    s.aliases.push(alias);
    await saveSiteRegistry();
    eventStore.append({ siteId: s.id, action: 'alias_added', alias });
  }
  res.json({ aliases: s.aliases });
});

app.delete('/sites/:id/alias/:alias', async (req, res) => {
  const s = sites.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  if (!s.aliases) s.aliases = [];

  s.aliases = s.aliases.filter(a => a !== req.params.alias);
  await saveSiteRegistry();
  eventStore.append({ siteId: s.id, action: 'alias_removed', alias: req.params.alias });
  res.json({ aliases: s.aliases });
});

// Site environment variables endpoint
app.put('/sites/:id/env', async (req, res) => {
  const s = sites.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const { env } = req.body || {};
  if (!env || typeof env !== 'object') return res.status(400).json({ error: 'env_must_be_object' });

  s.env = { ...s.env, ...env };
  await saveSiteRegistry();
  eventStore.append({ siteId: s.id, action: 'env_updated', keys: Object.keys(env) });
  res.json({ env: s.env });
});

// Resource quotas endpoint
app.put('/sites/:id/quotas', async (req, res) => {
  const s = sites.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const { quotas } = req.body || {};
  if (!quotas) return res.status(400).json({ error: 'quotas_required' });

  s.quotas = { ...s.quotas, ...quotas };
  await saveSiteRegistry();
  eventStore.append({ siteId: s.id, action: 'quotas_updated', quotas: s.quotas });
  res.json({ quotas: s.quotas });
});

// Delete site (with backup)
app.delete('/sites/:id', async (req, res) => {
  const idx = sites.findIndex(x => x.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'not found' });

  const s = sites[idx];
  try {
    const { container } = await containerForSite(s);
    if (container) {
      await container.stop().catch(() => {});
      await container.remove().catch(() => {});
    }
    sites.splice(idx, 1);
    await saveSiteRegistry();
    await writeSiteMap();
    eventStore.append({ siteId: s.id, action: 'site_deleted' });
    return res.json({ status: 'deleted' });
  } catch (e) {
    console.error('delete failed', e.message);
    return res.status(500).json({ error: 'delete_failed', message: e.message });
  }
});
