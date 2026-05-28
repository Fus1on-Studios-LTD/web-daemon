const fs = require('fs');
const path = require('path');

class EventStore {
  constructor(filepath) {
    this.filepath = filepath;
    this.events = [];
    this.loadSync();
  }

  loadSync() {
    try {
      if (fs.existsSync(this.filepath)) {
        const data = fs.readFileSync(this.filepath, 'utf8');
        this.events = data.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
      }
    } catch (e) {
      console.error('EventStore loadSync failed', e.message);
      this.events = [];
    }
  }

  append(event) {
    const e = {
      timestamp: new Date().toISOString(),
      ...event
    };
    this.events.push(e);
    try {
      fs.appendFileSync(this.filepath, JSON.stringify(e) + '\n', 'utf8');
    } catch (err) {
      console.error('EventStore append failed', err.message);
    }
    return e;
  }

  query(filters = {}) {
    let result = [...this.events];
    if (filters.siteId) result = result.filter(e => e.siteId === filters.siteId);
    if (filters.action) result = result.filter(e => e.action === filters.action);
    if (filters.since) result = result.filter(e => new Date(e.timestamp) > new Date(filters.since));
    if (filters.limit) result = result.slice(-filters.limit);
    return result;
  }
}

module.exports = EventStore;
