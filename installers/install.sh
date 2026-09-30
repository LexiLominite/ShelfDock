#!/bin/sh
set -eu
umask 077

app=$1
edition=$2
payload=$3
expected_sha=$4
version=$5
arch=$6

case "$app:$edition:$arch" in
  ShelfDock:public:x64|ShelfDock:public:arm64|LexBridge:personal:x64|LexBridge:personal:arm64) ;;
  *) echo 'Unsupported app edition or architecture.' >&2; exit 2 ;;
esac
printf '%s' "$version" | LC_ALL=C grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$' || { echo 'Invalid version.' >&2; exit 2; }
case "$expected_sha" in *[!a-fA-F0-9]*|'') echo 'Invalid package checksum.' >&2; exit 2 ;; esac
[ "${#expected_sha}" -eq 64 ] || { echo 'Invalid package checksum.' >&2; exit 2; }
case "$payload" in *[!A-Za-z0-9_.-]*|'') echo 'Invalid payload name.' >&2; exit 2 ;; esac

payload="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/$payload"

if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum -- "$payload" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$payload" | awk '{print $1}')
else
  echo 'Install sha256sum or shasum before installing.' >&2; exit 2
fi
[ "$actual" = "$expected_sha" ] || { echo 'Package checksum mismatch.' >&2; exit 3; }

system=$(uname -s)
machine=$(uname -m)
[ "$system" = Linux ] || { echo 'The destination is not Linux.' >&2; exit 4; }
case "$machine:$arch" in x86_64:x64|amd64:x64|aarch64:arm64|arm64:arm64) ;; *) echo 'Destination architecture changed.' >&2; exit 4 ;; esac

root="$app-$version-linux-$arch"
case "$edition" in personal) root="LexBridge-personal-$version-linux-$arch" ;; esac
dest="$HOME/Applications/$root"
parent="$HOME/Applications"
stage="$parent/.${root}.install-$$"
mkdir -p "$parent"
[ ! -L "$parent" ] && [ ! -L "$HOME/Applications" ] || { echo 'Refusing a redirected Applications directory.' >&2; exit 5; }
[ ! -e "$dest" ] && [ ! -L "$dest" ] || { echo 'An app already exists at this destination; remove or rename it before installing.' >&2; exit 6; }
[ ! -e "$stage" ] && [ ! -L "$stage" ] || { echo 'A temporary installation path already exists.' >&2; exit 6; }
launcher_parent="$HOME/.local/share/applications"
launcher="$launcher_parent/$app-$version-$arch.desktop"
case "$HOME" in *'
'*) echo 'Unsupported home path.' >&2; exit 5 ;; esac
if printf '%s' "$HOME" | LC_ALL=C grep -q '[[:cntrl:]]'; then echo 'Unsupported home path.' >&2; exit 5; fi
for folder in "$HOME/.local" "$HOME/.local/share" "$launcher_parent"; do
  [ ! -L "$folder" ] || { echo 'Refusing a redirected launcher folder.' >&2; exit 5; }
done
[ ! -e "$launcher" ] && [ ! -L "$launcher" ] || { echo 'A launcher already exists; remove or rename it before installing.' >&2; exit 6; }
mkdir -p "$launcher_parent"
mkdir -m 700 "$stage"
committed=no
launcher_installed=no
success=no
cleanup() {
  if [ "$success" != yes ]; then
    [ "$launcher_installed" != yes ] || rm -f -- "$launcher"
    [ "$committed" != yes ] || rm -rf -- "$dest"
  fi
  rm -rf -- "$stage"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

# Sender already validated archive structure and app.asar identity; independently
# reject path traversal and links before extracting this checksum-pinned payload.
tar -tzf "$payload" | awk -v root="$root" 'BEGIN { bad=0 } { if ($0 !~ ("^" root "(/|$)") || $0 ~ /(^|\/)\.\.(\/|$)/ || $0 ~ /^\//) bad=1 } END { exit bad }'
tar -tvzf "$payload" | awk 'substr($0,1,1) != "-" && substr($0,1,1) != "d" { bad=1 } END { exit bad }' 
tar -xzf "$payload" -C "$stage" --no-same-owner --no-same-permissions
[ -d "$stage/$root" ] && [ ! -L "$stage/$root" ] || { echo 'Package folder did not match the selected app.' >&2; exit 7; }
[ -x "$stage/$root/$app" ] || { echo 'Package executable was missing.' >&2; exit 7; }
# Desktop entry paths use desktop-file escaping, without invoking a shell.
escaped_exe=$(printf '%s' "$dest/$app" | sed 's/\\/\\\\/g; s/"/\\"/g; s/`/\\`/g; s/\$/\\$/g; s/%/%%/g')
printf '[Desktop Entry]\nType=Application\nName=%s\nExec="%s"\nTerminal=false\nCategories=Utility;\n' "$app" "$escaped_exe" > "$stage/app.desktop"
chmod 644 "$stage/app.desktop"
[ ! -e "$dest" ] && [ ! -L "$dest" ] || { echo 'The app destination changed during installation.' >&2; exit 6; }
mv -- "$stage/$root" "$dest"
committed=yes
# A hard link atomically refuses a competing or existing launcher.
ln -- "$stage/app.desktop" "$launcher"
launcher_installed=yes
success=yes
printf 'DH_INSTALLED=yes\n'
