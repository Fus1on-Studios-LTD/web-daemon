const http = require('http');

class HealthMonitor {
  constructor(sites, containerForSite, eventStore) {
    this.sites = sites;
    this.containerForSite = containerForSite;
    this.eventStore = eventStore;
    this.healthStatus = {}; // siteId -> { status, failCount, lastCheck }
    this.autoRecoverIntervals = {}; // siteId -> interval id
  }

  async checkSiteHealth(site) {
    const siteId = site.id;
    if (!this.healthStatus[siteId]) {
      this.healthStatus[siteId] = { status: 'unknown', failCount: 0, lastCheck: null };
    }

    const status = this.healthStatus[siteId];
    status.lastCheck = new Date().toISOString();

    try {
      const { container, info } = await this.containerForSite(site);
      if (!container || !info) {
        status.status = 'absent';
        return;
      }

      if (!info.State.Running) {
        status.status = 'stopped';
        return;
      }

      // Try HTTP health check
      const isHealthy = await this.httpHealthCheck(site);
      if (isHealthy) {
        status.status = 'healthy';
        status.failCount = 0;
      } else {
        status.failCount++;
        status.status = status.failCount > 2 ? 'unhealthy' : 'degraded';
      }
    } catch (e) {
      status.failCount++;
      status.status = 'error';
      console.error(`Health check failed for ${siteId}:`, e.message);
    }
  }

  httpHealthCheck(site) {
    return new Promise(resolve => {
      const req = http.get(`http://localhost:${site.hostPort}/`, { timeout: 2000 }, res => {
        resolve(res.statusCode >= 200 && res.statusCode < 500);
        res.resume();
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
  }

  getStatus(siteId) {
    return this.healthStatus[siteId] || { status: 'unknown', failCount: 0, lastCheck: null };
  }

  getAllStatus() {
    return this.healthStatus;
  }

  start() {
    setInterval(async () => {
      for (const site of this.sites) {
        await this.checkSiteHealth(site);
      }
    }, 30000); // Check every 30 seconds
  }

  // Called when a site recovers or enters unhealthy state
  onStatusChange(siteId, oldStatus, newStatus) {
    if (this.eventStore) {
      this.eventStore.append({
        siteId,
        action: 'health_changed',
        from: oldStatus,
        to: newStatus
      });
    }
  }
}

module.exports = HealthMonitor;
