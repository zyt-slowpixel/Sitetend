#!/bin/bash
# Linux: run `bash start-linux.sh` (or ./start-linux.sh). Nothing to install: if there is no Node.js 22+, the first start
# downloads a private copy from nodejs.org into ~/.sitetend/node (checked against its published SHA-256; no root needed).
cd "$(dirname "$0")" || exit 1
PRIV="$HOME/.sitetend/node"
MIRROR="${SITETEND_NODE_MIRROR:-https://nodejs.org/dist}"
ok() { [ -x "$1" ] && [ "$("$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 22 ]; }
NODE=""
if ok "$PRIV/bin/node"; then NODE="$PRIV/bin/node"
elif command -v node >/dev/null 2>&1 && ok "$(command -v node)"; then NODE="$(command -v node)"; fi
if [ -z "$NODE" ]; then
  echo "First start: getting Node.js for Sitetend (about 50 MB, only this once)..."
  case "$(uname -m)" in aarch64|arm64) ARCH=arm64 ;; *) ARCH=x64 ;; esac
  TMP="$(mktemp -d)"; FILE=""
  for V in 24 22; do
    BASE="$MIRROR/latest-v$V.x"
    curl -fsSL "$BASE/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt" 2>/dev/null || continue
    FILE="$(grep -o "node-v$V[.0-9]*-linux-$ARCH\.tar\.gz" "$TMP/SHASUMS256.txt" | head -1)"
    [ -n "$FILE" ] && break
  done
  if [ -n "$FILE" ] && curl -fL --progress-bar "$BASE/$FILE" -o "$TMP/$FILE" \
     && (cd "$TMP" && grep " $FILE\$" SHASUMS256.txt | sha256sum -c - >/dev/null 2>&1); then
    rm -rf "$PRIV" && mkdir -p "$PRIV" && tar -xzf "$TMP/$FILE" -C "$PRIV" --strip-components 1
  fi
  rm -rf "$TMP"
  if ok "$PRIV/bin/node"; then NODE="$PRIV/bin/node"
  else echo "Could not download Node.js. Install Node.js 22 or newer from https://nodejs.org (or your package manager), then run this again."; exit 1; fi
fi
if ! command -v zenity >/dev/null 2>&1 && ! command -v kdialog >/dev/null 2>&1; then
  echo "Note: no zenity or kdialog found, so \"Open my website…\" cannot show a folder window."
  echo "      Paste the folder path on the welcome page instead, or install zenity (e.g. sudo apt install zenity)."
fi
echo "Starting Sitetend... your browser will open. Keep this terminal open; press Ctrl+C to quit."
"$NODE" bin/sitetend.mjs "$@"
