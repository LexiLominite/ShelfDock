'use strict';
const { desktopExec } = require('./remote-desktop-ssh.cjs');
const shellQuote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
const LINUX_INSPECT = `set -eu
printf 'provider=linux-x11\\n'
if [ -r /etc/os-release ]; then . /etc/os-release; printf 'distribution=%s\\n' "$ID"; fi
if command -v x11vnc >/dev/null 2>&1; then printf 'installed=yes\\n'; else printf 'installed=no\\n'; fi
if [ "$(id -u)" = 0 ] || sudo -n true >/dev/null 2>&1; then printf 'elevated=yes\\n'; else printf 'elevated=no\\n'; fi
for session in $(loginctl list-sessions --no-legend 2>/dev/null | awk '{print $1}'); do
 active=$(loginctl show-session "$session" -p Active --value); type=$(loginctl show-session "$session" -p Type --value)
 if [ "$active" = yes ] && { [ "$type" = x11 ] || [ "$type" = wayland ]; }; then
  printf 'type=%s\\n' "$type"
  loginctl show-session "$session" -p Display --value | sed 's/^/display=/'
  uid=$(loginctl show-session "$session" -p User --value)
  for pid in $(pgrep -u "$uid" -x gnome-shell 2>/dev/null || true) $(pgrep -u "$uid" -x xfce4-session 2>/dev/null || true) $(pgrep -u "$uid" -x mate-session 2>/dev/null || true); do
   if [ -r "/proc/$pid/environ" ]; then tr '\\000' '\\n' < "/proc/$pid/environ" | while IFS= read -r entry; do case "$entry" in XAUTHORITY=*) auth=\${entry#XAUTHORITY=}; if [ -r "$auth" ]; then printf 'auth=%s\\n' "$auth"; fi;; DISPLAY=*) printf 'display=%s\\n' "\${entry#DISPLAY=}";; esac; done; fi
  done
  break
 fi
done`;
function pairs(output) { const result = {}; for (const line of String(output).split(/\r?\n/)) { const i = line.indexOf('='); if (i > 0) result[line.slice(0, i)] = line.slice(i + 1); } return result; }
const providers = {
  'linux-x11': {
    async inspect(service, host) {
      const facts = pairs((await desktopExec(service, host, LINUX_INSPECT)).stdout);
      const available = ['ubuntu', 'debian'].includes(facts.distribution) && facts.type === 'x11' && /^:\d+(\.\d+)?$/.test(facts.display || '') && !!facts.auth && !/[\r\n\0]/.test(facts.auth);
      return { provider: 'linux-x11', available, installed: facts.installed === 'yes', canInstall: facts.elevated === 'yes', facts, reason: available ? 'Share the active X11 desktop with a temporary loopback x11vnc server.' : 'An active Ubuntu/Debian X11 desktop and readable display authentication are required. Wayland and virtual desktops are unavailable.' };
    },
    preview(info) { return { available: info.available && (info.installed || info.canInstall), changes: [...(!info.installed ? ['Install the distribution x11vnc package using existing non-interactive administrator access.'] : []), 'Start a temporary VNC server for the existing active desktop, bound to loopback with a temporary private password file.', 'Disconnect stops only this server and removes its temporary password file.'], reason: info.reason }; },
    async apply(service, host, plan, credentials) {
      const password = credentials?.password;
      if (typeof password !== 'string' || password.length < 6 || password.length > 8 || /[^\x21-\x7e]/.test(password)) throw new Error('Use a temporary VNC password of 6 to 8 printable characters. VNC authentication uses at most 8 characters.');
      const fresh = await this.inspect(service, host);
      if (!fresh.available || fresh.facts.display !== plan.info.facts.display || fresh.facts.auth !== plan.info.facts.auth) throw new Error('The active desktop changed. Inspect it and review a new setup plan.');
      const directory = '/tmp/shelfdock-vnc-' + plan.owner;
      const script = `set -eu; umask 077
${!fresh.installed ? 'if [ "$(id -u)" = 0 ]; then apt-get -y install x11vnc >/dev/null; else sudo -n apt-get -y install x11vnc >/dev/null; fi' : ''}
mkdir ${shellQuote(directory)}
IFS= read -r password
printf '%s\\n' "$password" > ${shellQuote(directory + '/password')}
unset password
( trap 'rm -f ${directory}/password ${directory}/pid ${directory}/output; rmdir ${directory} 2>/dev/null || true' EXIT
 x11vnc -localhost -listen 127.0.0.1 -rfbport ${plan.port} -display ${shellQuote(fresh.facts.display)} -auth ${shellQuote(fresh.facts.auth)} -passwdfile ${shellQuote(directory + '/password')} -forever -shared -noxdamage -nosel -noprimary -noclipboard > ${shellQuote(directory + '/output')} 2>&1 &
 pid=$!; printf '%s\\n' "$pid" > ${shellQuote(directory + '/pid')}; trap 'kill "$pid" 2>/dev/null || true' HUP INT TERM; wait "$pid"
) < /dev/null > /dev/null 2>&1 &
sleep 1
test -s ${shellQuote(directory + '/pid')}
kill -0 "$(cat ${shellQuote(directory + '/pid')})"
printf 'started=yes\\n'`;
      try { await desktopExec(service, host, script, { stdin: password + '\n', timeout: 120000, signal: plan.signal }); }
      catch { await this.stop(service, host, plan).catch(() => {}); throw new Error('The temporary X11 VNC server could not start. Review display permissions and the selected port.'); }
      return { provider: 'linux-x11', owner: plan.owner, port: plan.port };
    },
    async stop(service, host, owned) {
      if (!/^[a-f0-9-]{36}$/.test(owned.owner)) throw new Error('Invalid desktop session ownership.');
      const directory = '/tmp/shelfdock-vnc-' + owned.owner;
      // Match the unique password-file argument before signalling a PID, which may have been reused.
      await desktopExec(service, host, `if [ -f ${directory}/pid ]; then pid=$(cat ${directory}/pid); case "$pid" in ''|*[!0-9]*) exit 1;; esac; if [ -r "/proc/$pid/cmdline" ] && tr '\\000' '\\n' < "/proc/$pid/cmdline" | grep -qxF ${shellQuote(directory + '/password')}; then kill "$pid"; fi; fi; rm -f ${directory}/password ${directory}/pid ${directory}/output; rmdir ${directory} 2>/dev/null || true`);
    },
  },
  'mac-screen-sharing': {
    async inspect(service, host) { const result = await desktopExec(service, host, 'if /usr/sbin/lsof -nP -iTCP:5900 -sTCP:LISTEN >/dev/null 2>&1; then printf "installed=yes\\n"; else printf "installed=no\\n"; fi'); const installed = pairs(result.stdout).installed === 'yes'; return { provider: 'mac-screen-sharing', available: installed, installed, reason: installed ? 'Connect to existing Screen Sharing. The Mac may request a username and password.' : 'Enable Screen Sharing on the Mac in System Settings. ShelfDock connects to an existing Screen Sharing server; enable it locally in System Settings before connecting.' }; },
    preview(info) { return { available: false, changes: [], reason: info.reason }; },
  },
  'windows-tightvnc': {
    async inspect(service, host) { const script = `$ErrorActionPreference='Stop'; if (Get-Service tvnserver -ErrorAction SilentlyContinue) { 'installed=yes' } else { 'installed=no' }`; const command = 'powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from(script, 'utf16le').toString('base64'); const installed = pairs((await desktopExec(service, host, command)).stdout).installed === 'yes'; return { provider: 'windows-tightvnc', available: installed, installed, provisioningAvailable: false, reason: installed ? 'Connect to an existing TightVNC desktop server. Automatic provisioning remains unavailable until its native security validation passes.' : 'TightVNC 2.8.88 provisioning is unavailable: installer properties, signature and secret-safe native installation have not passed validation.' }; },
    preview(info) { return { available: false, changes: ['Install the pinned TightVNC 2.8.88 server with Windows Installer handle properties supplied through SSH stdin.', 'Disable accepting connections, HTTP and firewall additions before configuring loopback and authentication; verify native state before accepting connections.'], reason: info.reason }; },
  },
};
async function providerFor(host, service) {
  if (host.os === 'windows') return 'windows-tightvnc';
  const result = await desktopExec(service, host, 'uname -s');
  const kernel = String(result.stdout).trim();
  if (kernel === 'Darwin') return 'mac-screen-sharing';
  if (kernel === 'Linux') return 'linux-x11';
  throw new Error('This remote operating system does not have a supported desktop provider.');
}
module.exports = { providers, providerFor, LINUX_INSPECT, pairs };
