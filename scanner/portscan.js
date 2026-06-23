// OSIRIS scanner — bounded TCP-connect port scanning.
//
// Pure logic, depends only on node:net (no express), so it's importable directly by the
// test suite without installing the backend's production deps. server.js consumes it.

const net = require('node:net');

// Curated common ports (~120) used by the QUICK tier and for service-name labelling.
const COMMON_PORTS = {
  21: 'ftp', 22: 'ssh', 23: 'telnet', 25: 'smtp', 53: 'dns', 80: 'http',
  81: 'http-alt', 88: 'kerberos', 110: 'pop3', 111: 'rpcbind', 135: 'msrpc',
  139: 'netbios-ssn', 143: 'imap', 161: 'snmp', 389: 'ldap', 443: 'https',
  445: 'smb', 465: 'smtps', 514: 'syslog', 515: 'printer', 587: 'submission',
  631: 'ipp', 636: 'ldaps', 873: 'rsync', 990: 'ftps', 993: 'imaps',
  995: 'pop3s', 1025: 'msrpc', 1080: 'socks', 1194: 'openvpn', 1433: 'mssql',
  1521: 'oracle', 1723: 'pptp', 1883: 'mqtt', 2049: 'nfs', 2082: 'cpanel',
  2083: 'cpanel-ssl', 2086: 'whm', 2087: 'whm-ssl', 2095: 'webmail',
  2096: 'webmail-ssl', 2181: 'zookeeper', 2375: 'docker', 2376: 'docker-ssl',
  3000: 'node', 3128: 'squid', 3306: 'mysql', 3389: 'rdp', 3478: 'stun',
  4444: 'metasploit', 5000: 'upnp', 5432: 'postgres', 5601: 'kibana',
  5672: 'amqp', 5900: 'vnc', 5985: 'winrm', 5986: 'winrm-ssl', 6379: 'redis',
  6443: 'kubernetes', 7001: 'weblogic', 7077: 'spark', 8000: 'http-alt',
  8008: 'http-alt', 8080: 'http-proxy', 8081: 'http-alt', 8086: 'influxdb',
  8088: 'http-alt', 8443: 'https-alt', 8888: 'http-alt', 9000: 'php-fpm',
  9092: 'kafka', 9200: 'elasticsearch', 9300: 'elasticsearch', 9418: 'git',
  9999: 'http-alt', 10000: 'webmin', 11211: 'memcached', 15672: 'rabbitmq',
  27017: 'mongodb', 27018: 'mongodb', 5984: 'couchdb', 8200: 'vault',
  9090: 'prometheus', 3001: 'http-alt', 4040: 'spark-ui', 50070: 'hadoop',
};

const PORT_CONNECT_TIMEOUT = 1500;
const PORT_SCAN_CONCURRENCY = 100;

// Port-set profiles for the three scan tiers:
//  - quick: the ~120 curated COMMON_PORTS (fast triage; the default below).
//  - ports: all well-known/system ports (1-1024) ∪ the curated high service ports —
//           ~1070 ports, the practical "top 1000".
//  - deep:  the full 1-65535 TCP range (thorough; bounded by an overall deadline).
function buildTopPorts() {
  const set = new Set();
  for (let p = 1; p <= 1024; p++) set.add(p);
  for (const p of Object.keys(COMMON_PORTS)) set.add(Number(p));
  return [...set].sort((a, b) => a - b);
}

function buildAllPorts() {
  const ports = new Array(65535);
  for (let p = 1; p <= 65535; p++) ports[p - 1] = p;
  return ports;
}

function probePort(ip, port, timeout = PORT_CONNECT_TIMEOUT) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (open) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(open);
    };
    sock.setTimeout(timeout);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, ip);
  });
}

// Bounded TCP-connect scan over an arbitrary port list. `deadlineMs` caps the total
// wall-clock (deep scans of the full range can be slow); on expiry it stops dispatching
// and returns what it found with `truncated: true`. Closed (RST) and filtered (timeout)
// ports don't establish a connection, so they don't accumulate TIME_WAIT — high
// concurrency is safe for scanning even tens of thousands of ports.
async function portScan(ip, ports = Object.keys(COMMON_PORTS).map(Number), opts = {}) {
  const {
    concurrency = PORT_SCAN_CONCURRENCY,
    timeout = PORT_CONNECT_TIMEOUT,
    deadlineMs = 0,
  } = opts;
  const deadline = deadlineMs ? Date.now() + deadlineMs : 0;
  const open = [];
  let idx = 0;
  let scanned = 0;
  let truncated = false;
  async function worker() {
    while (idx < ports.length) {
      if (deadline && Date.now() > deadline) { truncated = true; return; }
      const port = ports[idx++];
      scanned++;
      if (await probePort(ip, port, timeout)) {
        open.push({ port, state: 'open', service: COMMON_PORTS[port] || 'unknown' });
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, ports.length) }, worker),
  );
  open.sort((a, b) => a.port - b.port);
  return { open, truncated, scanned };
}

module.exports = {
  COMMON_PORTS,
  PORT_CONNECT_TIMEOUT,
  PORT_SCAN_CONCURRENCY,
  buildTopPorts,
  buildAllPorts,
  probePort,
  portScan,
};
