#!/usr/bin/env python3
"""Install the optional personal phone bridge without replacing the desktop app."""
import argparse
import datetime
import json
import os
from pathlib import Path
import plistlib
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
import uuid

LABEL = "com.lexilominite.lexbridge.mobile"
HOME = Path.home()
RUNTIME = HOME / ".config/lexbridge-mobile"
INSTALL = HOME / "Library/Application Support/LexBridge Mobile"
PLIST = HOME / "Library/LaunchAgents" / (LABEL + ".plist")
SOURCE = Path(__file__).resolve().parents[2]


def run(argv, **kwargs):
    return subprocess.run([str(a) for a in argv], check=True, **kwargs)


def no_symlinks(path):
    for component in (path, *path.parents):
        if component.is_symlink():
            raise ValueError("Refusing a symbolic-link installation path")


def private_dir(path):
    no_symlinks(path)
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if not path.is_dir() or path.stat().st_uid != os.getuid():
        raise ValueError("Installation directory must be owned by this user")
    path.chmod(0o700)


def atomic_write(path, data, mode=0o600):
    no_symlinks(path)
    fd, temporary = tempfile.mkstemp(prefix=".lexbridge-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            os.fchmod(stream.fileno(), mode)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def record_path():
    return RUNTIME / "installation.json"


def load_record(path=None):
    path = path or record_path()
    no_symlinks(path)
    meta = path.stat()
    if not stat.S_ISREG(meta.st_mode) or stat.S_IMODE(meta.st_mode) != 0o600 or meta.st_uid != os.getuid() or meta.st_size > 65536:
        raise ValueError("Installation record must be a private owned file")
    parent = path.parent.stat()
    if parent.st_uid != os.getuid() or stat.S_IMODE(parent.st_mode) != 0o700:
        raise ValueError("Installation record directory must be private and owned")
    record = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(record, dict) or type(record.get("version")) is not int or record.get("version") != 1 or record.get("label") != LABEL or record.get("plist") != str(PLIST) or record.get("current") != str(INSTALL / "current") or record.get("wrapper") != str(HOME / ".local/bin/lexbridge-mobile"):
        raise ValueError("Installation record is invalid")
    if not isinstance(record.get("bundle"), str) or not isinstance(record.get("node"), str):
        raise ValueError("Installation record paths are invalid")
    bundle = Path(record["bundle"])
    node = Path(record["node"])
    if not bundle.is_absolute() or bundle.parent != INSTALL or not node.is_absolute():
        raise ValueError("Installation record paths are invalid")
    return record


def install():
    if sys.platform != "darwin":
        raise ValueError("This installer is for macOS; other systems can run the documented bridge CLI")
    node = shutil.which("node")
    if not node:
        raise ValueError("Install Node.js 22 or newer first")
    major = int(subprocess.check_output([node, "-p", "process.versions.node.split('.')[0]"], text=True).strip())
    if major < 22:
        raise ValueError("Node.js 22 or newer is required")
    if not (SOURCE / "desktop/received.cjs").is_file():
        raise ValueError("Use the full companion bundle or repository, including desktop/received.cjs")
    private_dir(RUNTIME)
    previous_record = load_record() if record_path().exists() or record_path().is_symlink() else None
    current = INSTALL / "current"
    wrapper = HOME / ".local/bin/lexbridge-mobile"
    actions = HOME / "Applications/LexBridge Phone Tools"
    shortcuts = {actions / "Pair LexBridge Phone.command": "pair", actions / "Send Files to Phone.command": "send"}
    disabled = PLIST.with_suffix(".plist.disabled")
    managed = [PLIST, disabled, wrapper, *shortcuts, record_path()]
    for target in managed:
        no_symlinks(target)
        if target.exists() and (not target.is_file() or (previous_record is None and target != record_path())):
            raise ValueError("An unowned installation file exists; it was preserved")
    if disabled.exists():
        meta = disabled.stat()
        if meta.st_uid != os.getuid() or stat.S_IMODE(meta.st_mode) != 0o600 or meta.st_size > 65536:
            raise ValueError("Disabled service file must be private and owned")
        disabled_spec = plistlib.loads(disabled.read_bytes())
        arguments = disabled_spec.get("ProgramArguments", [])
        if not isinstance(arguments, list) or len(arguments) != 3 or any(not isinstance(value, str) for value in arguments):
            raise ValueError("Disabled service file is not an owned bridge installation")
        old_entry = Path(arguments[1])
        if disabled_spec.get("Label") != LABEL or arguments[0] != previous_record["node"] or arguments[2] != "serve" or old_entry is None or old_entry.name != "main.cjs" or len(old_entry.parents) < 4 or old_entry.parents[2].parent != INSTALL or old_entry.parts[-3:] != ("mobile", "bridge", "main.cjs"):
            raise ValueError("Disabled service file is not an owned bridge installation")
    no_symlinks(INSTALL)
    if current.exists() or current.is_symlink():
        if previous_record is None or not current.is_symlink() or current.resolve().parent != INSTALL:
            raise ValueError("Refusing to replace an unowned current installation")
    private_dir(INSTALL)
    for parent in (PLIST.parent, wrapper.parent):
        no_symlinks(parent)
        parent.mkdir(parents=True, exist_ok=True)
    private_dir(actions)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
    bundle = INSTALL / ("0.1.0-" + stamp)
    bundle.mkdir(mode=0o700)
    backup = RUNTIME / "backups" / stamp
    private_dir(backup)
    snapshots = {target: (target.read_bytes(), stat.S_IMODE(target.stat().st_mode)) if target.exists() else None for target in managed}
    previous_current = os.readlink(current) if current.is_symlink() else None
    manifest = []
    for index, (target, snapshot) in enumerate(snapshots.items()):
        if snapshot is not None:
            backup_file = backup / (str(index) + "-" + target.name)
            atomic_write(backup_file, snapshot[0])
            manifest.append({"path": str(target), "backup": str(backup_file), "mode": snapshot[1]})
    atomic_write(backup / "manifest.json", json.dumps({"files": manifest, "previousCurrent": previous_current}).encode())
    domain = "gui/" + str(os.getuid())
    was_running = subprocess.run(["launchctl", "print", domain + "/" + LABEL], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    if was_running and previous_record is None:
        raise ValueError("An unowned bridge service is running; it was preserved")
    touched_service = False
    temporary = INSTALL / (".current-" + uuid.uuid4().hex)
    try:
        for name in ("bridge", "integrations", "skills", "tools"):
            shutil.copytree(SOURCE / "mobile" / name, bundle / "mobile" / name, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        for name in ("README.md", "PROTOCOL.md"):
            shutil.copyfile(SOURCE / "mobile" / name, bundle / "mobile" / name)
        (bundle / "desktop").mkdir(mode=0o700)
        shutil.copyfile(SOURCE / "desktop/received.cjs", bundle / "desktop/received.cjs")
        run([node, bundle / "mobile/bridge/main.cjs", "init", "--endpoint", "http://127.0.0.1:18474"], stdout=subprocess.DEVNULL)
        logs = RUNTIME / "logs"
        private_dir(logs)
        for name in ("service.log", "service-error.log"):
            log = logs / name
            no_symlinks(log)
            log.touch(mode=0o600, exist_ok=True)
            log.chmod(0o600)
        spec = {"Label": LABEL, "ProgramArguments": [node, str(bundle / "mobile/bridge/main.cjs"), "serve"],
                "WorkingDirectory": str(bundle), "RunAtLoad": True, "KeepAlive": {"SuccessfulExit": False}, "ThrottleInterval": 10,
                "StandardOutPath": str(logs / "service.log"), "StandardErrorPath": str(logs / "service-error.log"),
                "EnvironmentVariables": {"PATH": str(Path(node).parent) + ":/usr/bin:/bin", "HOME": str(HOME)}, "Umask": 0o077}
        if was_running:
            run(["launchctl", "bootout", domain + "/" + LABEL], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        touched_service = True
        atomic_write(PLIST, plistlib.dumps(spec))
        run(["launchctl", "bootstrap", domain, PLIST])
        temporary.symlink_to(bundle.name, target_is_directory=True)
        temporary.replace(current)
        atomic_write(wrapper, ("#!/bin/sh\nexec " + shlex.quote(node) + " " + shlex.quote(str(current / "mobile/bridge/main.cjs")) + ' "$@"\n').encode(), 0o700)
        for shortcut, action in shortcuts.items():
            atomic_write(shortcut, ("#!/bin/sh\nexec " + shlex.quote(sys.executable) + " " + shlex.quote(str(current / "mobile/tools/mac_actions.py")) + " " + action + "\n").encode(), 0o700)
        record = {"version": 1, "label": LABEL, "bundle": str(bundle), "current": str(current), "plist": str(PLIST), "node": node, "wrapper": str(wrapper), "backup": str(backup), "shortcuts": [str(p) for p in shortcuts]}
        atomic_write(record_path(), (json.dumps(record, indent=2) + "\n").encode())
        if disabled.exists():
            disabled.unlink()  # Its owned contents are retained in the private backup manifest.
        print(json.dumps({"installed": True, "service": LABEL, "command": str(wrapper), "bundle": str(bundle), "shortcuts": str(actions), "backup": str(backup)}))
    except Exception as original:
        if touched_service:
            subprocess.run(["launchctl", "bootout", domain + "/" + LABEL], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                for target, snapshot in snapshots.items():
                    if snapshot is None:
                        if target.exists():
                            target.unlink()
                    else:
                        atomic_write(target, snapshot[0], snapshot[1])
                if current.is_symlink():
                    current.unlink()
                if previous_current is not None:
                    current.symlink_to(previous_current, target_is_directory=True)
                if was_running:
                    run(["launchctl", "bootstrap", domain, PLIST])
            except Exception:
                raise RuntimeError("Installation failed and service rollback needs attention. Private recovery files: " + str(backup)) from original
        raise
    finally:
        if temporary.is_symlink():
            temporary.unlink()


def stop():
    load_record()
    disabled = PLIST.with_suffix(".plist.disabled")
    no_symlinks(PLIST)
    no_symlinks(disabled)
    if disabled.exists() and PLIST.exists():
        raise ValueError("Disabled service backup already exists; it was preserved")
    result = subprocess.run(["launchctl", "bootout", "gui/" + str(os.getuid()) + "/" + LABEL], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if result.returncode and subprocess.run(["launchctl", "print", "gui/" + str(os.getuid()) + "/" + LABEL], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
        raise RuntimeError("The bridge service could not be stopped")
    if PLIST.exists():
        PLIST.rename(disabled)
    print("Phone bridge stopped. Source, credentials, received files and previous bundles were preserved.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stop", action="store_true", help="stop only this optional bridge, preserving all data")
    args = parser.parse_args()
    try:
        stop() if args.stop else install()
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
