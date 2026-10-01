#!/usr/bin/env python3
"""User-invoked Mac dialogs for pairing and sending; never launch during background work."""
import json
from pathlib import Path
import subprocess
import sys
import os
import re
import uuid
from install_macos import load_record

SCRIPT = '''use framework "Foundation"
use scripting additions
on run argv
set operation to item 1 of argv
if operation is "pair" then
display dialog (item 2 of argv) with title "Pair LexBridge Phone" buttons {"Done"} default button "Done"
return ""
else if operation is "choose" then
set choices to items 2 thru -1 of argv
set selected to choose from list choices with title "Send to LexBridge Phone" with prompt "Choose your paired phone" without multiple selections allowed
if selected is false then return ""
return item 1 of selected
else if operation is "file" then
set selected to choose file with prompt "Choose files to send to your LexBridge phone" with multiple selections allowed
set paths to current application's NSMutableArray's array()
repeat with selectedFile in selected
paths's addObject:(POSIX path of selectedFile)
end repeat
set encoded to current application's NSJSONSerialization's dataWithJSONObject:paths options:0 |error|:(missing value)
return (current application's NSString's alloc()'s initWithData:encoded encoding:4) as text
else
display dialog (item 2 of argv) with title "LexBridge Phone" buttons {"OK"} default button "OK"
return ""
end if
end run'''


def dialog(operation, *args):
    result = subprocess.run(["osascript", "-e", SCRIPT, operation, *args], capture_output=True, text=True)
    if result.returncode:
        if "(-128)" in result.stderr:
            return ""
        raise RuntimeError("The Mac dialog could not be opened")
    return result.stdout.strip()


def command(node, entry, *args):
    result = subprocess.run([node, str(entry), *args], capture_output=True, text=True, timeout=660 if args and args[0] == "send" else 30)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or "The desktop connection is unavailable")
    return result.stdout


def selected_files(raw):
    values = json.loads(raw)
    if not isinstance(values, list) or not values or len(values) > 128:
        raise ValueError("Choose between one and 128 ordinary files")
    result = []
    for value in values:
        if not isinstance(value, str) or any(ord(c) < 32 or ord(c) == 127 for c in value):
            raise ValueError("File paths must not contain control characters")
        file = Path(value)
        name = file.name
        if not file.is_absolute() or file.is_symlink() or not file.is_file() or not name or len(name.encode("utf-8")) > 255 or name != name.strip() or name.endswith((".", " ")) or any(c in name for c in "\\/:") or re.search(r"[\u202a-\u202e\u2066-\u2069]", name) or name.lower() == ".dropharbor-receipt.json" or re.match(r"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", name, re.I):
            raise ValueError("Choose ordinary files with safe names")
        result.append(str(file))
    return result


def main():
    if sys.argv[1:] not in (["pair"], ["send"]):
        raise ValueError("Use the Pair or Send Files shortcut")
    record = load_record()
    node = record["node"]
    entry = Path(record["current"]) / "mobile/bridge/main.cjs"
    if sys.argv[1:] == ["pair"]:
        tailscale = Path("/Applications/Tailscale.app/Contents/MacOS/Tailscale")
        if not tailscale.exists():
            raise RuntimeError("Open Tailscale on this Mac before pairing")
        result = subprocess.run([str(tailscale), "ip", "-4"], capture_output=True, text=True)
        address = result.stdout.strip()
        import ipaddress
        try:
            if ipaddress.ip_address(address) not in ipaddress.ip_network("100.64.0.0/10"):
                raise ValueError()
        except ValueError:
            raise RuntimeError("Connect Tailscale on this Mac before pairing") from None
        pair = json.loads(command(node, entry, "pair", "--endpoint", "http://" + address + ":18474", "--show"))
        dialog("pair", "On Android, open LexBridge and enter:\n\nServer URL: " + pair["endpoint"] +
               "\n\nOne-time code: " + pair["code"] + "\n\nThis code expires in ten minutes and can be used once. Keep it private.")
        return
    devices = json.loads(command(node, entry, "status"))["devices"]
    if not devices:
        dialog("message", "Pair your phone first using Pair LexBridge Phone.")
        return
    choices = {}
    for device in devices:
        device_id = str(uuid.UUID(device["id"]))
        if device_id != device["id"].lower() or not isinstance(device["name"], str):
            raise ValueError("Invalid paired device list")
        # Full stable identity avoids collisions even when names and UUID prefixes match.
        choices[device["name"] + " · " + device_id] = device_id
    selected = next(iter(choices)) if len(choices) == 1 else dialog("choose", *choices)
    if not selected:
        return
    if selected not in choices:
        raise ValueError("Invalid phone selection")
    files = dialog("file")
    if not files:
        return
    paths = selected_files(files)
    count = 0
    for file in paths:
        result = json.loads(command(node, entry, "send", file, "--device", choices[selected]))
        if result.get("file", {}).get("status") != "queued":
            raise RuntimeError("The file was not confirmed as queued")
        count += 1
    dialog("message", str(count) + " file(s) queued for " + selected.split(" · ")[0] +
           ". Keep the phone's Background connection and Tailscale enabled. Queued does not yet mean received.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.TimeoutExpired) as error:
        dialog("message", str(error))
        raise SystemExit(1)
