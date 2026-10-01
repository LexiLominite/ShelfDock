import contextlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import install_macos as installer
import mac_actions

class LaunchFixture:
    def __init__(self):
        self.active = False
        self.calls = []
        self.fail_bootstrap = False
    def __call__(self, argv, **kwargs):
        argv = [str(x) for x in argv]
        self.calls.append(argv)
        status = 0
        if argv[0] == 'launchctl':
            if argv[1] == 'print':
                status = 0 if self.active else 113
            elif argv[1] == 'bootout':
                status = 0 if self.active else 113
                self.active = False
            elif argv[1] == 'bootstrap':
                if self.fail_bootstrap:
                    self.fail_bootstrap = False
                    status = 5
                else:
                    self.active = True
        if kwargs.get('check') and status:
            raise subprocess.CalledProcessError(status, argv)
        return subprocess.CompletedProcess(argv, status)

class MacToolsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='lexbridge-installer-fixture-')
        self.home = Path(self.temp.name).resolve()
        self.fixture = LaunchFixture()
        self.patches = [
            patch.object(installer, 'HOME', self.home),
            patch.object(installer, 'RUNTIME', self.home / '.config/lexbridge-mobile'),
            patch.object(installer, 'INSTALL', self.home / 'Library/Application Support/LexBridge Mobile'),
            patch.object(installer, 'PLIST', self.home / 'Library/LaunchAgents' / (installer.LABEL + '.plist')),
            patch.object(installer.sys, 'platform', 'darwin'),
            patch.object(installer.shutil, 'which', return_value='/usr/bin/node'),
            patch.object(installer.subprocess, 'check_output', return_value='22\n'),
            patch.object(installer.subprocess, 'run', side_effect=self.fixture),
        ]
        for p in self.patches:
            p.start()
    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        self.temp.cleanup()
    def install(self):
        with contextlib.redirect_stdout(io.StringIO()):
            installer.install()
    def test_install_stages_separate_bundle_private_record_and_wrapper(self):
        self.install()
        record = installer.load_record()
        self.assertTrue(self.fixture.active)
        self.assertEqual(installer.record_path().stat().st_mode & 0o777, 0o600)
        self.assertEqual(installer.RUNTIME.stat().st_mode & 0o777, 0o700)
        self.assertTrue((installer.INSTALL / 'current').is_symlink())
        self.assertTrue((Path(record['bundle']) / 'desktop/received.cjs').is_file())
        self.assertTrue((Path(record['bundle']) / 'mobile/integrations/mcp_server.py').is_file())
        self.assertFalse((Path(record['bundle']) / 'mobile/agent.json').exists())
        self.assertIn('"$@"', Path(record['wrapper']).read_text())
    def test_upgrade_bootstrap_failure_restores_every_prior_owned_file_and_service(self):
        self.install()
        current = installer.INSTALL / 'current'
        before_target = current.readlink()
        before = {path: path.read_bytes() for path in [installer.PLIST, installer.record_path(), self.home / '.local/bin/lexbridge-mobile', self.home / 'Applications/LexBridge Phone Tools/Send Files to Phone.command']}
        self.fixture.fail_bootstrap = True
        with self.assertRaises(subprocess.CalledProcessError):
            self.install()
        self.assertTrue(self.fixture.active)
        self.assertEqual(current.readlink(), before_target)
        for path, contents in before.items():
            self.assertEqual(path.read_bytes(), contents)
        self.assertEqual(len(list((installer.RUNTIME / 'backups').glob('*/manifest.json'))), 2)
    def test_first_bootstrap_failure_removes_new_control_files_preserves_staging(self):
        self.fixture.fail_bootstrap = True
        with self.assertRaises(subprocess.CalledProcessError):
            self.install()
        self.assertFalse(self.fixture.active)
        self.assertFalse(installer.PLIST.exists())
        self.assertFalse(installer.record_path().exists())
        self.assertFalse((installer.INSTALL / 'current').exists())
        self.assertTrue(list(installer.INSTALL.glob('0.1.0-*')))
    def test_failure_after_switch_restores_link_and_shortcuts(self):
        self.install()
        current = installer.INSTALL / 'current'
        before = current.readlink()
        write = installer.atomic_write
        fired = False
        def fail_once(path, data, mode=0o600):
            nonlocal fired
            if path == self.home / '.local/bin/lexbridge-mobile' and not fired:
                fired = True
                raise OSError('synthetic wrapper write failure')
            return write(path, data, mode)
        with patch.object(installer, 'atomic_write', side_effect=fail_once):
            with self.assertRaises(OSError):
                self.install()
        self.assertTrue(self.fixture.active)
        self.assertEqual(current.readlink(), before)
        self.assertEqual(installer.load_record()['bundle'], str(current.resolve()))
    def test_unowned_wrapper_collision_and_record_symlink_do_not_stop_service(self):
        wrapper = self.home / '.local/bin/lexbridge-mobile'
        wrapper.parent.mkdir(parents=True)
        wrapper.write_text('user-owned command')
        with self.assertRaises(ValueError):
            self.install()
        self.assertEqual(wrapper.read_text(), 'user-owned command')
        self.assertFalse(any(a[:2] == ['launchctl', 'bootout'] for a in self.fixture.calls))
        wrapper.unlink()
        installer.private_dir(installer.RUNTIME)
        target = installer.RUNTIME / 'other.json'
        target.write_text('{}')
        installer.record_path().symlink_to(target)
        with self.assertRaises(ValueError):
            self.install()
    def test_stop_is_reversible_idempotent_and_disabled_collision_preserves_running(self):
        self.install()
        disabled = installer.PLIST.with_suffix('.plist.disabled')
        disabled.write_text('preserved user file')
        with self.assertRaises(ValueError):
            installer.stop()
        self.assertTrue(self.fixture.active)
        disabled.unlink()
        with contextlib.redirect_stdout(io.StringIO()):
            installer.stop()
            installer.stop()
        self.assertFalse(self.fixture.active)
        self.assertTrue(disabled.is_file())
        self.assertTrue(installer.record_path().is_file())
    def test_stop_reinstall_stop_preserves_disabled_backup_and_remains_stoppable(self):
        self.install()
        with contextlib.redirect_stdout(io.StringIO()):
            installer.stop()
        disabled = installer.PLIST.with_suffix('.plist.disabled')
        old_contents = disabled.read_bytes()
        self.install()
        self.assertTrue(self.fixture.active)
        self.assertFalse(disabled.exists())
        manifest = json.loads((Path(installer.load_record()['backup']) / 'manifest.json').read_text())
        saved = next(row for row in manifest['files'] if row['path'] == str(disabled))
        self.assertEqual(Path(saved['backup']).read_bytes(), old_contents)
        with contextlib.redirect_stdout(io.StringIO()):
            installer.stop()
        self.assertFalse(self.fixture.active)
        self.assertTrue(disabled.is_file())
    def test_stopped_upgrade_failure_restores_owned_disabled_plist(self):
        self.install()
        with contextlib.redirect_stdout(io.StringIO()):
            installer.stop()
        disabled = installer.PLIST.with_suffix('.plist.disabled')
        old_contents = disabled.read_bytes()
        old_record = installer.record_path().read_bytes()
        self.fixture.fail_bootstrap = True
        with self.assertRaises(subprocess.CalledProcessError):
            self.install()
        self.assertFalse(self.fixture.active)
        self.assertFalse(installer.PLIST.exists())
        self.assertEqual(disabled.read_bytes(), old_contents)
        self.assertEqual(installer.record_path().read_bytes(), old_record)
    def test_shortcut_file_json_preserves_spaces_unicode_quotes_and_rejects_newline(self):
        names = ['Résumé report.pdf', 'quote"and space.txt']
        files = []
        for name in names:
            file = self.home / name
            file.write_text('fixture')
            files.append(str(file))
        self.assertEqual(mac_actions.selected_files(json.dumps(files)), files)
        bad = self.home / 'a\nb.txt'
        bad.write_text('fixture')
        with self.assertRaises(ValueError):
            mac_actions.selected_files(json.dumps([str(bad)]))
        with self.assertRaises(ValueError):
            mac_actions.selected_files('"not a list"')
        link = self.home / 'link.txt'
        link.symlink_to(files[0])
        with self.assertRaises(ValueError):
            mac_actions.selected_files(json.dumps([str(link)]))
    def test_all_selected_paths_validated_before_send_and_unknown_action_rejected(self):
        good = self.home / 'good.txt'
        good.write_text('fixture')
        with self.assertRaises(ValueError):
            mac_actions.selected_files(json.dumps([str(good), str(self.home / 'missing.txt')]))
        with patch.object(mac_actions.sys, 'argv', ['mac_actions.py', 'unknown']):
            with self.assertRaises(ValueError):
                mac_actions.main()
        self.assertEqual(self.fixture.calls, [])

if __name__ == '__main__':
    unittest.main()
