// P03 süreç sahipliği ve başlatma/durdurma kabul testleri.

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { createServer as httpServer, type ServerResponse } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcSunucu } from "../src/server/rpc.js";
import { OlayYayici } from "../src/core/log.js";
import { Hata } from "../src/core/errors.js";
import { daemonKur } from "../src/server/daemon.js";
import { tmpKok } from "./yardimci.js";
import { MockUyap, opakToken } from "./mock-uyap/sunucu.js";
import { makeUdf } from "./yardimci.js";

const PROJE = fileURLToPath(new URL("../", import.meta.url));
const TENSIPD = join(PROJE, "src", "cli", "tensipd.js");

function komut(komutlar: string[], ayar: string): Promise<{ kod: number; stdout: string; stderr: string }> {
  return new Promise((coz) => {
    const p = spawn(process.execPath, [TENSIPD, ...komutlar, `--ayar=${ayar}`], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    p.stdout.on("data", (c: Buffer) => stdout += c.toString());
    p.stderr.on("data", (c: Buffer) => stderr += c.toString());
    p.on("close", (kod) => coz({ kod: kod ?? 1, stdout, stderr }));
  });
}

async function bekle(dosya: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 100; i++) {
    if (existsSync(dosya)) return JSON.parse(readFileSync(dosya, "utf8")) as Record<string, unknown>;
    await new Promise((c) => setTimeout(c, 20));
  }
  throw new Error("control.json oluşmadı");
}

async function kapat(p: ChildProcess): Promise<void> {
  if (p.exitCode !== null) return;
  const bitti = new Promise<void>((c) => p.once("close", () => c()));
  p.kill("SIGTERM");
  await Promise.race([bitti, new Promise<void>((c) => setTimeout(c, 3_000))]);
  if (p.exitCode === null) p.kill("SIGKILL");
}

describe("P03 süreç sahipliği", () => {
  test("eski sürümün canlı RPC'si ikinci motorla ezilmez", async () => {
    const ayar = tmpKok();
    const eski = httpServer((req, res) => {
      assert.equal(req.headers.authorization, "Bearer legacy-test");
      res.writeHead(req.url === "/semasi" ? 200 : 404, { "content-type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>(r => eski.listen(0, "127.0.0.1", r));
    const kontrol = { version: 1, pid: process.pid, port: (eski.address() as { port: number }).port, token: "legacy-test", instanceId: "legacy", appVersion: "old" };
    writeFileSync(join(ayar.kok, "control.json"), JSON.stringify(kontrol));
    const rpc = new RpcSunucu({ olaylar: new OlayYayici(), isleyiciler: new Map(), appVersion: "test", dizin: ayar.kok });
    try {
      await assert.rejects(rpc.baslat(), (e: unknown) => (e as Hata).code === "IS_BUSY");
      assert.deepEqual(JSON.parse(readFileSync(join(ayar.kok, "control.json"), "utf8")), kontrol);
    } finally {
      await rpc.durdur();
      await new Promise<void>(r => eski.close(() => r()));
      ayar.temizle();
    }
  });

  test("devam eden giriş durdurmayı reddeder, kabul edilen kapanış yeni işi engeller", async () => {
    const ayar = tmpKok(), kok = tmpKok();
    let cevap!: ServerResponse;
    let geldi!: () => void;
    const istek = new Promise<void>(r => geldi = r);
    const portal = httpServer((_req, res) => { cevap = res; geldi(); });
    await new Promise<void>(r => portal.listen(0, "127.0.0.1", r));
    const daemon = daemonKur({ ayarDir: ayar.kok, kok: kok.kok, portalUrl: `http://127.0.0.1:${(portal.address() as { port: number }).port}`, oturumYenileMs: 0 });
    try {
      const k = await daemon.rpc.baslat();
      const giris = daemon.isleyiciler.get("giris")!({ cerez: "JSESSIONID=test-login" });
      await istek;
      const stop = () => fetch(`http://127.0.0.1:${k.port}/rpc/durdur`, { method: "POST", headers: { authorization: `Bearer ${k.token}`, "content-type": "application/json" }, body: JSON.stringify({ instanceId: k.instanceId }) });
      assert.equal((await stop()).status, 409);
      cevap.writeHead(200, { "content-type": "application/json", uyapfc_rc: "SUCCESS" });
      cevap.end("[]");
      await giris;
      assert.equal((await stop()).status, 200);
      for (const ad of ["giris", "klonla", "esitle", "devam"]) {
        await assert.rejects(daemon.isleyiciler.get(ad)!({}), (e: unknown) => (e as Hata).code === "IS_BUSY");
      }
    } finally {
      cevap?.end("[]");
      await daemon.kapat();
      portal.closeAllConnections();
      await new Promise<void>(r => portal.close(() => r()));
      ayar.temizle(); kok.temizle();
    }
  });

  test("aynı süreçte iki RpcSunucu aynı kilidi paylaşamaz", async () => {
    const ayar = tmpKok();
    const sec = { olaylar: new OlayYayici(), isleyiciler: new Map(), appVersion: "test", dizin: ayar.kok };
    const bir = new RpcSunucu(sec);
    const iki = new RpcSunucu(sec);
    await bir.baslat();
    await assert.rejects(iki.baslat(), (e: unknown) => (e as Hata).code === "IS_BUSY");
    await bir.durdur();
    ayar.temizle();
  });

  test("eski canlı control ile eşzamanlı daemon tek motor bırakır", async () => {
    const ayar = tmpKok();
    const kok = tmpKok();
    const bir = spawn(process.execPath, [TENSIPD, "baslat", "--web=false", `--kok=${kok.kok}`, `--portal=http://127.0.0.1:1`, `--ayar=${ayar.kok}`], { stdio: "ignore" });
    const iki = spawn(process.execPath, [TENSIPD, "baslat", "--web=false", `--kok=${kok.kok}`, `--portal=http://127.0.0.1:1`, `--ayar=${ayar.kok}`], { stdio: "ignore" });
    try {
      await bekle(join(ayar.kok, "control.json"));
      for (let i = 0; i < 100 && bir.exitCode === null && iki.exitCode === null; i++) await new Promise((c) => setTimeout(c, 20));
      const yaşayan = [bir, iki].filter((p) => p.exitCode === null);
      const biten = [bir, iki].filter((p) => p.exitCode !== null);
      assert.equal(yaşayan.length, 1);
      assert.equal(biten.length, 1);
      assert.equal(biten[0]!.exitCode, 6);
    } finally {
      const stop = await komut(["durdur"], ayar.kok);
      assert.equal(stop.kod, 0);
      await kapat(bir);
      await kapat(iki);
      ayar.temizle();
      kok.temizle();
    }
  });

  test("bayat control canlı ama ilgisiz PID'ye sinyal göndermez", async () => {
    const ayar = tmpKok();
    const yabanci = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    try {
      writeFileSync(join(ayar.kok, "control.json"), JSON.stringify({ version: 1, port: 1, token: "bayat", instanceId: "bayat", pid: yabanci.pid, appVersion: "test" }));
      const r = await komut(["durdur"], ayar.kok);
      assert.equal(r.kod, 3);
      assert.equal(yabanci.exitCode, null);
    } finally {
      yabanci.kill("SIGKILL");
      ayar.temizle();
    }
  });

  test("bozuk control anlaşılır hata verir", async () => {
    const ayar = tmpKok();
    writeFileSync(join(ayar.kok, "control.json"), "{ bozuk");
    const r = await komut(["durdur"], ayar.kok);
    assert.equal(r.kod, 2);
    assert.match(r.stderr, /control\.json bozuk/);
    ayar.temizle();
  });

  test("web port çakışması RPC'yi ve control'i temizler", async () => {
    const web = createServer();
    await new Promise<void>((c) => web.listen(0, "127.0.0.1", () => c()));
    const port = (web.address() as { port: number }).port;
    const ayar = tmpKok();
    const kok = tmpKok();
    try {
      const r = await komut(["baslat", `--web=${port}`, "--portal=http://127.0.0.1:1", `--kok=${kok.kok}`], ayar.kok);
      assert.equal(r.kod, 7);
      assert.match(r.stderr, /web-hatasi|PORT_IN_USE/);
      assert.equal(existsSync(join(ayar.kok, "control.json")), false);
    } finally {
      await new Promise<void>((c) => web.close(() => c()));
      ayar.temizle();
      kok.temizle();
    }
  });

  test("eski instance tokenı yeni daemonı durduramaz ve başarılı yanıt kapanmadan gelir", async () => {
    const ayar = tmpKok();
    const kok = tmpKok();
    const bir = spawn(process.execPath, [TENSIPD, "baslat", "--web=false", `--kok=${kok.kok}`, `--portal=http://127.0.0.1:1`, `--ayar=${ayar.kok}`], { stdio: "ignore" });
    try {
      const eski = await bekle(join(ayar.kok, "control.json"));
      const ilk = await komut(["durdur"], ayar.kok);
      assert.equal(ilk.kod, 0);
      for (let i = 0; i < 100 && bir.exitCode === null; i++) await new Promise((c) => setTimeout(c, 20));
      assert.equal(bir.exitCode, 0);
      const iki = spawn(process.execPath, [TENSIPD, "baslat", "--web=false", `--kok=${kok.kok}`, `--portal=http://127.0.0.1:1`, `--ayar=${ayar.kok}`], { stdio: "ignore" });
      try {
        const yeni = await bekle(join(ayar.kok, "control.json"));
        const yanit = await fetch(`http://127.0.0.1:${yeni.port}/rpc/durdur`, { method: "POST", headers: { authorization: `Bearer ${eski.token}`, "content-type": "application/json" }, body: JSON.stringify({ instanceId: eski.instanceId }) });
        assert.equal(yanit.status, 401);
        const son = await komut(["durdur"], ayar.kok);
        assert.equal(son.kod, 0);
      } finally {
        await kapat(iki);
      }
    } finally {
      await kapat(bir);
      ayar.temizle();
      kok.temizle();
    }
  });

  test("durdur auth kapısı aktif işi reddeder", async () => {
    const ayar = tmpKok();
    let sonrasi = false;
    const rpc = new RpcSunucu({
      olaylar: new OlayYayici(), isleyiciler: new Map(), appVersion: "test", dizin: ayar.kok,
      durdurOnay: async () => { throw new Hata("IS_BUSY", "aktif iş"); },
      durdurSonrasi: () => { sonrasi = true; },
    });
    const bilgi = await rpc.baslat();
    const r = await fetch(`http://127.0.0.1:${bilgi.port}/rpc/durdur`, { method: "POST", headers: { authorization: `Bearer ${bilgi.token}`, "content-type": "application/json" }, body: JSON.stringify({ instanceId: bilgi.instanceId }) });
    assert.equal(r.status, 409);
    assert.equal(sonrasi, false);
    await rpc.durdur();
    ayar.temizle();
  });

  test("gerçek daemon aktif indirmeyi durdurma RPC'siyle kesmez", async () => {
    const mock = new MockUyap({
      birimler: [{ birimId: "p03", birimAdi: "P03 Test Mahkemesi", yargiTuru: "0" }],
      davalar: [{
        dosyaId: opakToken("p03-dosya"), birimAdi: "P03 Test Mahkemesi", birimId: "p03",
        esasNo: "2026/3", dosyaTur: "Hukuk Dava Dosyası", dosyaDurum: "Açık", yargiTuru: "0",
        evraklar: Array.from({ length: 25 }, (_, i) => ({
          evrakId: opakToken(`p03-evrak-${i}`), tur: "Dilekçe", gonderen: "Av. P03", tip: "GLN" as const,
          tarih: "01/09/2026", birimEvrakNo: String(i), durum: "yuklu" as const,
          contentTipi: "application/octet-stream", icerik: makeUdf([`P03 ${i}`]),
        })),
      }],
    });
    const ayar = tmpKok();
    const kok = tmpKok();
    await mock.baslat();
    const daemon = daemonKur({ ayarDir: ayar.kok, kok: kok.kok, portalUrl: mock.adres(), appVersion: "test", istekAralikMs: 80, gunlukTavan: 500 });
    let isId = "";
    try {
      await daemon.rpc.baslat();
      await daemon.isleyiciler.get("giris")!({ cerez: "JSESSIONID=p03-test" });
      const baslat = await daemon.isleyiciler.get("klonla")!({ birim: "P03 Test Mahkemesi", esas: "2026/3", kapsam: "hepsi", avukat: "P03" }) as { isId: string };
      isId = baslat.isId;
      let aktifGoruldu = false;
      for (let i = 0; i < 100; i++) {
        const d = await daemon.isleyiciler.get("is")!({ isId: baslat.isId }) as { durum: string };
        if (d.durum === "calisiyor") { aktifGoruldu = true; break; }
        await new Promise((c) => setTimeout(c, 10));
      }
      assert.equal(aktifGoruldu, true);
      const bilgi = daemon.rpc.bilgiGetir()!;
      const yanit = await fetch(`http://127.0.0.1:${bilgi.port}/rpc/durdur`, { method: "POST", headers: { authorization: `Bearer ${bilgi.token}`, "content-type": "application/json" }, body: JSON.stringify({ instanceId: bilgi.instanceId }) });
      assert.equal(yanit.status, 409);
      await daemon.kapat();
    } finally {
      await daemon.kapat();
      for (let i = 0; isId !== "" && i < 100; i++) {
        const d = daemon.isleyiciler.get("is")!({ isId }) as Promise<{ durum: string }>;
        if ((await d).durum !== "calisiyor") break;
        await new Promise((c) => setTimeout(c, 10));
      }
      await mock.durdur();
      ayar.temizle();
      kok.temizle();
    }
  });
});
