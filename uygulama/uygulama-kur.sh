#!/bin/bash
# Tensip'i macOS masaüstü uygulaması olarak kurar:
#   /Applications/Tensip.app  (çift tık → daemon + uygulama penceresi)
# Kullanım: ./uygulama-kur.sh
set -euo pipefail
cd "$(dirname "$0")/.."

UYG="$(pwd)/uygulama"
TENSIPD_BIN="$(command -v tensipd || echo /opt/homebrew/bin/tensipd)"
TENSIP_BIN="$(command -v tensip || echo /opt/homebrew/bin/tensip)"

[ -x "$TENSIPD_BIN" ] || { echo "tensipd bulunamadı — önce ./kur.sh çalıştırın"; exit 1; }
[ -x "$TENSIP_BIN" ] || { echo "tensip bulunamadı — önce ./kur.sh çalıştırın"; exit 1; }

# P10a — sürüm burada SABİT TUTULMAZ; tek yazılı kaynak package.json'dur.
# Okunamazsa kurulum DURUR: yanlış sürüm taşıyan bir .app, "hangi kod
# çalışıyor" sorusunu sessizce yanlış yanıtlar.
SURUM="$(node -p "require('./package.json').version" 2>/dev/null || true)"
case "$SURUM" in
  ""|undefined|null) echo "package.json sürümü okunamadı — kurulum durduruldu"; exit 1;;
esac

ICNS="$UYG/tensip.icns"
[ -f "$ICNS" ] || { echo "Uygulama ikonu bulunamadı: $ICNS"; exit 1; }
echo "— macOS penceresi derleniyor…"
mkdir -p "$UYG/build"
swiftc "$UYG/Pencere.swift" -o "$UYG/build/tensip-window" -framework AppKit -framework WebKit

echo "— .app paketi hazırlanıyor…"
APP="$UYG/Tensip.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
sed -e "s|@TENSIPD_BIN@|$TENSIPD_BIN|g" -e "s|@TENSIP_BIN@|$TENSIP_BIN|g" "$UYG/baslatici.sh" > "$APP/Contents/MacOS/tensip"
chmod +x "$APP/Contents/MacOS/tensip"
cp "$UYG/rpc-bekle.sh" "$APP/Contents/MacOS/rpc-bekle.sh"
chmod +x "$APP/Contents/MacOS/rpc-bekle.sh"
cp "$ICNS" "$APP/Contents/Resources/tensip.icns"
cp "$UYG/build/tensip-window" "$APP/Contents/MacOS/tensip-window"
# Tırnaksız heredoc: yalnız ${SURUM} genişler (plist metninde başka $ yok).
cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Tensip</string>
  <key>CFBundleDisplayName</key><string>Tensip</string>
  <key>CFBundleIdentifier</key><string>tr.avfatihsozer.tensip</string>
  <key>CFBundleExecutable</key><string>tensip</string>
  <key>CFBundleIconFile</key><string>tensip</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${SURUM}</string>
  <key>CFBundleVersion</key><string>${SURUM}</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSUIElement</key><false/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>Av. A. Fatih Sözer</string>
</dict>
</plist>
EOF

echo "— /Applications'a kopyalanıyor…"
ditto "$APP" "/Applications/Tensip.app"
codesign --force --deep --sign - "/Applications/Tensip.app"
# Launchpad/Spotlight'a kaydı
touch "/Applications/Tensip.app"
# P10a — "hangi kod kuruldu?" sorusu kurulumun SONUNDA yanıtlanır.
# `tensipd` bir symlink zinciriyle bir checkout'a bağlıdır; zincir çözülüp
# dal/commit ile birlikte basılır. `git` ÇALIŞTIRILMAZ, .git dosyaları okunur.
COZULMUS="$(python3 -c "import os,sys; print(os.path.realpath(sys.argv[1]))" "$TENSIPD_BIN" 2>/dev/null || echo "$TENSIPD_BIN")"
DAL="bilinmiyor"; COMMIT="bilinmiyor"
if [ -f .git/HEAD ]; then
  HEADV="$(cat .git/HEAD)"
  case "$HEADV" in
    "ref: "*)
      REF="${HEADV#ref: }"
      DAL="${REF#refs/heads/}"
      if [ -f ".git/$REF" ]; then
        COMMIT="$(cat ".git/$REF")"
      elif [ -f .git/packed-refs ]; then
        COMMIT="$(awk -v r="$REF" '$2 == r { print $1 }' .git/packed-refs)"
      fi
      ;;
    *) DAL="(HEAD ayrık)"; COMMIT="$HEADV";;
  esac
fi

echo "✓ kuruldu: /Applications/Tensip.app"
echo "  Sürüm:    $SURUM"
echo "  Motor:    $COZULMUS"
echo "  Kaynak:   dal $DAL · commit ${COMMIT:-bilinmiyor}"
echo "  NOT: kurulu uygulama BU klasördeki kodu çalıştırır; klasör taşınır ya da"
echo "       başka bir dal çıkılırsa çift tık o kodu açar."
echo "  Kullanım: Launchpad ya da Spotlight'tan 'Tensip' — çift tık yeter."
echo "  Kapatma:  Terminal'de 'tensipd durdur'"
