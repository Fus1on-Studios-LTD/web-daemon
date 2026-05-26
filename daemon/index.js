const express = require('express');
const bodyParser = require('body-parser');
const Docker = require('dockerode');
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

const app = express();
app.use(bodyParser.json());

// Example site registry - in production this should be persisted
const sites = [
  { id: 'site-1', name: 'example-node', status: 'unknown', runtime: 'node', image: 'node:18-alpine' },
  { id: 'site-2', name: 'example-static', status: 'unknown', runtime: 'static', image: 'nginx:stable-alpine' }
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

app.get('/status', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.get('/sites', async (req, res) => {
  const results = await Promise.all(sites.map(async s => {
    const { info } = await containerForSite(s);
    return { ...s, status: info ? (info.State.Running ? 'running' : 'stopped') : 'absent' };
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

    // Create a simple container for the site
    const createOpts = {
      name,
      Image: s.image,
      HostConfig: { RestartPolicy: { Name: 'always' } }
    };

    // For node apps, assume the app will handle its own ports; this prototype does not map app ports.
    const created = await docker.createContainer(createOpts);
    await created.start();
    return res.json({ status: 'created_and_started' });
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
    return res.json({ status: 'stopped' });
  } catch (e) {
    console.error('stop error', e && e.message);
    return res.status(500).json({ error: e.message });
  }
});

const port = process.env.PORT || 3008;
app.listen(port, () => console.log(`Daemon listening on ${port}`));
