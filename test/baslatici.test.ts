// Başlatıcı yardımcısı (rpc-bekle.sh) testleri — .app'in bekleme mantığı.
// Gerçek tarayıcı açılmaz; yalnız RPC hazır-bekleme doğrulanır.

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpKok } from "./yardimci.js";

const PROJE = fileURLToPath(new URL("../../", import.meta.url));
const YARDIMCI = join(PROJE, "uygulama", "rpc-bekle.sh");
const TENSIPD = join(PROJE, "dist", "src", "cli", "tensipd.js");

/** Yardımcıyı koşturur (stdout+exit kodu). */
function yardimci(kontrol: string, tavanSn: string, log?: string): { kod: number; stdout: string } {
  const r = spawnSync("bash", [YARDIMCI, kontrol, tavanSn, ...(log ? [log] : [])], {
    encoding: "utf8",
    timeout: 30_000,
  });
  return { kod: r.status ?? 1, stdout: r.stdout ?? "" };
}

describe("rpc-bekle.sh", () => {
  const sahte = tmpKok();

  after(() => {
    sahte.temizle();
  });

  test("daemon yokken: ZAMAN_ASIMI + son 5 log satırı bildirimde", () => {
    const log = join(sahte.kok, "tensip.log");
    writeFileSync(log, "satir1\nsatir2\nsatir3\nsatir4\nsatir5\nsatir6\n");
    const r = yardimci(join(sahte.kok, "control.json"), "2", log);
    assert.equal(r.kod, 1);
    assert.ok(r.stdout.includes("ZAMAN_ASIMI"));
    assert.ok(r.stdout.includes("son 5 log satırı"));
    assert.ok(r.stdout.includes("satir2")); // son 5: satir2..satir6
    assert.ok(r.stdout.includes("satir6"));
    assert.ok(!r.stdout.includes("satir1"), "yalnız son 5 satır");
  });

  test("daemon hazırken: OK, hızlı döner", async () => {
    const ayar = tmpKok();
    const kok = tmpKok();
    const cocuk = spawn(process.execPath, [
        TENSIPD, "baslat", `--ayar=${ayar.kok}`, "--portal=http://127.0.0.1:1", "--web=false", `--kok=${kok.kok}`,
      ], { stdio: "ignore" });
    const kapandi = new Promise<void>((c) => cocuk.once("close", () => c()));
    try {
      const baslangic = Date.now();
      const r = yardimci(join(ayar.kok, "control.json"), "20");
      const sure = Date.now() - baslangic;
      assert.equal(r.kod, 0);
      assert.ok(r.stdout.includes("OK"));
      assert.ok(sure < 10_000, `hızlı hazır olmalı (${sure} ms)`);
    } finally {
      cocuk.kill("SIGTERM");
      const zorla = setTimeout(() => cocuk.kill("SIGKILL"), 12_000);
      try { await kapandi; } finally { clearTimeout(zorla); }
      ayar.temizle();
      kok.temizle();
    }
  });

  test("kontrol dosyası yok ama tavan 1 sn: taşmaz", () => {
    const r = yardimci(join(sahte.kok, "yok.json"), "1");
    assert.equal(r.kod, 1);
    assert.ok(r.stdout.includes("ZAMAN_ASIMI"));
    assert.ok(existsSync(join(sahte.kok, "yok.json")) === false);
  });
});


test("rpc bekleme bütçesi yanıtsız HTTP bağlantısında da korunur", { timeout: 10_000 }, async () => {
  const ayar = tmpKok();
  const cocuk = spawn(process.execPath, ["--input-type=module", "-e",
    'import {createServer} from "node:http"; const s=createServer(()=>{}); s.listen(0,"127.0.0.1",()=>console.log(s.address().port));',
  ], { stdio: ["ignore", "pipe", "ignore"] });
  const kapandi = new Promise<void>((c) => cocuk.once("close", () => c()));
  try {
    const port = await new Promise<number>((coz, red) => {
      const zaman = setTimeout(() => red(new Error("sahte RPC başlatılamadı")), 3000);
      cocuk.once("error", (e) => { clearTimeout(zaman); red(e); });
      cocuk.stdout!.once("data", (d) => { clearTimeout(zaman); coz(Number(String(d).trim())); });
    });
    const kontrol = join(ayar.kok, "control.json");
    writeFileSync(kontrol, JSON.stringify({ version: 1, port, token: "test", instanceId: "hung-test", pid: cocuk.pid, appVersion: "test" }));
    const bas = Date.now();
    const r = yardimci(kontrol, "1");
    assert.equal(r.kod, 1);
    assert.ok(r.stdout.includes("ZAMAN_ASIMI"));
    assert.ok(Date.now() - bas < 3000, "1 sn bütçe her HTTP denemesinde yeniden başlamamalı");
  } finally {
    cocuk.kill("SIGKILL");
    await kapandi;
    ayar.temizle();
  }
});
