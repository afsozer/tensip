// Finder PATH regresyonu: izole HOME, kapalı web ve yalnız loopback portalı.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const kok = fileURLToPath(new URL("../../", import.meta.url));

test("baslatici.sh GUI-PATH'i telafi eder: minimal PATH'te daemon ayağa kalkar", { timeout: 45_000 }, async () => {
  const izole = mkdtempSync(join(tmpdir(), "tensip-guihome-"));
  const ayar = join(izole, ".config", "tensip");
  const kontrol = join(ayar, "control.json");
  const calistir = join(izole, "baslatici.sh");
  // Hata yolunda dahi gerçek bildirim/tarayıcı/log penceresi açılmaz.
  const dolu = readFileSync(join(kok, "uygulama", "baslatici.sh"), "utf8")
    .replace("#!/bin/bash", '#!/bin/bash\nosascript() { :; }\nopen() { :; }')
    .replaceAll("@TENSIPD_BIN@", join(kok, "bin", "tensipd.mjs"))
    .replaceAll("@TENSIP_BIN@", join(kok, "bin", "uyap.mjs"));
  writeFileSync(calistir, dolu);
  chmodSync(calistir, 0o755);
  copyFileSync(join(kok, "uygulama", "rpc-bekle.sh"), join(izole, "rpc-bekle.sh"));
  chmodSync(join(izole, "rpc-bekle.sh"), 0o755);
  const ortam = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: izole,
    TENSIP_GIRIS_YOK: "1",
    TENSIP_PANO_YOK: "1",
    TENSIP_WEB_PORT: "false",
    TENSIP_PORTAL_URL: "http://127.0.0.1:1",
  };
  try {
    const cik = spawnSync("/bin/bash", [calistir], { env: ortam, encoding: "utf8", timeout: 30_000 });
    assert.equal(cik.error, undefined);
    assert.equal(cik.status, 0, `başlatıcı 0 ile çıkmalı (stderr: ${cik.stderr?.slice(0, 200)})`);
    assert.ok(existsSync(kontrol), "control.json yazılmalı");
    const pid = JSON.parse(readFileSync(kontrol, "utf8")).pid as number;
    assert.doesNotThrow(() => process.kill(pid, 0));
    const log = readFileSync(join(ayar, "tensip.log"), "utf8");
    assert.ok(!log.includes("env: node"));
    assert.ok(!log.includes("web-hatasi"), "test sabit pano portunu kullanmamalı");
  } finally {
    // Önce yalnız izole çocuğu durdur; control.json kaldırılmadan HOME'u silme.
    if (existsSync(kontrol)) {
      const pid = JSON.parse(readFileSync(kontrol, "utf8")).pid as number;
      try { process.kill(pid, "SIGTERM"); } catch { /* zaten çıkmış */ }
      const son = Date.now() + 12_000;
      while (existsSync(kontrol) && Date.now() < son) await new Promise((c) => setTimeout(c, 50));
      if (existsSync(kontrol)) {
        try { process.kill(pid, "SIGKILL"); } catch { /* zaten çıkmış */ }
      }
    }
    // İzole HOME'u silmek YARIŞA GİRER: çocuk daemon SIGTERM'den sonra son
    // yazımlarını bitirirken `rm` ENOTEMPTY görebiliyor (bir kez ölçüldü,
    // P06c turunda; yazımlar fsync ile biraz daha uzun sürüyor). Bu bir ürün
    // davranışı değil, temizlik yarışıdır: kısa aralıklarla yeniden denenir.
    for (let deneme = 0; ; deneme++) {
      try {
        rmSync(izole, { recursive: true, force: true });
        break;
      } catch (e) {
        if (deneme >= 20) throw e;
        await new Promise((c) => setTimeout(c, 100));
      }
    }
  }
});
