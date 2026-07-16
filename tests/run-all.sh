#!/bin/bash
# Lance toute la suite de tests d'Import Studio.
# Prérequis : node >= 18, ffmpeg/ffprobe (fixtures), et pour ui-tests.js un module
# playwright accessible (NODE_PATH=... ou PLAYWRIGHT_MODULE=/chemin/vers/playwright).
set -e
cd "$(dirname "$0")"
./generate-fixtures.sh
node unit-tests.js
node http-tests.js
if node -e "require(process.env.PLAYWRIGHT_MODULE || 'playwright')" 2>/dev/null; then
  node ui-tests.js
else
  echo "(ui-tests.js sauté : playwright introuvable — NODE_PATH ou PLAYWRIGHT_MODULE requis)"
fi
echo "SUITE COMPLÈTE OK"
