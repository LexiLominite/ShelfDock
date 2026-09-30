#!/bin/sh
# Save and review this file, then run: sh bootstrap.sh [0.7.4]
set -eu
umask 077
[ "$#" -le 1 ] || { echo 'Usage: sh bootstrap.sh [version]' >&2; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo 'Python 3 (standard library) is required; no runtime is installed automatically.' >&2; exit 2; }
exec python3 - "${1:-0.7.4}" <<'PY'
import gzip, hashlib, json, os, pathlib, re, select, shutil, signal, struct, subprocess, sys, tarfile, tempfile, time

def require(ok, message):
    if not ok: raise ValueError(message)

def download(url, destination, limit):
    curl, wget = shutil.which('curl'), shutil.which('wget')
    require(curl or wget, 'curl or wget is required.')
    args = ([curl, '--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--proto-redir', '=https', '--max-redirs', '5', '--connect-timeout', '20', '--max-time', '600', '--max-filesize', str(limit), url] if curl else
            [wget, '--quiet', '--https-only', '--max-redirect=5', '--timeout=20', '--tries=1', '-O', '-', url])
    proc = subprocess.Popen(args, stdout=subprocess.PIPE)
    try:
        deadline, size = time.monotonic() + 600, 0
        with destination.open('xb') as out:
            while True:
                require(time.monotonic() < deadline, 'Download deadline exceeded.')
                if not select.select([proc.stdout], [], [], 1)[0]: continue
                chunk = os.read(proc.stdout.fileno(), 65536)
                if not chunk: break
                size += len(chunk)
                require(size <= limit, 'Download exceeds size limit.')
                out.write(chunk)
        require(proc.wait(timeout=5) == 0 and size > 0, 'Download failed or was empty.')
    finally:
        if proc.poll() is None: proc.kill()
        proc.wait()
        proc.stdout.close()

def checksums(manifest, names):
    found = {}
    for line in manifest.read_text('utf-8').splitlines():
        match = re.fullmatch(r'([a-fA-F0-9]{64}) [ *]([^\s/\\]+)', line)
        require(match is not None, 'Invalid checksum manifest line.')
        digest, name = match.groups()
        require(name not in found, 'Duplicate checksum manifest entry.')
        found[name] = digest.lower()
    require(all(name in found for name in names), 'Missing exact checksum entry.')
    return found

def hash_file(file):
    digest = hashlib.sha256()
    with file.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''): digest.update(chunk)
    return digest.hexdigest()

def validate_package(archive, directory, version, arch):
    # Bound gzip expansion before parsing TAR metadata (including PAX headers).
    raw = directory / 'validated.tar'
    with gzip.open(archive, 'rb') as source, raw.open('xb') as out:
        total = 0
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            total += len(chunk)
            require(total <= 3 * 1024**3, 'Expanded archive exceeds size limit.')
            out.write(chunk)
    root = 'ShelfDock-' + version + '-linux-' + arch
    entries, pending, expanded = {}, {}, 0
    with raw.open('rb') as source:
        while True:
            header = source.read(512)
            require(len(header) == 512, 'Truncated TAR archive.')
            if header == bytes(512):
                require(source.read(512) == bytes(512), 'Missing TAR end marker.')
                for chunk in iter(lambda: source.read(1024 * 1024), b''):
                    require(not any(chunk), 'Unexpected data after TAR end.')
                break
            item = tarfile.TarInfo.frombuf(header, 'utf-8', 'strict')
            start = source.tell()
            require(0 <= item.size <= 1024**3 and start + item.size <= total, 'Invalid TAR size.')
            if item.type in (b'x', b'L'):
                require(item.size <= 16384, 'Oversized TAR metadata.')
                meta = source.read(item.size)
                if item.type == b'L': pending['path'] = meta.rstrip(b'\0').decode('utf-8')
                else:
                    at = 0
                    while at < len(meta):
                        space = meta.find(b' ', at)
                        require(space > at and meta[at:space].isdigit(), 'Invalid PAX metadata.')
                        length = int(meta[at:space])
                        require(length > space-at+1 and at+length <= len(meta) and meta[at+length-1] == 10, 'Invalid PAX length.')
                        key, value = meta[space+1:at+length-1].decode('utf-8').split('=', 1)
                        require(key not in pending and not key.startswith('GNU.sparse'), 'Ambiguous TAR metadata.')
                        pending[key] = value
                        at += length
            else:
                require(item.type in (b'0', b'\0', b'5'), 'Links and special archive files are forbidden.')
                require('size' not in pending or pending['size'] == str(item.size), 'Ambiguous TAR size.')
                name = pending.get('path', item.name).rstrip('/')
                pending = {}
                require(0 < len(name) <= 2048 and not re.search(r'[\\\x00-\x1f\x7f:]', name) and all(p not in ('', '.', '..') for p in name.split('/')), 'Unsafe archive path.')
                require(name == root or name.startswith(root + '/'), 'Unexpected archive root.')
                require(name.lower() not in entries, 'Duplicate archive path.')
                entries[name.lower()] = (item.isdir(), start, item.size, item.mode)
                expanded += item.size
                require(len(entries) <= 40000 and expanded <= 3 * 1024**3, 'Archive exceeds limits.')
            source.seek(start + ((item.size + 511)//512)*512)
        require(not pending, 'Incomplete TAR metadata.')
        for name in entries:
            parent = pathlib.PurePosixPath(name).parent
            while str(parent) != '.':
                require(str(parent) not in entries or entries[str(parent)][0], 'Archive path crosses a file.')
                parent = parent.parent
        def read_entry(name, offset, size):
            entry = entries.get((root + '/' + name).lower())
            require(entry and not entry[0] and offset >= 0 and offset + size <= entry[2], 'Missing or truncated identity file.')
            source.seek(entry[1] + offset)
            return source.read(size)
        elf = read_entry('ShelfDock', 0, 20)
        require(elf[:6] == b'\x7fELF\x02\x01' and struct.unpack_from('<H', elf, 18)[0] == (62 if arch == 'x64' else 183), 'Executable architecture mismatch.')
        require(entries[(root + '/ShelfDock').lower()][3] & 0o111, 'Executable permission missing.')
        first = read_entry('resources/app.asar', 0, 16)
        header_size, json_size = struct.unpack_from('<I', first, 4)[0], struct.unpack_from('<I', first, 12)[0]
        require(2 <= json_size <= header_size <= 32 * 1024**2, 'Invalid ASAR header.')
        header = json.loads(read_entry('resources/app.asar', 16, json_size))
        package = header.get('files', {}).get('package.json', {})
        size, offset = package.get('size'), package.get('offset')
        require(not package.get('unpacked') and not package.get('link') and isinstance(size, int) and 0 < size <= 128*1024 and isinstance(offset, str) and re.fullmatch(r'[0-9]{1,16}', offset), 'Invalid ASAR package metadata.')
        identity = json.loads(read_entry('resources/app.asar', 8 + header_size + int(offset), size))
        require(identity.get('name') == 'shelfdock' and identity.get('productName') == 'ShelfDock' and identity.get('version') == version, 'Application identity mismatch.')
        require((root+'/resources/personal-config.json').lower() not in entries, 'Public package contains personal configuration.')

def main():
    version = sys.argv[1]
    require(re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?', version) is not None, 'Invalid version.')
    require(os.uname().sysname == 'Linux', 'This bootstrap supports Linux only.')
    arch = {'x86_64':'x64', 'amd64':'x64', 'aarch64':'arm64', 'arm64':'arm64'}.get(os.uname().machine)
    require(arch is not None, 'Unsupported Linux architecture.')
    base = 'https://github.com/LexiLominite/ShelfDock/releases/download/v' + version + '/'
    payload = 'ShelfDock-' + version + '-linux-' + arch + '.tar.gz'
    with tempfile.TemporaryDirectory(prefix='shelfdock-bootstrap-') as temporary:
        directory = pathlib.Path(temporary)
        os.chmod(directory, 0o700)
        for name, limit in [('SHA256SUMS.txt',128*1024), ('install.sh',256*1024), (payload,1500*1024**2)]:
            download(base + name, directory / name, limit)
        listed = checksums(directory/'SHA256SUMS.txt', ['install.sh', payload])
        for name in ['install.sh', payload]: require(hash_file(directory/name) == listed[name], 'SHA-256 mismatch: '+name)
        validate_package(directory/payload, directory, version, arch)
        subprocess.run(['/bin/sh', str(directory/'install.sh'), 'ShelfDock', 'public', payload, listed[payload], version, arch], check=True, cwd=directory)

if __name__ == '__main__':
    def interrupted(_number, _frame): raise RuntimeError('Installation interrupted.')
    for number in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM): signal.signal(number, interrupted)
    try: main()
    except Exception as error:
        print('ShelfDock bootstrap failed: ' + str(error), file=sys.stderr)
        sys.exit(1)
PY
