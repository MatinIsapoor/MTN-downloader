#!/bin/bash

# به‌روزرسانی pip
echo "Updating pip..."
pip install --upgrade pip

# نصب نسخه Nightly یت‌دی‌ال‌پی
echo "Installing yt-dlp nightly..."
pip install -U --pre "yt-dlp[default]"

# نمایش نسخه نصب شده برای اطمینان
echo "yt-dlp version:"
yt-dlp --version

# Optional speed boost: aria2c (8-connection downloads). Best-effort only —
# never fails the build if the package manager is unavailable.
echo "Trying to install aria2c (optional, speeds up mp4 downloads)..."
(aria2c --version || apt-get install -y aria2 || sudo apt-get install -y aria2) 2>/dev/null || echo "aria2c not available, continuing with native downloader"
aria2c --version 2>/dev/null || true

# ffmpeg (REQUIRED: Pinterest's raw MP4s show BLACK VIDEO with audio in
# Telegram without the re-encode, and any video+audio merge needs it too).
# Render's native runtime has no ffmpeg and no root for apt, so install a static
# build best-effort: skip when a system ffmpeg already exists (or when not on
# Linux — local Windows dev uses the committed ffmpeg.exe).
# TWO sources are tried: johnvansickle.com is often slow/blocked from
# datacenters, and its failure used to leave the deploy with no ffmpeg at all
# (silent black-video bug). BtbN's GitHub release is the fallback.
echo "Checking for ffmpeg..."
if command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg already available: $(command -v ffmpeg)"
elif [ "$(uname -s)" != "Linux" ]; then
  echo "Not Linux — skipping static ffmpeg (use the local ffmpeg.exe)"
else
  echo "Installing static ffmpeg (best-effort, needed for Pinterest/HLS)..."
  ffmpeg_ok=0

  # Source 1: johnvansickle.com static amd64 build.
  if curl -fsSL --retry 2 --max-time 120 -o /tmp/ffmpeg-jv.tar.xz \
       "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz" 2>/dev/null; then
    mkdir -p /tmp/ffmpeg-jv
    if tar -xJf /tmp/ffmpeg-jv.tar.xz -C /tmp/ffmpeg-jv 2>/dev/null; then
      find /tmp/ffmpeg-jv -maxdepth 2 -name ffmpeg -type f -exec cp {} ./ffmpeg \; 2>/dev/null
      [ -f ./ffmpeg ] && ffmpeg_ok=1
    fi
  fi

  # Source 2: BtbN GitHub release (GitHub CDN, usually reachable from Render).
  if [ "$ffmpeg_ok" = "0" ]; then
    echo "johnvansickle source failed — trying BtbN GitHub build..."
    if curl -fsSL --retry 2 --max-time 180 -o /tmp/ffmpeg-btbn.tar.xz \
         "https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-linux64-gpl.tar.xz" 2>/dev/null; then
      mkdir -p /tmp/ffmpeg-btbn
      if tar -xJf /tmp/ffmpeg-btbn.tar.xz -C /tmp/ffmpeg-btbn 2>/dev/null; then
        find /tmp/ffmpeg-btbn -maxdepth 3 -path '*/bin/ffmpeg' -type f -exec cp {} ./ffmpeg \; 2>/dev/null
        [ -f ./ffmpeg ] && ffmpeg_ok=1
      fi
    fi
  fi

  if [ "$ffmpeg_ok" = "1" ]; then
    chmod +x ./ffmpeg
    rm -f /tmp/ffmpeg-jv.tar.xz /tmp/ffmpeg-btbn.tar.xz
    rm -rf /tmp/ffmpeg-jv /tmp/ffmpeg-btbn
    echo "static ffmpeg installed: $(./ffmpeg -version 2>/dev/null | head -n 1)"
  else
    echo "WARNING: static ffmpeg install failed — Pinterest videos will arrive with BLACK VIDEO and audio only, and HLS-only videos fall back to cover images."
    echo "WARNING: check /diag in the bot and the build log; both ffmpeg sources failed."
  fi
fi

# Optional PO-token provider plugin (bgutil) for YouTube datacenter
# bot-checks. Only installed when POT_PROVIDER=1 (needs a sidecar server at
# POT_SERVER_URL at runtime). Best-effort only — never fails the build.
if [ "${POT_PROVIDER:-0}" = "1" ]; then
  echo "Installing bgutil POT provider plugin (optional)..."
  (pip install -U "bgutil-ytdlp-pot-provider" 2>/dev/null && echo "bgutil plugin installed") || echo "bgutil plugin not available, continuing without PO-token provider"
else
  echo "Skipping bgutil POT plugin (set POT_PROVIDER=1 to enable)"
fi

# نصب وابستگی‌های Node.js
# npm ci is deterministic and faster than install; fall back when the lockfile
# and package.json disagree (e.g. after a manual dependency bump).
echo "Installing Node.js dependencies..."
npm ci --no-audit --no-fund || npm install --no-audit --no-fund

# ساخت پروژه
echo "Building project..."
npm run build

echo "Build completed successfully!"