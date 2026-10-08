// CDP / WebSocket katmanı testleri.
// MiniWs, gerçek bir WebSocket sunucusuna karşı sınanır (elle yazılmış
// sunucu: yükseltme + çerçeve çözümü + CDP yanıt simülasyonu).

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer as httpSunucu } from "node:http";
import { mkdtempSync, utimesSync, readdirSync, existsSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join, basename } from "node:path";
import { createServer as tcpSunucu, type Socket } from "node:net";
import { createHash } from "node:crypto";
import { MiniWs, CdpIstemci } from "../src/uyap/cdp.js";
import { cdpGirisi } from "../src/uyap/login.js";
import { daemonKur } from "../src/server/daemon.js";
import { MiniWsSunucu, tmpKok } from "./yardimci.js";

const bekle = (ms: number): Promise<void> => new Promise((c) => setTimeout(c, ms));


describe("MiniWs", () => {
  const echo = new MiniWsSunucu((m) => (m.method === "test.echo" ? { yanki: true } : undefined));

  before(async () => {
    await echo.baslat();
  });
  after(async () => {
    await echo.durdur();
  });

  test("bağlan + komut/yanıt", async () => {
    const ws = new MiniWs();
    await ws.baglan(`ws://127.0.0.1:${echo.port}/devtools/browser/test`, { zamanAsimiMs: 5000 });
    const r = (await ws.cagir("test.echo", {})) as { yanki: boolean };
    assert.equal(r.yanki, true);
    ws.kapat();
  });

  test("bağlantı tavanı geçince sessiz açık bağlantı korunur", async () => {
    const ws = new MiniWs();
    try {
      await ws.baglan(`ws://127.0.0.1:${echo.port}/idle`, { zamanAsimiMs: 100 });
      await bekle(250);
      assert.equal(ws.acik, true);
      assert.deepEqual(await ws.cagir("test.echo"), { yanki: true });
    } finally { ws.kapat(); }
  });

  test("kapat bekleyen komutu hemen reddeder; kapalı bağlantı komut kabul etmez", async () => {
    const ws = new MiniWs();
    await ws.baglan(`ws://127.0.0.1:${echo.port}/close`);
    const bekleyen = assert.rejects(ws.cagir("cevapsiz"), /kapat/);
    ws.kapat();
    await bekleyen;
    await assert.rejects(ws.cagir("test.echo"), /açık değil/);
  });

  test("upgrade yanıtı gelmezse bağlantı promise'i zaman aşımıyla reddedilir", async () => {
    const soketler = new Set<Socket>();
    const sunucu = tcpSunucu((s) => { soketler.add(s); s.on("error", () => undefined); });
    await new Promise<void>((c) => sunucu.listen(0, "127.0.0.1", c));
    const ws = new MiniWs();
    try {
      const port = (sunucu.address() as { port: number }).port;
      await assert.rejects(ws.baglan(`ws://127.0.0.1:${port}/silent`, { zamanAsimiMs: 100 }), /zaman aşımı/);
    } finally {
      ws.kapat();
      for (const soket of soketler) soket.destroy();
      await new Promise<void>((c) => sunucu.close(() => c()));
    }
  });

  test("bölünmüş upgrade ve ilk paketle birleşik CDP olayı kaybolmaz", async () => {
    const soketler = new Set<Socket>();
    const sunucu = tcpSunucu((s) => {
      soketler.add(s);
      s.on("error", () => undefined);
      s.once("data", (d) => {
        const key = /sec-websocket-key: (\S+)/i.exec(d.toString())![1]!;
        const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
        s.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: web");
        setTimeout(() => {
          const event = Buffer.from(JSON.stringify({ method: "ilk", params: { ok: true } }));
          s.write(Buffer.concat([
            Buffer.from(`socket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`),
            Buffer.from([0x81, event.length]), event,
          ]));
        }, 20);
      });
    });
    await new Promise<void>((c) => sunucu.listen(0, "127.0.0.1", c));
    const ws = new MiniWs();
    const olaylar: unknown[] = [];
    ws.olayDinle("ilk", (p) => olaylar.push(p));
    try {
      const port = (sunucu.address() as { port: number }).port;
      await ws.baglan(`ws://127.0.0.1:${port}/fragment`);
      await bekle(50);
      assert.deepEqual(olaylar, [{ ok: true }]);
    } finally {
      ws.kapat();
      for (const soket of soketler) soket.destroy();
      await new Promise<void>((c) => sunucu.close(() => c()));
    }
  });

  test("olay aboneliği: id'siz mesaj olayDinle'ye düşer (abonelik kapatılabilir)", async () => {
    const ws = new MiniWs();
    await ws.baglan(`ws://127.0.0.1:${echo.port}/devtools/browser/test`, { zamanAsimiMs: 5000 });
    const olaylar: { params: unknown; oturum?: string }[] = [];
    const kapatAbone = ws.olayDinle("Olay.test", (params, oturum) => olaylar.push({ params, oturum }));
    echo.yayinla("Olay.test", { deger: 1 });
    await bekle(100);
    assert.equal(olaylar.length, 1);
    assert.deepEqual((olaylar[0]?.params as { deger: number }), { deger: 1 });
    kapatAbone();
    echo.yayinla("Olay.test", { deger: 2 });
    await bekle(100);
    assert.equal(olaylar.length, 1, "abonelik kapanınca olay gelmemeli");
    ws.kapat();
  });

  test("büyük gövde (126+ uzunluk kodlaması)", async () => {
    const buyuk = new MiniWsSunucu((m) => {
      const veri = (m as { params?: { veri?: string } }).params?.veri ?? "";
      return { uzunluk: veri.length };
    });
    await buyuk.baslat();
    const ws = new MiniWs();
    await ws.baglan(`ws://127.0.0.1:${buyuk.port}/x`, { zamanAsimiMs: 5000 });
    const r = (await ws.cagir("test.echo", { veri: "x".repeat(5000) })) as { uzunluk: number };
    assert.equal(r.uzunluk, 5000);
    ws.kapat();
    await buyuk.durdur();
  });
});

describe("CdpIstemci", () => {
  test("tumCerezler: Storage.getCookies", async () => {
    const cdpSunucu = new MiniWsSunucu((m) =>
      m.method === "Storage.getCookies" ? { cookies: [{ name: "JSESSIONID", domain: ".uyap.gov.tr", value: "abc" }] } : undefined
    );
    await cdpSunucu.baslat();
    const cdp = new CdpIstemci(`ws://127.0.0.1:${cdpSunucu.port}/devtools/browser/x`);
    await cdp.ac();
    const cerezler = await cdp.tumCerezler();
    assert.equal(cerezler.length, 1);
    assert.equal(cerezler[0]?.name, "JSESSIONID");
    cdp.kapat();
    await cdpSunucu.durdur();
  });
});

describe("cdpGirisi (mock tarayıcı)", () => {
  for (const komut of ["/uyap-test-bulunmayan-tarayici", "/usr/bin/true"]) {
    test(`tarayıcı başlangıç hatası temizlenir: ${komut}`, async () => {
      const eskiTmp = process.env["TMPDIR"];
      const izole = mkdtempSync(join(tmpdir(), "tensip-izole-"));
      process.env["TMPDIR"] = izole;
      let kayitSilindi = false;
      try {
        await assert.rejects(cdpGirisi({
          tarayiciKomutu: komut,
          kaynakKaydet: () => () => { kayitSilindi = true; },
        }));
        assert.equal(kayitSilindi, true, "başlangıç hatası kaynak kaydını silmeli");
        assert.deepEqual(readdirSync(izole), [], "profil kalmamalı");
      } finally {
        if (eskiTmp === undefined) delete process.env["TMPDIR"];
        else process.env["TMPDIR"] = eskiTmp;
        rmSync(izole, { recursive: true, force: true });
      }
    });
  }

  // GERÇEK HATA (5 Eyl): yakalayıcı ara (oturumsuz) JSESSIONID'i görür
  // görmez tarayıcıyı kapatıyordu — mobil imza akışı ölüyordu. Yeni
  // kriter: tamamlanma tarayıcının KENDİ trafiğinden okunur (SUCCESS ajx).
  test("çerez yakalanır (tarayıcının SUCCESS ajx yanıtı görünce)", async () => {
    const cdpSunucu = new MiniWsSunucu((m) =>
      m.method === "Storage.getCookies"
        ? { cookies: [{ name: "JSESSIONID", domain: ".uyap.gov.tr", value: "abc" }, { name: "EDEVLET", domain: ".e-devlet.gov.tr", value: "x" }] }
        : undefined
    );
    const bekleme = cdpGirisi({
      zamanAsimiMs: 10_000,
      sunucuKur: async (port) => {
        await cdpSunucu.baslat(port);
        return {
          wsUrl: `ws://127.0.0.1:${port}/devtools/browser/mock`,
          temizle: () => {
            void cdpSunucu.durdur();
          },
        };
      },
    });
    await bekle(400); // abonelik + hedef bağlama kurgulansın
    cdpSunucu.yayinla("Network.responseReceived", {
      response: { url: "https://avukat.uyap.gov.tr/yargiBirimleriSorgula_brd.ajx", status: 200, headers: { "uyapfc_rc": "SUCCESS" } },
    });
    const son = await bekleme;
    assert.equal(son.yontem, "cdp");
    // yalnız uyap.gov.tr çerezleri alınır
    assert.ok(son.cookie.includes("JSESSIONID=abc"));
    assert.ok(!son.cookie.includes("EDEVLET"));
  });

  test("ara çerez tek başına yakalamaz — SUCCESS gelmeden bekler", async () => {
    // e-Devlet yönlendirmesi başlarken konan ARA (oturumsuz) JSESSIONID
    // görünüyor ama tarayıcının trafiğinde SUCCESS yok → yakalama OLMAZ.
    const cdpSunucu = new MiniWsSunucu(() => ({
      cookies: [{ name: "JSESSIONID", domain: ".uyap.gov.tr", value: "ara" }],
    }));
    await assert.rejects(
      cdpGirisi({
        zamanAsimiMs: 4500,
        sunucuKur: async (port) => {
          await cdpSunucu.baslat(port);
          return {
            wsUrl: `ws://127.0.0.1:${port}/devtools/browser/mock`,
            temizle: () => {
              void cdpSunucu.durdur();
            },
          };
        },
      }),
      (e: unknown) => (e as { code?: string }).code === "LOGIN_REQUIRED"
    );
  });

  // GERÇEK GÖZLEM (5 Eyl, canlı CDP tanı): oturumlu SPA tam
  // `avukat.uyap.gov.tr/` üstünde oturuyor ve tamamen sessiz — "/"i
  // dışlayan yedek kriter ölü doğmuştu, oturum asla yakalanamıyordu.
  test("yedek kriter: '/' üstündeki oturumlu sayfa dwell sonrası yakalanır (ağ sessizliği şartsız)", async () => {
    const cdpSunucu = new MiniWsSunucu((m) => {
      if (m.method === "Storage.getCookies") {
        return { cookies: [{ name: "JSESSIONID", domain: "avukat.uyap.gov.tr", value: "gercek" }] };
      }
      if (m.method === "Target.getTargets") {
        return { targetInfos: [{ targetId: "p1", type: "page", url: "https://avukat.uyap.gov.tr/" }] };
      }
      return undefined;
    });
    const son = await cdpGirisi({
      zamanAsimiMs: 25_000,
      yedekBeklemeMs: 11_000, // eski 10 sn soket tavanını aş: insan temposu korunmalı
      sunucuKur: async (port) => {
        await cdpSunucu.baslat(port);
        return {
          wsUrl: `ws://127.0.0.1:${port}/devtools/browser/mock`,
          temizle: () => {
            void cdpSunucu.durdur();
          },
        };
      },
    });
    assert.ok(son.cookie.includes("JSESSIONID=gercek"), "yedek kriter oturumu yakalamalı");
  });

  test("yedek kriter giriş akış sayfalarını (/giris) yakalamaz", async () => {
    const cdpSunucu = new MiniWsSunucu((m) => {
      if (m.method === "Storage.getCookies") {
        return { cookies: [{ name: "JSESSIONID", domain: ".uyap.gov.tr", value: "ara" }] };
      }
      if (m.method === "Target.getTargets") {
        return { targetInfos: [{ targetId: "p1", type: "page", url: "https://avukat.uyap.gov.tr/giris" }] };
      }
      return undefined;
    });
    await assert.rejects(
      cdpGirisi({
        zamanAsimiMs: 4500,
        yedekBeklemeMs: 500,
        sunucuKur: async (port) => {
          await cdpSunucu.baslat(port);
          return {
            wsUrl: `ws://127.0.0.1:${port}/devtools/browser/mock`,
            temizle: () => {
              void cdpSunucu.durdur();
            },
          };
        },
      }),
      (e: unknown) => (e as { code?: string }).code === "LOGIN_REQUIRED"
    );
  });

  test("zaman aşımı LOGIN_REQUIRED", async () => {
    const cdpSunucu = new MiniWsSunucu(() => ({ cookies: [] }));
    await assert.rejects(
      cdpGirisi({
        zamanAsimiMs: 4500,
        sunucuKur: async (port) => {
          await cdpSunucu.baslat(port);
          return {
            wsUrl: `ws://127.0.0.1:${port}/devtools/browser/mock`,
            temizle: () => {
              void cdpSunucu.durdur();
            },
          };
        },
      }),
      (e: unknown) => (e as { code?: string }).code === "LOGIN_REQUIRED"
    );
  });

  // İSTEK KURALI (duzeltme-istegi-2026-09-05-c): giriş sürerken portala
  // TEK BİR İSTEK BİLE ATMAMALI — dış probe ara oturumu bozuyordu
  // (nosessionobject). SUCCESS görünce yakala → TEK probe.
  test("giriş beklerken portala SIFIR istek; SUCCESS sonrası TEK probe", async () => {
    let portalIstek = 0;
    const portal = httpSunucu((istek, yanit) => {
      portalIstek++;
      istek.resume();
      yanit.writeHead(200, { "content-type": "application/json", "uyapfc_rc": "SUCCESS" });
      yanit.end("{}");
    });
    await new Promise<void>((c) => portal.listen(0, "127.0.0.1", () => c()));
    const portalPort = (portal.address() as { port: number }).port;
    const tmpA = tmpKok();
    const tmpK = tmpKok();
    // e-Devlet akışı sürüyor: tarayıcıda ARA çerez var, SUCCESS yok
    const cdpSunucu = new MiniWsSunucu((m) =>
      m.method === "Storage.getCookies"
        ? { cookies: [{ name: "JSESSIONID", domain: ".uyap.gov.tr", value: "ara" }] }
        : undefined
    );
    const d = daemonKur({
      ayarDir: tmpA.kok,
      kok: tmpK.kok,
      portalUrl: `http://127.0.0.1:${portalPort}`,
      istekAralikMs: 5,
      cdpSunucuKur: async (port) => {
        await cdpSunucu.baslat(port);
        return {
          wsUrl: `ws://127.0.0.1:${port}/devtools/browser/mock`,
          temizle: () => {
            void cdpSunucu.durdur();
          },
        };
      },
    });
    await d.rpc.baslat();
    const girisPromise = (d.isleyiciler.get("giris") as (g: unknown) => Promise<unknown>)({ cdp: true });
    girisPromise.catch(() => undefined);
    try {
      await bekle(700); // en az bir yoklama turu dönsün (ara çerez görünsün)
      // (a) ara JSESSIONID + SUCCESS yok → yakalama OLMAZ, portala istek OLMAZ
      assert.equal(portalIstek, 0, "giriş beklerken portala istek gitmemeli");
      // (b) SUCCESS ajx yanıtı → yakalama + TEK probe
      cdpSunucu.yayinla("Network.responseReceived", {
        response: { url: "https://avukat.uyap.gov.tr/yargiBirimleriSorgula_brd.ajx", status: 200, headers: { "uyapfc_rc": "SUCCESS" } },
      });
      const son = (await girisPromise) as { yontem?: string };
      assert.equal(son.yontem, "cdp");
      assert.equal(portalIstek, 1, "yakalamadan sonra TEK probe atılmalı");
      assert.ok(existsSync(join(tmpA.kok, "oturum.json")), "doğrulanmış çerez kaydedilmeli");
    } finally {
      await d.kapat().catch(() => undefined);
      portal.close();
      tmpA.temizle();
      tmpK.temizle();
    }
  });

  test("profil dizinleri silinir: akım + bayat (taze korunur)", async () => {
    // izole TMPDIR: diğer test dosyalarıyla (paralel koşar) yarışmasın
    const eskiTmp = process.env["TMPDIR"];
    const izole = mkdtempSync(join(tmpdir(), "tensip-izole-"));
    process.env["TMPDIR"] = izole;
    // bayat sahte profil: 2 saat önce
    const bayat = mkdtempSync(join(tmpdir(), "tensip-profil-"));
    const eski = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(bayat, eski, eski);
    // taze sahte profil: başka sürecin olabileceği — korunmalı
    const taze = mkdtempSync(join(tmpdir(), "tensip-profil-"));
    const kalanOnce = readdirSync(izole).filter((a) => a.startsWith("tensip-profil-"));
    try {
      const cdpSunucu = new MiniWsSunucu((m) =>
        m.method === "Storage.getCookies"
          ? { cookies: [{ name: "JSESSIONID", domain: ".uyap.gov.tr", value: "abc" }] }
          : undefined
      );
      const bekleme = cdpGirisi({
        zamanAsimiMs: 10_000,
        sunucuKur: async (port) => {
          await cdpSunucu.baslat(port);
          return {
            wsUrl: `ws://127.0.0.1:${port}/devtools/browser/mock`,
            temizle: () => {
              void cdpSunucu.durdur();
            },
          };
        },
      });
      await bekle(400);
      cdpSunucu.yayinla("Network.responseReceived", {
        response: { url: "https://avukat.uyap.gov.tr/yargiBirimleriSorgula_brd.ajx", status: 200, headers: { "uyapfc_rc": "SUCCESS" } },
      });
      await bekleme;
      assert.equal(existsSync(bayat), false, "bayat profil temizlenmeli");
      assert.equal(existsSync(taze), true, "taze profil korunmalı");
      // cdpGirisi'nin KENDİ profili de silinmiş olmalı: önce/sonra farkı
      // tam 1 azalmalı (bayat) — önceki test kalıntılarına karşı dayanıklı
      const kalan = readdirSync(izole).filter((a) => a.startsWith("tensip-profil-"));
      assert.equal(kalanOnce.length - kalan.length, 1);
      assert.ok(!kalan.includes(basename(bayat)));
      assert.ok(kalan.includes(basename(taze)));
    } finally {
      if (eskiTmp === undefined) delete process.env["TMPDIR"];
      else process.env["TMPDIR"] = eskiTmp;
      rmSync(izole, { recursive: true, force: true });
    }
  });

  test("daemon kapat(): GERÇEK süreç — SIGTERM'i yutan tarayıcı SIGKILL'le ölür, profil silinir", async () => {
    // Gerçek çocuk süreciyle (mock WS yok) doğrula: sahte tarayıcı
    // SIGTERM'i yutar (trap) → tırmanma SIGKILL'e kadar çalışmalı;
    // profil dizini ancak çocuk öldükten sonra silinmeli.
    const izole = mkdtempSync(join(tmpdir(), "tensip-izole-"));
    const eskiTmp = process.env["TMPDIR"];
    process.env["TMPDIR"] = izole;
    const wsSunucu = new MiniWsSunucu(() => ({ cookies: [] })); // giriş asla bitmez
    await wsSunucu.baslat();

    const pidDosya = join(izole, "sahte-tarayici.pid");
    const sahte = join(izole, "sahte-tarayici.mjs");
    writeFileSync(sahte, `#!${process.execPath}\n` +
      `import { writeFileSync } from "node:fs";\n` +
      `process.on("SIGTERM", () => {});\n` +
      `writeFileSync(${JSON.stringify(pidDosya)}, String(process.pid));\n` +
      `console.error("DevTools listening on ws://127.0.0.1:${wsSunucu.port}/devtools/browser/fake");\n` +
      `setInterval(() => {}, 1000);\n`);
    spawnSync("chmod", ["+x", sahte]);

    const tmpA = tmpKok();
    const tmpK = tmpKok();
    const d = daemonKur({
      ayarDir: tmpA.kok,
      kok: tmpK.kok,
      portalUrl: "http://127.0.0.1:1",
      istekAralikMs: 5,
      cdpTarayiciKomutu: sahte, // GERÇEK çocuk süreci (mock süreci)
    });
    await d.rpc.baslat();

    try {
      const girisPromise = (d.isleyiciler.get("giris") as (g: unknown) => Promise<unknown>)({ cdp: true });
      girisPromise.catch(() => undefined);
      // çocuk başlasın, DevTools satırı okunsun, ws bağlansın, yoklama başlasın
      for (let i = 0; i < 50 && !existsSync(pidDosya); i++) {
        await new Promise((c) => setTimeout(c, 100));
      }
      assert.ok(existsSync(pidDosya), "sahte tarayıcı başlamalı");
      const pid = Number(readFileSync(pidDosya, "utf8").trim());
      // profil dizini oluşmuş olmalı (çocuk --user-data-dir ile yaşamakta)
      const once = readdirSync(izole).filter((a) => a.startsWith("tensip-profil-"));
      assert.ok(once.length >= 1, "profil dizini oluşmalı");
      // canlılık: süreç yaşıyor
      process.kill(pid, 0);


      await d.kapat();
      // giris akışı iptalle sonlanır
      await assert.rejects(girisPromise, (e: unknown) => (e as { code?: string }).code === "LOGIN_REQUIRED");
      // süreç ÖLMÜŞ olmalı (SIGTERM'i yuttu → SIGKILL tırmanması)
      let oldu = false;
      try {
        process.kill(pid, 0);
      } catch {
        oldu = true;
      }
      assert.ok(oldu, `sahte tarayıcı (pid ${pid}) kapatma sonrası ölmeli`);
      // profil dizini YOK olmalı — çocuk öldükten SONRA silindiği için
      const sonra = readdirSync(izole).filter((a) => a.startsWith("tensip-profil-"));
      assert.deepEqual(sonra, [], `profil kalıntısı: ${sonra.join(", ")}`);
    } finally {
      await d.kapat();
      if (eskiTmp === undefined) delete process.env["TMPDIR"];
      else process.env["TMPDIR"] = eskiTmp;
      rmSync(izole, { recursive: true, force: true });
      tmpA.temizle();
      tmpK.temizle();
      await wsSunucu.durdur();
    }
  });

  test("daemon kapat() bekleyen girişi iptal eder (temizleyici çağrılır)", async () => {
    const tmpA = tmpKok();
    const tmpK = tmpKok();
    let temizlendi = false;
    const cdpSunucu = new MiniWsSunucu(() => ({ cookies: [] })); // asla giriş yok
    const d = daemonKur({
      ayarDir: tmpA.kok,
      kok: tmpK.kok,
      portalUrl: "http://127.0.0.1:1",
      istekAralikMs: 5,
      cdpSunucuKur: async (port) => {
        await cdpSunucu.baslat(port);
        return {
          wsUrl: `ws://127.0.0.1:${port}/devtools/browser/mock`,
          temizle: () => {
            temizlendi = true;
            void cdpSunucu.durdur();
          },
        };
      },
    });
    await d.rpc.baslat();
    const girisPromise = (d.isleyiciler.get("giris") as (g: unknown) => Promise<unknown>)({ cdp: true });
    girisPromise.catch(() => undefined); // unhandled rejection yok
    await new Promise((c) => setTimeout(c, 300)); // cdp bağlansın, yoklama başlasın
    await d.kapat();
    // temizleyici giris akışı bitince çağrılır (iptal → finally → temizle)
    await assert.rejects(girisPromise, (e: unknown) => (e as { code?: string }).code === "LOGIN_REQUIRED");
    assert.equal(temizlendi, true, "daemon kapatınca giriş temizleyicisi çalışmalı");
    tmpA.temizle();
    tmpK.temizle();
  });
});
