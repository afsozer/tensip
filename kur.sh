#!/bin/bash
# Tensip kurulumu: derle + npm global link.
# Kullanım: ./kur.sh
set -euo pipefail
cd "$(dirname "$0")"

npm install
npm run build

echo "— testler çalıştırılıyor (mock portal; gerçek UYAP'a dokunmaz)…"
npm test

echo "— global kurulum (npm install -g .)…"
npm install -g .

if command -v tensipd >/dev/null 2>&1; then
  echo "✓ kurulum tamam: $(command -v tensipd) ve $(command -v tensip)"
  echo "  başlat:  tensipd baslat"
  echo "  giriş:   tensip giris --cdp"
else
  echo "! 'tensipd' PATH'te değil. npm global bin dizinini PATH'e ekleyin."
  echo "  ya da doğrudan: node $(pwd)/bin/tensipd.mjs baslat"
fi
