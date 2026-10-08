// Dosya detay verileri (safahat/taraflar/hesap) testleri.
// Uçlar PAKET-ÇIKARIMI (canlı doğrulama bekliyor) — parser toleranslı:
// düz dizi ve [[{...}]] sarmalayıcısı ikisini de yutar.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { daemonKur } from "../src/server/daemon.js";
import { safahatiGetir, taraflariGetir } from "../src/uyap/dosyadetay.js";
import { satirlariDuzlestir } from "../src/uyap/schema.js";
import { RegistryDepo, caseKeyYap } from "../src/store/registry.js";
import { ManifestDepo } from "../src/store/manifest.js";
import { MockUyap, opakToken } from "./mock-uyap/sunucu.js";
import { OturumDepo } from "../src/uyap/session.js";
import { tmpKok } from "./yardimci.js";

describe("dosyadetay (birim)", () => {
  test("GERÇEK safahat sarmalayıcısı ({safahatlar:[...]}) satırlara açılır", async () => {
    const istemci = {
      json: async () => ({
        durum: 200,
        rc: "SUCCESS",
        // 5 Eyl canlı doğrulanmış gerçek biçim
        govde: JSON.stringify({
          safahatlar: [
            { safahatTarihiSTR: "04.09.2026", safahatTuruAciklama: "Dosyanın Durdurulması", aciklama: "Takibe İtiraz", safahatStatuKodAciklama: "" },
          ],
        }),
      }),
    };
    const satirlar = await safahatiGetir(istemci, "TOKEN");
    assert.equal(satirlar.length, 1);
    assert.equal(satirlar[0]?.safahatTuruAciklama, "Dosyanın Durdurulması");
  });

  test("ÇOK-anahtarlı sarmalayıcı ({safahatlar:[...], ...}) açılır", async () => {
    const istemci = {
      json: async () => ({
        durum: 200,
        rc: "SUCCESS",
        // 5 Eyl canlı: 17,7 KB'lık yanıt tek-anahtar varsayımına takılmıştı
        govde: JSON.stringify({
          safahatlar: [
            { safahatTarihiSTR: "04.09.2026", safahatTuruAciklama: "Tensip Zaptı", aciklama: "(Kabul)" },
          ],
          sonuc: true,
        }),
      }),
    };
    const satirlar = await safahatiGetir(istemci, "TOKEN");
    assert.equal(satirlar.length, 1);
    assert.equal(satirlar[0]?.aciklama, "(Kabul)");
  });

  test("sarmalayıcılı yanıt satırlara açılır", async () => {
    const gelen: unknown[] = [];
    const istemci = {
      json: async (yol: string, govde: unknown) => {
        gelen.push(govde);
        assert.equal(yol, "/dosya_safahat_bilgileri_brd.ajx");
        assert.deepEqual(govde, { dosyaId: "TOKEN" });
        return {
          durum: 200,
          rc: "SUCCESS",
          govde: JSON.stringify([[
            { safahatTarihiSTR: "08.09.2026", safahatTuruAciklama: "Tebligat", aciklama: "Davetiye", safahatStatuKodAciklama: "Tamamlandı" },
          ]]),
        };
      },
    };
    const satirlar = await safahatiGetir(istemci, "TOKEN");
    assert.equal(satirlar.length, 1);
    assert.equal(satirlar[0]?.safahatTuruAciklama, "Tebligat");
  });

  test("sarmalayıcı olmayan düz dizi de yutulur; JSON olmayanı hata", async () => {
    const istemci1 = {
      json: async () => ({ durum: 200, rc: "SUCCESS", govde: JSON.stringify([{ isim: "AYŞE", sifat: "DAVACI" }]) }),
    };
    const t = await taraflariGetir(istemci1, "TOKEN");
    assert.equal(t.length, 1);
    assert.equal(t[0]?.isim, "AYŞE");
    const istemci2 = { json: async () => ({ durum: 200, rc: "SUCCESS", govde: "<html>giriş</html>" }) };
    await assert.rejects(safahatiGetir(istemci2, "TOKEN"), (e: unknown) => (e as { code?: string }).code === "PORTAL_YANIT_BILINMIYOR");
  });

  test("bilinmeyen sarmalayıcı SESLI hata verir (canlı doğrulamada yakalanır)", () => {
    assert.throws(() => satirlariDuzlestir({ beklenmedik: true }), (e: unknown) => (e as { code?: string }).code === "PORTAL_YANIT_BILINMIYOR");
  });
});

describe("safahat/taraflar/hesap (daemon işleyicileri)", () => {
  test("caseKey → manifest.dosyaId → uç; klonlanmamış dava NOT_FOUND", async () => {
    const kurulum = {
      birimler: [{ birimId: "3000", birimAdi: "CLI Test Sulh Hukuk Mahkemesi", yargiTuru: "0" }],
      davalar: [
        {
          dosyaId: opakToken("detay-dosya"),
          birimAdi: "CLI Test Sulh Hukuk Mahkemesi",
          birimId: "3000",
          esasNo: "2026/900",
          dosyaTur: "Hukuk Dava Dosyası",
          dosyaDurum: "Açık",
          yargiTuru: "0",
          evraklar: [],
        },
      ],
    };
    const mock = new MockUyap(kurulum);
    const port = await mock.baslat();
    const ayar = tmpKok();
    const kokK = tmpKok();
    new OturumDepo(ayar.kok).yaz({
      surum: 1,
      cookie: "JSESSIONID=detay-test-oturum",
      loginAt: new Date().toISOString(),
      yontem: "manuel",
    });
    // registry + manifest fixture: klonlanmış dava
    const kayit = {
      caseKey: caseKeyYap("CLI Test Sulh Hukuk Mahkemesi", "2026/900"),
      portal: "avukat" as const,
      kaynak: [],
      dosyaNo: "2026/900",
      birimAdi: "CLI Test Sulh Hukuk Mahkemesi",
      birimId: "3000",
      group: "Hukuk",
      kod: "",
      yargiTuru: "0",
      isIcra: false,
      isCbs: false,
      kapsam: "hepsi",
      portalGoruldu: new Date().toISOString(),
      klonYolu: join(kokK.kok, "test-dava"),
    };
    const reg = new RegistryDepo(join(ayar.kok, "davalarim.json"));
    reg.koy(kayit);
    mkdirSync(kayit.klonYolu!, { recursive: true });
    writeFileSync(
      join(kayit.klonYolu!, "uyap-project.json"),
      JSON.stringify({ surum: 1, dosyaId: opakToken("detay-dosya"), evraklar: [] })
    );
    const d = daemonKur({
      ayarDir: ayar.kok,
      kok: kokK.kok,
      portalUrl: `http://127.0.0.1:${port}`,
      istekAralikMs: 5,
      webPort: 0,
    });
    await d.rpc.baslat();
    try {
      const s = (await d.isleyiciler.get("safahat")?.({ caseKey: kayit.caseKey })) as { adet: number; satirlar: { safahatTuruAciklama: string }[] };
      assert.equal(s.adet, 2);
      assert.equal(s.satirlar[0]?.safahatTuruAciklama, "Tebligat");
      const once = mock.istekler.length;
      await d.isleyiciler.get("safahat")!({ caseKey: kayit.caseKey });
      assert.equal(mock.istekler.length, once, "önbellek için token araması da yapılmamalı");
      const t = (await d.isleyiciler.get("taraflar")?.({ caseKey: kayit.caseKey })) as { adet: number };
      assert.equal(t.adet, 2);
      const h = (await d.isleyiciler.get("hesap")?.({ caseKey: kayit.caseKey })) as { adet: number };
      assert.equal(h.adet, 1);
      // gerçekten porta gitti mi (yol kaydı)
      assert.ok(mock.istekler.some((i) => i.yol.includes("dosya_safahat_bilgileri_brd")));
      assert.ok(mock.istekler.some((i) => i.yol.includes("dosya_taraf_bilgileri_brd")));
      assert.ok(mock.istekler.some((i) => i.yol.includes("dosya_hesap_bilgileri")));
      // klonlanmamış dava → NOT_FOUND
      const olmayan = caseKeyYap("Yok Böyle Mahkeme", "1999/1");
      await assert.rejects(
        d.isleyiciler.get("safahat")?.({ caseKey: olmayan }) as Promise<unknown>,
        (e: unknown) => (e as { code?: string }).code === "NOT_FOUND"
      );
      // manifest.dosyaId gerçekten uçlara gitti mi (gövde JSON — escape'li
      // token düz includes ile bulunmaz, parse ederek karşılaştır)
      const beklenen = opakToken("detay-dosya");
      assert.ok(
        mock.istekler.some((i) => {
          try {
            return (JSON.parse(i.govde) as { dosyaId?: string }).dosyaId === beklenen;
          } catch {
            return false;
          }
        })
      );
      // TOKEN ROTASYONU: manifest'e bayat token yaz → safahat taze aramayla
      // yenilemeli ve manifest'i güncellemeli (5 Eyl canlı bulgusu)
      const mYol = join(kayit.klonYolu!, "uyap-project.json");
      writeFileSync(mYol, JSON.stringify({ surum: 1, dosyaId: "BAYAT-TOKEN", evraklar: [] }));
      const tekrar = (await d.isleyiciler.get("taraflar")?.({ caseKey: kayit.caseKey })) as { adet: number };
      assert.equal(tekrar.adet, 2, "bayat tokenla rağmen taze arama kurtarmalı");
      const guncel = JSON.parse(readFileSync(mYol, "utf8")) as { dosyaId: string };
      assert.equal(guncel.dosyaId, beklenen, "manifest taze tokenla güncellenmeli");
    } finally {
      await d.kapat();
      await mock.durdur();
      ayar.temizle();
      kokK.temizle();
    }
  });
});

test("detay parser hata rc ve tanınmayan dizileri veri saymaz", async () => {
  for (const yanit of [
    { durum: 200, rc: "ERROR", govde: "[]" },
    { durum: 200, rc: "SUCCESS", govde: '{"warnings":[],"other":[]}' },
    { durum: 302, rc: "SUCCESS", govde: "[]" },
  ]) await assert.rejects(safahatiGetir({ json: async () => yanit }, "test"));
});
