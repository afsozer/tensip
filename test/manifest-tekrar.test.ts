import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpKok, makeUdf } from "./yardimci.js";
import { MockUyap, opakToken, type MockDava } from "./mock-uyap/sunucu.js";
import { daemonKur } from "../src/server/daemon.js";
import { ManifestDepo } from "../src/store/manifest.js";

test("eski oturumdan aynı dosyaya bakan tekrarlar yedeklenir; eşitleme yeni kopya üretmez", async () => {
  const ayar = tmpKok(),
    kok = tmpKok();
  const dava: MockDava = {
    dosyaId: opakToken("duplicate-case"),
    birimAdi: "Test Mahkemesi",
    birimId: "7000",
    esasNo: "2026/99",
    dosyaTur: "Hukuk Dava Dosyası",
    dosyaDurum: "Açık",
    yargiTuru: "0",
    evraklar: [
      {
        evrakId: opakToken("current-document"),
        tur: "Dilekçe",
        gonderen: "Test",
        tip: "GLN",
        tarih: "01/09/2026",
        birimEvrakNo: "42",
        durum: "yuklu",
        contentTipi: "application/octet-stream",
        icerik: makeUdf(["Belge değişmedi."]),
      },
    ],
  };
  const mock = new MockUyap({
    birimler: [{ birimId: "7000", birimAdi: dava.birimAdi, yargiTuru: "0" }],
    davalar: [dava],
  });
  await mock.baslat();
  const d = daemonKur({
    ayarDir: ayar.kok,
    kok: kok.kok,
    portalUrl: mock.adres(),
    istekAralikMs: 1,
    oturumYenileMs: 0,
  });
  async function bekle(id: string) {
    for (let i = 0; i < 300; i++) {
      const is = d.orkestrator.isGetir(id)!;
      if (["hazir", "hata"].includes(is.durum)) {
        assert.equal(is.durum, "hazir", JSON.stringify(is.hata));
        return is;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("İş bitmedi");
  }
  try {
    await d.rpc.baslat();
    d.oturum.girisYap("JSESSIONID=test", "manuel");
    const ilk = (await d.isleyiciler.get("klonla")!({
      birim: dava.birimAdi,
      esas: dava.esasNo,
    })) as { isId: string };
    await bekle(ilk.isId);
    const kayit = d.registry.oku().davalar[0]!;
    const depo = new ManifestDepo(join(kayit.klonYolu!, "uyap-project.json"));
    const m = depo.oku()!;
    const belge = m.evraklar[0]!;
    const ham = readFileSync(join(kayit.klonYolu!, belge.path));
    // Canlı arşivdeki biçim: yalnız evrakId farklı, aynı kaynak ve dönüşüm.
    // P15b: kopya AYRICA farklı bir `indirmeDamgasi` taşır — iki kayıt farklı
    // eşitlemelerde inmiş olabilir. Damga tekilleştirme anahtarına GİRSEYDİ bu
    // ikisi artık birleşmez ve manifest'te mükerrer kayıt birikirdi.
    m.evraklar.push({
      ...belge,
      evrakId: opakToken("previous-session-document"),
      indirmeDamgasi: { esitlemeId: "es-eski", at: "2026-01-01T00:00:00.000Z", tur: "yeni" as const },
    });
    depo.yaz(m);
    kayit.sonEvrakSayisi = 2;
    d.registry.koy(kayit);
    for (let i = 0; i < 2; i++) {
      const is = d.orkestrator.esitleBaslat(kayit.caseKey);
      const son = await bekle(is.isId);
      assert.equal((son.sonuc as { yeniEvrak: number }).yeniEvrak, 0);
      assert.equal(depo.oku()!.evraklar.length, 1);
      assert.equal(d.registry.oku().davalar[0]!.sonEvrakSayisi, 1);
      assert.deepEqual(readFileSync(join(kayit.klonYolu!, belge.path)), ham);
    }
    const yedekler = readdirSync(kayit.klonYolu!).filter((x) =>
      x.startsWith("uyap-project.yedek-"),
    );
    assert.equal(yedekler.length, 1);
    assert.equal(
      JSON.parse(readFileSync(join(kayit.klonYolu!, yedekler[0]!), "utf8"))
        .evraklar.length,
      2,
    );
  } finally {
    await d.kapat();
    await mock.durdur();
    ayar.temizle();
    kok.temizle();
  }
});
