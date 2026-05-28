const os = require('os');

class ResourceTracker {
  constructor(sites, containerForSite) {
    this.sites = sites;
    this.containerForSite = containerForSite;
    this.metrics = {}; // siteId -> { cpu, memory, disk, timestamp }
  }

  async collectMetrics(site) {
    const siteId = site.id;
    try {
      const { container, info } = await this.containerForSite(site);
      if (!container || !info) {
        this.metrics[siteId] = {
          cpu: 0,
          memory: 0,
          disk: 0,
          timestamp: new Date().toISOString(),
          status: 'absent'
        };
        return;
      }

      let cpu = 0, memory = 0;
      if (info.State.Running) {
        // Estimate from container config (simple approach)
        memory = info.HostConfig?.Memory ? (info.HostConfig.Memory / 1024 / 1024) : 0;
        // CPU shares to percentage (container default is 1024 shares = 100%)
        const shares = info.HostConfig?.CpuShares || 1024;
        cpu = (shares / 1024) * 100;
      }

      let disk = 0;
      if (site.volumes && site.volumes.length > 0) {
        const hostPath = site.volumes[0].split(':')[0];
        try {
          const stat = require('child_process').execSync(`powershell -Command "Get-Item '${hostPath}' | Get-ChildItem -Recurse | Measure-Object -Property Length -Sum | Select-Object -ExpandProperty Sum"`, { encoding: 'utf8' });
          disk = parseInt(stat.trim(), 10) || 0;
          disk = disk / 1024 / 1024; // Convert to MB
        } catch (e) {
          disk = 0; // Skip on Windows or error
        }
      }

      this.metrics[siteId] = {
        cpu: parseFloat(cpu.toFixed(2)),
        memory: parseFloat(memory.toFixed(2)),
        disk: parseFloat(disk.toFixed(2)),
        timestamp: new Date().toISOString(),
        status: info.State.Running ? 'running' : 'stopped'
      };
    } catch (e) {
      console.error(`Metrics collection failed for ${siteId}:`, e.message);
      this.metrics[siteId] = { cpu: 0, memory: 0, disk: 0, timestamp: new Date().toISOString(), error: e.message };
    }
  }

  async collectAllMetrics() {
    for (const site of this.sites) {
      await this.collectMetrics(site);
    }
  }

  getMetrics(siteId) {
    return this.metrics[siteId] || { cpu: 0, memory: 0, disk: 0, timestamp: null, status: 'unknown' };
  }

  getAllMetrics() {
    return this.metrics;
  }

  start() {
    this.collectAllMetrics();
    setInterval(() => this.collectAllMetrics(), 60000); // Collect every 60 seconds
  }
}

module.exports = ResourceTracker;
