// Doğrulanmış portal davranışına özel testler:
//  • uzantı content-type'tan türetilir (octet-stream → UDF koklama, zip, tif)
//  • text/html giriş sayfası → OTURUM_BITTI
//  • text/plain → yuklenmemis sorun kaydı, ham dosya ASLA yazılmaz
//  • grup objesi {ana:[...], ekler:[...]} düzleştirilir

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MockUyap, opakToken, type MockDava } from "./mock-uyap/sunucu.js";
import { daemonKur, type Daemon } from "../src/server/daemon.js";
import { makeUdf, tmpKok } from "./yardimci.js";
import { satirlariDuzlestir } from "../src/uyap/schema.js";

function mockDavaV2(): MockDava {
  const d = opakToken("v2-dosya");
  return {
    dosyaId: d,
    birimAdi: "V2 Test Mahkemesi",
    birimId: "7000",
    esasNo: "2026/99",
    dosyaTur: "Hukuk Dava Dosyası",
    dosyaDurum: "Açık",
    yargiTuru: "0",
    evraklar: [
      {
        evrakId: opakToken("v2-udf-bilinmeyen-ct"),
        tur: "Cevap Dilekçesi",
        gonderen: "Av. V2",
        tip: "GLN",
        tarih: "01/09/2026",
        birimEvrakNo: "10",
        durum: "yuklu",
        contentTipi: "application/octet-stream",
        icerik: makeUdf(["CEVAP DİLEKÇESİ", "Uzantı koklanacak."]),
      },
      {
        evrakId: opakToken("v2-zip"),
        tur: "Deliller Dosyası",
        gonderen: "Av. V2",
        tip: "GLN",
        tarih: "02/09/2026",
        birimEvrakNo: "11",
        durum: "yuklu",
        contentTipi: "application/zip",
        icerik: Buffer.from("PK\x03\x04ZIP_ICERIK_MOCK"),
      },
      {
        evrakId: opakToken("v2-yuklenmemis"),
        tur: "Beyanname",
        gonderen: "Av. V2",
        tip: "GLN",
        tarih: "03/09/2026",
        birimEvrakNo: "12",
        durum: "yuklenmemis",
        contentTipi: "text/plain; charset=utf-8",
        icerik: Buffer.from("Evrak UYAP sistemine yüklenmemiş."),
      },
    ],
  };
}

describe("doğrulanmış portal davranışları", () => {
  const mock = new MockUyap({
    birimler: [{ birimId: "7000", birimAdi: "V2 Test Mahkemesi", yargiTuru: "0" }],
    davalar: [mockDavaV2()],
  });
  const ayar = tmpKok();
  const kok = tmpKok();
  let daemon: Daemon;

  before(async () => {
    await mock.baslat();
    daemon = daemonKur({
      ayarDir: ayar.kok,
      kok: kok.kok,
      portalUrl: mock.adres(),
      istekAralikMs: 5,
      gunlukTavan: 100,
    });
    await daemon.rpc.baslat();
  });

  after(async () => {
    await daemon.kapat();
    await mock.durdur();
    ayar.temizle();
    kok.temizle();
  });

  const h = (ad: string) => daemon.isleyiciler.get(ad)!;
  async function isBekle(isId: string): Promise<Record<string, unknown>> {
    for (let i = 0; i < 200; i++) {
      const is = (await h("is")({ isId })) as { durum: string };
      if (["hazir", "eksikli", "hata", "iptal", "duraklatildi"].includes(is.durum)) return is;
      await new Promise((c) => setTimeout(c, 25));
    }
    throw new Error("iş zaman aşımı");
  }

  test("grup objesi {ana, ekler} düzleştirilir", () => {
    const d = satirlariDuzlestir({
      tumEvraklar: { ana: [{ evrakId: "a1" }], ekler: [{ evrakId: "e1" }] },
      pageTotal: 1,
    });
    assert.equal(d.length, 2);
  });

  test("klonla: uzantı content-type'tan; text/plain yazılmaz", async () => {
    await h("giris")({ cerez: "JSESSIONID=v2session123; x=1" });
    const son = (await h("klonla")({
      birim: "V2 Test Mahkemesi",
      esas: "2026/99",
      kapsam: "hepsi",
      avukat: "V2 AVUKAT",
    })) as { isId: string };
    const is = await isBekle(son.isId);
    assert.equal(is.durum, "eksikli", JSON.stringify(is.hata));

    const kayit = (await h("davalar")({})) as { davalar: { klonYolu?: string }[] };
    const kl = kayit.davalar[0]?.klonYolu ?? "";

    // octet-stream ama UDF → .udf (koklama)
    const dilekce = join(kl, "_kaynak/evraklar/Gelen/02-Dilekceler/2026-09-01_Cevap Dilekçesi_10.udf");
    assert.ok(existsSync(dilekce), "udf koklanmalı");
    assert.ok(existsSync(join(kl, "evraklar/Gelen/02-Dilekceler/2026-09-01_Cevap Dilekçesi_10.md")));

    // application/zip → .zip
    assert.ok(
      existsSync(join(kl, "_kaynak/evraklar/Gelen/08-Ekler-Diger/2026-09-02_Deliller Dosyası_11.zip")),
      "zip uzantısı"
    );

    // text/plain evrak: klasörde OLMAMALI, sorun kaydı OLMALI
    const sorunlar = (await h("sorunlar")({})) as { acik: { tur: string; hata: string }[] };
    assert.ok(sorunlar.acik.some((s) => s.tur === "yuklenmemis"), "yuklenmemis sorun kaydı");
    const tumDosyalar = readdirSync(join(kl, "_kaynak/evraklar/Gelen/02-Dilekceler"));
    assert.ok(!tumDosyalar.some((ad) => ad.includes("Beyanname")), "text/plain yazılmamalı");

    // manifest: 2 kayıt (yuklenmemis hariç)
    const m = JSON.parse(readFileSync(join(kl, "uyap-project.json"), "utf8"));
    assert.equal((m.evraklar as unknown[]).length, 2);
  });

  test("text/html giriş sayfası → iş OTURUM_BITTI ile durur", async () => {
    // mock'a giriş sayfası döndüren evrak ekle (oturum hâlâ GEÇERLİ — belge
    // yerine HTML döndüğü için öldüğü anlaşılır)
    const d = mock.davalarBul("2026/99", "7000")!;
    d.evraklar.push({
      evrakId: opakToken("v2-oturum-olu"),
      tur: "Karar",
      gonderen: "V2 Test Mahkemesi",
      tip: "GLN",
      tarih: "04/09/2026",
      birimEvrakNo: "13",
      durum: "giris-sayfasi",
      contentTipi: "text/html; charset=UTF-8",
      icerik: Buffer.from("", "utf8"),
    });
    const son = (await h("esitle")({ caseKey: "V2 Test Mahkemesi\u00002026/99" })) as { isId: string };
    const is = await isBekle(son.isId);
    assert.equal(is.durum, "hata");
    assert.equal((is.hata as { code: string }).code, "OTURUM_BITTI");
  });
});
