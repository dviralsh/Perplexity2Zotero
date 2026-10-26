#!/bin/sh
# Builds dist/cites-extractor-<version>.zip from extension/ (manifest.json at the zip root).
set -e
cd "$(dirname "$0")"
version=$(python3 -c "import json;print(json.load(open('extension/manifest.json'))['version'])")
mkdir -p dist
out="dist/cites-extractor-$version.zip"
rm -f "$out"
(cd extension && zip -qr "../$out" . -x '.*')
echo "$out"
