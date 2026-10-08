#!/bin/bash
# rpc-bekle.sh <kontrol-dosyası> <tavan-sn> [log-dosyası]
# Tek monoton son tarih: bağlantı ve beklemeler aynı süre bütçesini paylaşır.
exec python3 - "$@" <<'PYEOF'
import json
import math
import sys
import time
import urllib.request
from collections import deque

kontrol = sys.argv[1] if len(sys.argv) > 1 else ""
log = sys.argv[3] if len(sys.argv) > 3 else ""
try:
    tavan = float(sys.argv[2]) if len(sys.argv) > 2 else 20.0
    if not kontrol or not math.isfinite(tavan) or tavan < 0:
        raise ValueError()
except ValueError:
    print("ZAMAN_ASIMI")
    print("kullanım: rpc-bekle.sh <kontrol-dosyası> <tavan-sn> [log-dosyası]")
    sys.exit(1)

son = time.monotonic() + tavan
# Yerel RPC hiçbir ortam proxy'sine gönderilmez.
acici = urllib.request.build_opener(urllib.request.ProxyHandler({}))
while time.monotonic() < son:
    try:
        with open(kontrol) as f:
            k = json.load(f)
        if (
            not isinstance(k, dict) or k.get("version") != 1 or
            not isinstance(k.get("token"), str) or not k["token"] or
            not isinstance(k.get("instanceId"), str) or not k["instanceId"] or
            not isinstance(k.get("port"), int) or not 1 <= k["port"] <= 65535
        ):
            print("BOZUK_KONTROL")
            sys.exit(2)
        kalan = son - time.monotonic()
        if kalan <= 0:
            break
        istek = urllib.request.Request(
            f"http://127.0.0.1:{k['port']}/rpc/kimlik",
            data=b"{}", method="POST",
            headers={"authorization": f"Bearer {k['token']}", "content-type": "application/json"},
        )
        with acici.open(istek, timeout=min(5.0, kalan)) as r:
            if r.status == 200:
                g = json.load(r)
                if (g.get("ok") is True and
                    (g.get("data") or {}).get("instanceId") == k["instanceId"]):
                    print("OK")
                    sys.exit(0)
                print("KIMLIK_UYUSMUYOR")
                sys.exit(2)
    except json.JSONDecodeError:
        print("BOZUK_KONTROL")
        sys.exit(2)
    except Exception:
        pass
    time.sleep(min(0.2, max(0.0, son - time.monotonic())))

print("ZAMAN_ASIMI")
if log:
    try:
        with open(log, errors="replace") as f:
            satirlar = list(deque(f, maxlen=5))
        print("--- son 5 log satırı ---")
        print("".join(satirlar), end="")
    except OSError:
        pass
sys.exit(1)
PYEOF
