#!/bin/bash
# Builds ~/Applications/Scrummaster.app — a double-clickable launcher for this project.
# Clicking it starts the server in the background (if it isn't running yet) and opens the
# assistant in its own window. Run again after moving the project folder.
#
#   bash scripts/make-mac-app.sh
set -euo pipefail

PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$HOME/Applications/Scrummaster.app"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Building $APP for project $PROJECT"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# --- Icon: public/icon-512.png -> .icns (macOS app icon format) ---
SET="$TMP/AppIcon.iconset"; mkdir -p "$SET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$PROJECT/public/icon-512.png" --out "$SET/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2)); [ $d -le 512 ] && sips -z $d $d "$PROJECT/public/icon-512.png" --out "$SET/icon_${s}x${s}@2x.png" >/dev/null
done
cp "$PROJECT/public/icon-512.png" "$SET/icon_256x256@2x.png"
iconutil -c icns "$SET" -o "$APP/Contents/Resources/AppIcon.icns"

# --- Info.plist (LSUIElement: the launcher itself never sits in the Dock; the window it opens does) ---
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Scrummaster</string>
  <key>CFBundleDisplayName</key><string>Scrummaster</string>
  <key>CFBundleIdentifier</key><string>fi.druid.scrummaster-launcher</string>
  <key>CFBundleExecutable</key><string>Scrummaster</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSUIElement</key><true/>
</dict></plist>
PLIST

# --- The launcher script itself ---
cat > "$APP/Contents/MacOS/Scrummaster" <<LAUNCHER
#!/bin/bash
PROJECT="$PROJECT"
LAUNCHER
cat >> "$APP/Contents/MacOS/Scrummaster" <<'LAUNCHER'
LOG="$HOME/Library/Logs/Scrummaster.log"
PORT=$(grep -E '^PORT=[0-9]+' "$PROJECT/.env" 2>/dev/null | cut -d= -f2); PORT=${PORT:-3000}
URL="http://localhost:$PORT"
fail() { osascript -e "display alert \"Scrummaster could not start\" message \"$1\" as critical" >/dev/null; exit 1; }

if ! curl -s -m 1 "$URL/api/status" >/dev/null; then
  # Apps started from Finder don't get the terminal's PATH, so find Node 22+ ourselves.
  export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" && nvm use 22 >/dev/null 2>&1
  command -v node >/dev/null || fail "Node.js was not found. Install Node 22 or newer from nodejs.org."
  [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ] || fail "Node $(node -v) is too old; version 22 or newer is needed."
  [ -d "$PROJECT" ] || fail "Project folder not found: $PROJECT. Run scripts/make-mac-app.sh again."
  cd "$PROJECT" && echo "--- $(date) starting" >> "$LOG"
  nohup node server.mjs >> "$LOG" 2>&1 &
  for i in $(seq 1 40); do curl -s -m 1 "$URL/api/status" >/dev/null && break; sleep 0.5; done
  curl -s -m 1 "$URL/api/status" >/dev/null || fail "The server did not start. Details are in ~/Library/Logs/Scrummaster.log"
fi

# Open the installed Chrome app window if there is one, otherwise a Chrome app-style window, otherwise the default browser.
PWA="$HOME/Applications/Chrome Apps.localized/Scrummaster Assistant.app"
if [ -d "$PWA" ]; then open "$PWA"
elif [ -d "/Applications/Google Chrome.app" ]; then open -na "Google Chrome" --args --app="$URL"
else open "$URL"; fi
LAUNCHER
chmod +x "$APP/Contents/MacOS/Scrummaster"

touch "$APP"  # make Finder pick up the new icon
echo "Done. Open it from Spotlight (Cmd+Space, type Scrummaster) or drag it from ~/Applications to the Dock."
