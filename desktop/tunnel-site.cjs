'use strict';
const { endpointKey } = require('./password-auth.cjs');

function assertTunnelSiteEndpoint(record, host) {
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

module.exports = { tunnelSiteURL, assertTunnelSiteEndpoint };
