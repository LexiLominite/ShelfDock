'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const shell = fs.readFileSync(path.join(__dirname, '../installers/bootstrap.sh'), 'utf8');
const python = shell.split("<<'PY'\n")[1].split('\nPY\n')[0];
const definitions = python.split("if __name__ == '__main__':")[0];
const fixture = String.raw`
import io
scenario = sys.argv[1]
version, arch = '0.7.0', 'arm64' if scenario == 'valid-arm64' else 'x64'
root = 'ShelfDock-0.7.0-linux-' + arch
with tempfile.TemporaryDirectory(prefix='bootstrap-test-') as temporary:
    folder = pathlib.Path(temporary)
    archive = folder / (root + '.tar.gz')
    package = json.dumps({'name': 'shelfdock', 'productName': 'ShelfDock', 'version': '0.7.1' if scenario == 'identity' else version}).encode()
    header_json = json.dumps({'files': {'package.json': {'size': len(package), 'offset': '0'}}}).encode()
    header_size = len(header_json) + 8
    asar = struct.pack('<IIII', 4, header_size, header_size-4, len(header_json)) + header_json + package
    elf = bytearray(64)
    elf[:6] = b'\x7fELF\x02\x01'
    struct.pack_into('<H', elf, 18, 183 if scenario == 'architecture' or arch == 'arm64' else 62)
    with tarfile.open(archive, 'w:gz', format=tarfile.USTAR_FORMAT) as tar:
        def add(name, data, mode=0o644):
            item = tarfile.TarInfo(name); item.size = len(data); item.mode = mode
            tar.addfile(item, io.BytesIO(data))
        add(root + '/ShelfDock', elf, 0o755)
        add(root + '/resources/app.asar', asar)
        if scenario == 'traversal': add(root + '/../escaped', b'x')
        if scenario == 'duplicate': add(root + '/ShelfDock', elf)
        if scenario == 'personal': add(root + '/resources/personal-config.json', b'{}')
        if scenario == 'symlink':
            item = tarfile.TarInfo(root + '/link'); item.type = tarfile.SYMTYPE; item.linkname = 'ShelfDock'; tar.addfile(item)
        if scenario == 'ancestor': add(root + '/ShelfDock/child', b'x')
    if scenario in ('valid', 'valid-arm64', 'identity', 'architecture', 'traversal', 'duplicate', 'personal', 'symlink', 'ancestor'):
        validate_package(archive, folder, version, arch)
    else:
        # End-to-end isolated network transport and installer fixture; all paths are temporary.
        installer = folder / 'install.sh'
        installer.write_text('#!/bin/sh\nset -eu\n[ "$1:$2:$5:$6" = "ShelfDock:public:0.7.0:x64" ]\nprintf done > "$BOOTSTRAP_TEST_MARKER"\n')
        manifest = folder / 'SHA256SUMS.txt'
        lines = [hash_file(archive) + '  ' + archive.name, hash_file(installer) + '  install.sh']
        if scenario == 'checksum': lines[0] = '0'*64 + '  ' + archive.name
        if scenario == 'manifest-duplicate': lines.append(lines[0])
        if scenario == 'manifest-missing': lines.pop()
        if scenario == 'installer-checksum': lines[1] = '0'*64 + '  install.sh'
        manifest.write_text('\n'.join(lines) + '\n')
        fakebin = folder / 'bin'; fakebin.mkdir()
        curl = fakebin / 'curl'
        curl.write_text('#!/usr/bin/env python3\nimport os,pathlib,sys\nurl=sys.argv[-1]\nassert url.startswith("https://github.com/LexiLominite/ShelfDock/releases/download/v0.7.0/")\nsys.stdout.buffer.write((pathlib.Path(os.environ["BOOTSTRAP_TEST_ASSETS"])/url.rsplit("/",1)[-1]).read_bytes())\n')
        curl.chmod(0o700)
        original_which = shutil.which
        shutil.which = lambda name: (None if name == 'curl' else str(curl) if name == 'wget' else original_which(name)) if scenario == 'wget-end-to-end' else str(curl) if name == 'curl' else original_which(name)
        os.environ['BOOTSTRAP_TEST_ASSETS'] = str(folder)
        os.environ['BOOTSTRAP_TEST_MARKER'] = str(folder / 'called')
        os.uname = lambda: type('Uname', (), {'sysname':'Linux','machine':'x86_64'})()
        sys.argv = ['bootstrap', version]
        try:
            main()
        except Exception:
            require(not (folder/'called').exists(), 'Installer called before verification.')
            raise
        require((folder/'called').read_text() == 'done', 'Installer not called.')
`;
for (const scenario of ['valid','valid-arm64','identity','architecture','traversal','duplicate','personal','symlink','ancestor','end-to-end','wget-end-to-end','checksum','manifest-duplicate','manifest-missing','installer-checksum']) {
  test(`Linux bootstrap synthetic ${scenario}`, () => {
    const result = spawnSync('python3', ['-c', definitions + '\n' + fixture, scenario], { encoding:'utf8', timeout:15000 });
    assert.ifError(result.error);
    if (['valid','valid-arm64','end-to-end','wget-end-to-end'].includes(scenario)) assert.equal(result.status,0,result.stderr);
    else {
      assert.notEqual(result.status,0);
      assert.match(result.stderr,/ValueError:/);
    }
  });
}
test('bounded downloader rejects overflow without executing an installer', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-download-test-'));
  try {
    const code = definitions + String.raw`
folder = pathlib.Path(sys.argv[1])
fake = folder/'curl'
fake.write_text('#!/bin/sh\nprintf 123456789\n')
fake.chmod(0o700)
shutil.which = lambda name: str(fake) if name == 'curl' else None
download('https://github.com/LexiLominite/ShelfDock/releases/download/v0.7.0/test', folder/'result', 4)
`;
    const result = spawnSync('python3',['-c',code,directory],{ encoding:'utf8',timeout:5000 });
    assert.ifError(result.error);
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/Download exceeds size limit/);
  } finally { fs.rmSync(directory,{recursive:true,force:true}); }
});
test('Windows bootstrap has bounded download and verification before installer dispatch (source coverage)', () => {
  const source = fs.readFileSync(path.join(__dirname,'../installers/bootstrap.ps1'),'utf8');
  for (const expression of [/AllowAutoRedirect = \$false/,/UseDefaultCredentials = \$false/,/SetAccessRuleProtection\(\$true,\$false\)/,/\$total -gt \$Limit/,/\$redirects -ge 5/,/FileVersionInfo/,/0x014c,0x8664/,/-ceq \$name/,/Duplicate checksum manifest entry/,/ProductName -ne 'ShelfDock'/,/Remove-Item -LiteralPath \$temporary/]) assert.match(source,expression);
  assert.ok(source.indexOf('Validate-Portable (Join-Path') < source.indexOf("& (Join-Path $temporary 'install.ps1')"));
  assert.doesNotMatch(source,/Start-Process|Invoke-Expression|LexBridge-private|Authorization/);
});
