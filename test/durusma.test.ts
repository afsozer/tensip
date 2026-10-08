// Duruşma takvimi testleri — uç sözleşmesi 5 Eyl 2026'da GERÇEK portalden
// doğrulandı (SPA paketi + tek canlı çağrı); mock bilinçli karışık sırada
// döner → parser kronolojik sıralamalı.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { daemonKur } from "../src/server/daemon.js";
import { durusmalariSorgula, durusmaTarihiBiçimle } from "../src/uyap/durusma.js";
import { MockUyap, opakToken, type MockKurulum } from "./mock-uyap/sunucu.js";
import { OturumDepo } from "../src/uyap/session.js";
import { tmpKok } from "./yardimci.js";

describe("durusmalariSorgula (birim)", () => {
  test("istek gövdesi dd.MM.yyyy, satırlar kronolojik sıralanır", async () => {
    const gelenGovdeler: string[] = [];
    const istemci = {
      json: async (yol: string, govde: unknown) => {
        assert.equal(yol, "/avukat_durusma_sorgula_brd.ajx");
        gelenGovdeler.push(JSON.stringify(govde));
        return {
          durum: 200,
          rc: "SUCCESS",
          // bilinçli TERS sırada iki satır (09 sonra 08) — parser düzeltmeli
          govde: JSON.stringify([
            {
              kayitId: 1,
              dosyaId: opakToken("d1"),
              dosyaNo: "2026/900",
              dosyaTurKod: 0,
              dosyaTurKodAciklama: "Hukuk Dava Dosyası",
              birimId: "3000",
              yerelBirimAd: "Test Sulh Hukuk Mahkemesi",
              tarihSaat: "2026-09-09 09:30:00.0",
              islemTuru: 0,
              islemTuruAciklama: "Duruşma",
              islemSonucuAciklama: "Günü Verildi",
              dosyaTaraflari: [{ isim: "AYŞE", soyad: "YILMAZ", sifat: "DAVACI", isVekil: true }],
            },
            {
              kayitId: 2,
              dosyaId: opakToken("d2"),
              dosyaNo: "2026/901",
              birimId: "3000",
              yerelBirimAd: "Test Sulh Hukuk Mahkemesi",
              tarihSaat: "2026-09-08 10:00:00.0",
              islemTuru: 1,
              islemTuruAciklama: "Keşif",
              islemSonucuAciklama: "Günü Verildi",
              dosyaTaraflari: [],
            },
          ]),
        };
      },
    };
    const satirlar = await durusmalariSorgula(istemci, 7);
    // tarih biçimi: dd.MM.yyyy
    const govde = JSON.parse(gelenGovdeler[0] ?? "{}") as { baslangicTarihi: string; bitisTarihi: string };
    assert.match(govde.baslangicTarihi, /^\d{2}\.\d{2}\.\d{4}$/);
    assert.match(govde.bitisTarihi, /^\d{2}\.\d{2}\.\d{4}$/);
    // kronolojik: en yakın önce
    assert.equal(satirlar.length, 2);
    assert.equal(satirlar[0]?.islemTuruAciklama, "Keşif");
    assert.equal(satirlar[1]?.dosyaNo, "2026/900");
    // satır eşlemesi
    assert.deepEqual(satirlar[1]?.dosyaTaraflari?.[0], { isim: "AYŞE", soyad: "YILMAZ", sifat: "DAVACI", isVekil: true });
  });

  test("durusmaTarihiBiçimle: gün/ay iki haneli", () => {
    assert.equal(durusmaTarihiBiçimle(new Date(2026, 8, 5)), "05.09.2026");
    assert.equal(durusmaTarihiBiçimle(new Date(2026, 0, 14)), "14.01.2026");
  });

  test("dizi olmayan yanıt → PORTAL_YANIT_BILINMIYOR", async () => {
    const istemci = {
      json: async () => ({ durum: 200, rc: "SUCCESS", govde: '{"tablo":[]}' }),
    };
    await assert.rejects(durusmalariSorgula(istemci, 7), (e: unknown) => (e as { code?: string }).code === "PORTAL_YANIT_BILINMIYOR");
  });
});

describe("durusmalar (daemon işleyicisi)", () => {
  test("satırları döner + 10 dk önbellek ikinci çağrıda portala gitmez", async () => {
    const kurulum: MockKurulum = {
      birimler: [{ birimId: "3000", birimAdi: "CLI Test Sulh Hukuk Mahkemesi", yargiTuru: "0" }],
      davalar: [],
    };
    const mock = new MockUyap(kurulum);
    const port = await mock.baslat();
    const ayar = tmpKok();
    const kokK = tmpKok();
    // oturum: manuel yaz (girisiDogrula gerçek porta gider; mock'ta oturum
    // çerezi — MockUyap.oturumGecerliMi kendi regexiyle doğrular)
    new OturumDepo(ayar.kok).yaz({
      surum: 1,
      cookie: "JSESSIONID=durusma-test-oturum",
      loginAt: new Date().toISOString(),
      yontem: "manuel",
    });
    const d = daemonKur({
      ayarDir: ayar.kok,
      kok: kokK.kok,
      portalUrl: `http://127.0.0.1:${port}`,
      istekAralikMs: 5,
      webPort: 0,
    });
    await d.rpc.baslat();
    try {
      type Yanit = {
        adet: number;
        olcumAt: string;
        onbellekten: boolean;
        durusmalar: { dosyaNo: string; islemTuruAciklama: string }[];
      };
      const birinci = (await d.isleyiciler.get("durusmalar")?.({})) as Yanit;
      assert.equal(birinci.adet, 2);
      assert.equal(birinci.durusmalar[0]?.islemTuruAciklama, "Keşif"); // kronolojik
      // YANIT VERİNİN YAŞINI TAŞIR: ekran tıklama anını "son sorgu" diye
      // yazarsa 10 dk'lık önbellekten gelen liste taze görünür.
      assert.equal(birinci.onbellekten, false, "ilk çağrı önbellekten sayıldı");
      assert.ok(Number.isFinite(Date.parse(birinci.olcumAt)), birinci.olcumAt);
      const ikinci = (await d.isleyiciler.get("durusmalar")?.({})) as Yanit;
      assert.equal(ikinci.adet, 2);
      assert.equal(ikinci.onbellekten, true, "önbellekten gelen yanıt taze diye işaretlendi");
      assert.equal(
        ikinci.olcumAt,
        birinci.olcumAt,
        "önbellekten dönen veri YENİ ölçüm zamanı gösteriyor",
      );
      const durusmaIstekleri = mock.istekler.filter((i) => i.yol.includes("avukat_durusma_sorgula"));
      assert.equal(durusmaIstekleri.length, 1, "önbellek ikinci çağrıda portala gitmemeli");
      await Promise.all([1, 2, 3].map(() => d.isleyiciler.get("durusmalar")!({ gun: 31 })));
      assert.equal(mock.istekler.filter((i) => i.yol.includes("avukat_durusma_sorgula")).length, 2);
      d.oturum.cikis();
      d.oturum.girisYap("JSESSIONID=yeni-durusma", "manuel");
      await d.isleyiciler.get("durusmalar")!({ gun: 31 });
      assert.equal(mock.istekler.filter((i) => i.yol.includes("avukat_durusma_sorgula")).length, 3);
      // oturumsuz: giris_gerekiyor
      new OturumDepo(ayar.kok).sil();
      await assert.rejects(
        d.isleyiciler.get("durusmalar")?.({}) as Promise<unknown>,
        (e: unknown) => (e as { code?: string }).code === "LOGIN_REQUIRED"
      );
    } finally {
      await d.kapat();
      await mock.durdur();
      ayar.temizle();
      kokK.temizle();
    }
  });
});
