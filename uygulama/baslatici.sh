#!/bin/bash
# Tensip başlatıcısı — .app çalıştırılabilir dosyası.
# Akış: daemon çalışmıyorsa başlat → oturum yoksa Chrome'da giriş iste → panoyu aç.
# TENSIPD_BIN ve TENSIP_BIN kurulum betiği tarafından doldurulur.

TENSIPD_BIN="@TENSIPD_BIN@"
TENSIP_BIN="@TENSIP_BIN@"
AYAR="$HOME/.config/tensip"
KONTROL="$AYAR/control.json"
LOG="$AYAR/tensip.log"
WEB_PORT="${TENSIP_WEB_PORT:-4747}"
PANO="http://127.0.0.1:$WEB_PORT"
YARDIMCI="$(cd "$(dirname "$0")" && pwd)/rpc-bekle.sh"

# Finder/Launchpad'den açılan uygulamada PATH minimaldir (/usr/bin:/bin:…):
# "#!/usr/bin/env node" çöker ve daemon hiç başlamaz
# (log: "env: node: No such file or directory"). PATH'i burada tamamlıyoruz.
for _p in /opt/homebrew/bin /usr/local/bin; do
  [ -d "$_p" ] && PATH="$_p:$PATH"
done
export PATH

bildir() {
  osascript -e "display notification \"$1\" with title \"Tensip\"" 2>/dev/null
}

daemon_calisiyor_mu() {
  [ -x "$YARDIMCI" ] || return 1
  "$YARDIMCI" "$KONTROL" 1 >/dev/null 2>&1
}

web_hazir_mi() {
  python3 - "$WEB_PORT" "$KONTROL" <<'PYEOF'
import json, sys, urllib.request
try:
    port = int(sys.argv[1])
    with open(sys.argv[2]) as f:
        control = json.load(f)
    req = urllib.request.Request(f"http://127.0.0.1:{port}/health")
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=1) as r:
        d = json.load(r)
    raise SystemExit(0 if d.get("ok") is True and d.get("app") == "tensip" and d.get("apiVersion") == 1 and d.get("instanceId") == control.get("instanceId") else 1)
except Exception:
    raise SystemExit(1)
PYEOF
}

if [ ! -x "$TENSIPD_BIN" ]; then
  bildir "tensipd bulunamadı: $TENSIPD_BIN — kur.sh ile kurun"
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  bildir "Node.js bulunamadı (/opt/homebrew/bin/node yok) — kur.sh ile kurun"
  exit 1
fi

if [ ! -x "$YARDIMCI" ]; then
  bildir "rpc-bekle.sh eksik: $YARDIMCI — uygulama paketi bozuk, yeniden kurun (uygulama-kur.sh)"
  exit 1
fi

if ! daemon_calisiyor_mu; then
  mkdir -p "$AYAR"
  DAEMON_ARG=(baslat "--web=$WEB_PORT")
  if [ -n "${TENSIP_PORTAL_URL:-}" ]; then
    DAEMON_ARG+=("--portal=$TENSIP_PORTAL_URL")
  fi
  nohup "$TENSIPD_BIN" "${DAEMON_ARG[@]}" >> "$LOG" 2>&1 &
  # 20 sn'e kadar "RPC 200 döndü" bekle — "dosya yazıldı" yetmez:
  # dosya yazılmış ama RPC henüz ayakta olmayabilir.
  SONUC=$("$YARDIMCI" "$KONTROL" 20 "$LOG")
  if [ "$SONUC" != "OK" ]; then
    SON_LOG=$(echo "$SONUC" | tail -n 5 | tr '\n' ' ' | cut -c1-260)
    bildir "Tensip daemon başlatılamadı (20 sn). Log: $SON_LOG"
    open "$LOG" 2>/dev/null
    exit 1
  fi
fi

if [ "${TENSIP_PANO_YOK:-0}" != "1" ] && [ "$WEB_PORT" != "false" ] && [ "$WEB_PORT" != "0" ]; then
  if ! web_hazir_mi; then
    bildir "Tensip panosu beklenen portta hazır değil: $PANO"
    open "$LOG" 2>/dev/null
    exit 1
  fi
fi

# ── oturum kontrolü ─────────────────────────────────────────────────
if [ "${TENSIP_GIRIS_YOK:-1}" != "1" ]; then
  DURUM=""
  if [ -f "$KONTROL" ]; then
    DURUM=$(python3 - "$KONTROL" <<'PYEOF'
import json, sys, urllib.request
k = json.load(open(sys.argv[1]))
istek = urllib.request.Request(
    f"http://127.0.0.1:{k['port']}/rpc/durum",
    data=b"{}",
    method="POST",
    headers={"authorization": f"Bearer {k['token']}", "content-type": "application/json"},
)
try:
    with urllib.request.urlopen(istek, timeout=10) as r:
        veri = json.load(r)
    print((veri.get("data") or {}).get("oturumDurum", ""))
except Exception as e:
    print("")
PYEOF
) 2>/dev/null
  fi
  if [ "$DURUM" != "aktif" ]; then
    bildir "UYAP penceresinde giriş yapın (mobil imza onayı gerekebilir)"
    if ! "$TENSIP_BIN" giris --cdp 2>>"$LOG"; then
      # Giriş yarıda kesildi/zaman aşımı — kullanıcıyı panoyla boşuna
      # meşgul etme; net bildirim + log.
      bildir "UYAP girişi tamamlanamadı — ayrıntılar logda"
      open "$LOG" 2>/dev/null
      exit 1
    fi
  fi
fi

if [ "${TENSIP_PANO_YOK:-0}" != "1" ] && [ "$WEB_PORT" != "false" ] && [ "$WEB_PORT" != "0" ]; then
  PENCERE="$(cd "$(dirname "$0")" && pwd)/tensip-window"
  if [ -x "$PENCERE" ]; then
    exec "$PENCERE" "$PANO"
  else
    open "$PANO"
  fi
fi
