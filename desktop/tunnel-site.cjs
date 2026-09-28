'use strict';
const http = require('node:http');
const https = require('node:https');
const { endpointKey } = require('./password-auth.cjs');

function assertTunnelSiteEndpoint(record, host) {
  if (record?.stopped) throw new Error('This local forward is not running. Connect it before opening the site.');
  if (!record || !host || record.view.hostId !== host.id || record.endpoint !== endpointKey(host)) {
    throw new Error('This machine’s connection details changed or it was removed. Stop this forward, then reconnect using the current machine settings.');
  }
}

// The renderer supplies a session identity and a page path, never an external
// address. Only a live local forward can name the browser's loopback port.
function tunnelSiteURL(request, state) {
  if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).some(key => !['id', 'scheme', 'path'].includes(key))) {
    throw new Error('Choose a running local forward to open its site.');
  }
  if (typeof request.id !== 'string' || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(request.id)) {
    throw new Error('Choose a running local forward to open its site.');
  }
  if (!['http:', 'https:'].includes(request.scheme)) throw new Error('Sites must use HTTP or HTTPS.');
  const page = request.path;
  if (typeof page !== 'string' || page.length > 4096 || !page.startsWith('/') || page.startsWith('//') || /[\\\x00-\x1f\x7f]/.test(page) || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(page)) {
    throw new Error('Use a page path beginning with one /, without backslashes or control characters.');
  }
  const tunnel = state?.active?.find(entry => entry.id === request.id);
  if (!tunnel || tunnel.mode !== 'local' || tunnel.status !== 'running') {
    throw new Error('This local forward is not running. Connect it before opening the site.');
  }
  if (!Number.isInteger(tunnel.listenPort) || tunnel.listenPort < 1 || tunnel.listenPort > 65535) {
    throw new Error('This forward has an invalid listening port. Reconnect it before opening the site.');
  }
  const base = new URL(`${request.scheme}//127.0.0.1:${tunnel.listenPort}/`);
  const url = new URL(page, base);
  if (url.origin !== base.origin || url.username || url.password) throw new Error('The page must stay on this local forward.');
  return url.href;
}

// Probe through the owned loopback tunnel; never resolve or contact the supplied
// remote destination from this machine. HEAD reads headers only and does not
// follow redirects or load page resources. Any HTTP status proves reachability.
function verifyTunnelSite(url, record, { timeout = 6000, requestHttp = http.request, requestHttps = https.request } = {}) {
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol) || target.hostname !== '127.0.0.1' || target.username || target.password) return Promise.reject(new Error('Website checks must use this local forward.'));
  const destination = `${record?.view?.targetHost || 'the destination'}:${record?.view?.targetPort || 'port'}`;
  const machine = record?.view?.hostName || 'the selected machine';
  return new Promise((resolve, reject) => {
    let settled = false; let request;
    const finish = error => {
      if (settled) return;
      settled = true; clearTimeout(timer); request?.destroy(); error ? reject(error) : resolve();
    };
    const timer = setTimeout(() => finish(new Error(`The website at ${destination} did not respond through ${machine}. Check that the service is running there and that the URL uses the correct port and HTTP or HTTPS.`)), timeout);
    const fail = error => {
      const certificate = /CERT|TLS|SSL|SELF_SIGNED/i.test(error?.code || '');
      finish(new Error(certificate ? `The HTTPS certificate could not be verified through the local address. Check the service certificate or use the HTTP address provided by ${machine}.` : `The website at ${destination} could not be reached from ${machine}. Start the service on that machine and check its address, port, and HTTP or HTTPS setting.`));
    };
    try {
      request = (target.protocol === 'https:' ? requestHttps : requestHttp)(target, { method: 'HEAD', agent: false, headers: { Connection: 'close' } }, response => {
        response.on('error', fail);
        if (!Number.isInteger(response.statusCode) || response.statusCode < 100 || response.statusCode > 599) { response.destroy(); fail(); return; }
        response.destroy(); finish();
      });
      request.on('error', fail); request.end();
    } catch (error) { fail(error); }
  });
}

module.exports = { tunnelSiteURL, assertTunnelSiteEndpoint, verifyTunnelSite };
