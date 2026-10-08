// Toleranslı şema ayrıştırma testleri

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { satirlariDuzlestir, dosyaSatiriAyristir, evrakSatiriAyristir, birimSatiriAyristir, alanAl } from "../src/uyap/schema.js";
import { Hata } from "../src/core/errors.js";

describe("satirlariDuzlestir", () => {
  test("iç içe dizi düzleştirilir (UYAP [[rows]] sözleşmesi)", () => {
    const d = satirlariDuzlestir([[{ dosyaId: "x" }]]);
    assert.equal(d.length, 1);
  });

  test("çift katman [[ [rows] ]]", () => {
    const d = satirlariDuzlestir([[[{ dosyaId: "a" }, { dosyaId: "b" }]]]);
    assert.equal(d.length, 2);
  });

  test(" obje içindeki alan {tumEvraklar:[...]}", () => {
    const d = satirlariDuzlestir({ tumEvraklar: [{ evrakId: "e1" }, { evrakId: "e2" }], pageTotal: 1 });
    assert.equal(d.length, 2);
  });

  test("dizi olmayan gövde → PORTAL_YANIT_BILINMIYOR", () => {
    assert.throws(() => satirlariDuzlestir({ ham: "değil" }), (e: unknown) => (e as Hata).code === "PORTAL_YANIT_BILINMIYOR");
  });
});

describe("dosyaSatiriAyristir", () => {
  test("standart alanlar", () => {
    const d = dosyaSatiriAyristir({
      dosyaId: '"OPAK"',
      birimAdi: "Test Sulh Hukuk Mahkemesi",
      birimId: "1001",
      esasNo: "2026/928",
      dosyaTur: "Hukuk Dava Dosyası",
      dosyaDurumu: "Açık",
    });
    assert.ok(d);
    assert.equal(d.esasNo, "2026/928");
    assert.equal(d.dosyaTur, "Hukuk Dava Dosyası");
  });

  test("yil+sira ayrı alanlardan kurulur", () => {
    const d = dosyaSatiriAyristir({
      dosyaId: '"OPAK"',
      birimAdi: "X",
      dosyaYil: "2025",
      dosyaSira: "245",
    });
    assert.ok(d);
    assert.equal(d.esasNo, "2025/245");
  });

  test("dosyaId yoksa null", () => {
    assert.equal(dosyaSatiriAyristir({ birimAdi: "X" }), null);
  });
});

describe("evrakSatiriAyristir", () => {
  test("bilinen alan adları", () => {
    const e = evrakSatiriAyristir({
      evrakId: '"EVRAK1"',
      tur: "Cevap Dilekçesi",
      gonderen: "Av. BURAK ŞAKIR",
      tarihSTR: "04/09/2026",
      birimEvrakNo: "6973",
    });
    assert.ok(e);
    assert.equal(e.birimEvrakNo, "6973");
    assert.equal(e.tarih, "04/09/2026");
  });

  test("ek evrak alanları", () => {
    const e = evrakSatiriAyristir({
      evrakId: '"EK1"',
      tur: "Vekaletname Ek Evrak",
      gonderen: "Av. X",
      anaEvrakId: '"ANA1"',
      ekSira: 0,
    });
    assert.ok(e);
    assert.ok(ekEvrakDenetle(e.ham));
  });
});

function ekEvrakDenetle(ham: Record<string, unknown>): boolean {
  return typeof ham["anaEvrakId"] === "string" && (ham["anaEvrakId"] as string).length > 0;
}

describe("birimSatiriAyristir + alanAl", () => {
  test("birim satırı", () => {
    const b = birimSatiriAyristir({ birimId: "1003101", birimAdi: "Çamlık Asliye Hukuk Mahkemesi" });
    assert.ok(b);
    assert.equal(b.birimId, "1003101");
  });

  test("alanAl harf duyarsız", () => {
    assert.equal(alanAl({ DOSYAID: "x" }, ["dosyaId"]), "x");
  });
});
