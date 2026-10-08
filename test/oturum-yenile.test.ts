// Oturum canlı-tutma (keep-alive) testleri — SAYAN mock portal ile.
// Kural (kullanıcı kararı, 5 Eyl): program açıkken ~10 dk'da bir taze probe;
// giriş beklerken SIFIR istek; art arda 2 "bitti" → oturum silinip dövme durur.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer as httpSunucu, type Server } from "node:http";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { daemonKur } from "../src/server/daemon.js";
import { OturumDepo } from "../src/uyap/session.js";
import { MiniWsSunucu, tmpKok } from "./yardimci.js";

const bekle = (ms: number): Promise<void> => new Promise((c) => setTimeout(c, ms));

/** Sayan portal mock'u: her isteği sayar, ayarlanabilir yanıt döner. */
async function portalKur(yanit: { durum: number; rc: string }): Promise<{
  port: number;
  sayac: () => number;
  kapat: () => Promise<void>;
}> {
  let sayac = 0;
  const s: Server = httpSunucu((istek, cevap) => {
    sayac += 1;
    istek.resume();
    cevap.writeHead(yanit.durum, { "content-type": "application/json", "uyapfc_rc": yanit.rc });
    cevap.end("{}");
  });
  const port = await new Promise<number>((c) =>
    s.listen(0, "127.0.0.1", () => c((s.address() as { port: number }).port))
  );
  return { port, sayac: () => sayac, kapat: () => new Promise((c) => s.close(() => c())) };
}

function oturumYaz(ayarKok: string): void {
  new OturumDepo(ayarKok).yaz({
    surum: 1,
    cookie: "JSESSIONID=test-oturum",
    loginAt: new Date().toISOString(),
    yontem: "manuel",
  });
}

describe("oturum canlı-tutma", () => {
  test("aktif oturumu aralıklı probe ile canlı tutar", async () => {
    const p = await portalKur({ durum: 200, rc: "SUCCESS" });
    const ayar = tmpKok();
    const kokK = tmpKok();
    oturumYaz(ayar.kok);
    const d = daemonKur({
      ayarDir: ayar.kok,
      kok: kokK.kok,
      portalUrl: `http://127.0.0.1:${p.port}`,
      istekAralikMs: 5,
      oturumYenileMs: 500,
      webPort: 0,
    });
    await d.rpc.baslat();
    try {
      await bekle(1700); // 500 ms aralık → ~3 tick
      assert.ok(p.sayac() >= 2, `yenileyici oturumu canlı tutmalı (istek sayısı: ${p.sayac()})`);
    } finally {
      await d.kapat();
      await p.kapat();
      ayar.temizle();
      kokK.temizle();
    }
  });

  test("CDP girişi sürerken yenileyici ateşlenmez — SIFIR portal isteği", async () => {
    const p = await portalKur({ durum: 200, rc: "SUCCESS" });
    const ayar = tmpKok();
    const kokK = tmpKok();
    oturumYaz(ayar.kok); // BAYAT oturum dosyası duruyor (yeniden giriş senaryosu)
    const cdpSunucu = new MiniWsSunucu(() => ({
      cookies: [{ name: "JSESSIONID", domain: ".uyap.gov.tr", value: "ara" }],
    }));
    const d = daemonKur({
      ayarDir: ayar.kok,
      kok: kokK.kok,
      portalUrl: `http://127.0.0.1:${p.port}`,
      istekAralikMs: 5,
      oturumYenileMs: 300,
      webPort: 0,
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
    let kapandiMi = false;
    const temizleHepsi = async (): Promise<void> => {
      if (kapandiMi) return;
      kapandiMi = true;
      await d.kapat().catch(() => undefined); // iptal → giris LOGIN_REQUIRED ile düşer
      await p.kapat();
      ayar.temizle();
      kokK.temizle();
    };
    try {
      await bekle(1300); // ~4 yenileme tick'i geçsin
      await assert.rejects(d.isleyiciler.get("giris")!({ cerez: "JSESSIONID=ikinci" }),
        (e: unknown) => (e as { code?: string }).code === "IS_BUSY");
      const durum = await d.isleyiciler.get("durum")!({ yerel: true }) as { girisSuruyor: boolean };
      assert.equal(durum.girisSuruyor, true);
      await d.isleyiciler.get("durum")!({});
      await assert.rejects(d.isleyiciler.get("durusmalar")!({}), (e: unknown) => (e as { code?: string }).code === "IS_BUSY");
      assert.equal(p.sayac(), 0, "giriş beklerken portala SIFIR istek (keep-alive dahil)");
      await d.isleyiciler.get("giris-iptal")!({});
      await assert.rejects(girisPromise, (e: unknown) => (e as { code?: string }).code === "LOGIN_REQUIRED");
      const iptalSonrasi = await d.isleyiciler.get("durum")!({ yerel: true }) as { girisSuruyor: boolean };
      assert.equal(iptalSonrasi.girisSuruyor, false);
    } finally {
      await temizleHepsi();
    }
  });

  test("art arda 2 'bitti' → oturum silinir, ölü oturum dövülmez", async () => {
    const p = await portalKur({ durum: 401, rc: "SUCCESS" }); // 401 → probe 'bitti'
    const ayar = tmpKok();
    const kokK = tmpKok();
    oturumYaz(ayar.kok);
    const d = daemonKur({
      ayarDir: ayar.kok,
      kok: kokK.kok,
      portalUrl: `http://127.0.0.1:${p.port}`,
      istekAralikMs: 5,
      oturumYenileMs: 400,
      webPort: 0,
    });
    await d.rpc.baslat();
    try {
      await bekle(2500); // tick ~0.4/0.8/1.2/1.6/2.0s: önbellek nedeniyle probe'lar birer tick atlar
      assert.equal(p.sayac(), 2, "iki bitti sonrası dövme durmalı");
      assert.equal(existsSync(join(ayar.kok, "oturum.json")), false, "ölü oturum silinmeli");
      await bekle(900); // iki tick daha
      assert.equal(p.sayac(), 2, "oturum silindikten SONRA hiç istek gitmemeli");
    } finally {
      await d.kapat();
      await p.kapat();
      ayar.temizle();
      kokK.temizle();
    }
  });

  test("oturum yokken yenileyici hiç istek atmaz", async () => {
    const p = await portalKur({ durum: 200, rc: "SUCCESS" });
    const ayar = tmpKok();
    const kokK = tmpKok();
    const d = daemonKur({
      ayarDir: ayar.kok,
      kok: kokK.kok,
      portalUrl: `http://127.0.0.1:${p.port}`,
      istekAralikMs: 5,
      oturumYenileMs: 300,
      webPort: 0,
    });
    await d.rpc.baslat();
    try {
      await bekle(1100);
      assert.equal(p.sayac(), 0, "oturum yokken portala istek gitmemeli");
    } finally {
      await d.kapat();
      await p.kapat();
      ayar.temizle();
      kokK.temizle();
    }
  });
});
