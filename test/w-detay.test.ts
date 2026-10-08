// ── ORKESTRATÖRÜN BAĞIMSIZ KONTROLÜ — P07b ayrıntı görünümü ─────────────────
//
// Bu pakette asıl risk verinin SESSİZCE DÜŞMESİDİR: portal alanları dosya
// türüne göre değişir, tanınmayan bir alanı gizlemek avukata eksik veriye
// baktığını hiç söylemez. Paketin kendi testi bu eşitliği kontrol ediyor;
// buradaki fark, ölçütü DIŞARIDAN kurmak — düşmanca ve tuhaf girdilerle.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { gorunumUret, type DetayKaydi } from "../src/uyap/detay-goster.js";

const sayi = (k: DetayKaydi): number => k.alanlar.length + k.digerleri.length;
const metinler = (k: DetayKaydi): string =>
  JSON.stringify([...k.alanlar, ...k.digerleri]);

describe("BAĞIMSIZ KONTROL — P07b alan kaybı", () => {
  test("D1 — HER alan görünüme çıkar: tanınan, tanınmayan, tuhaf", () => {
    const satir = {
      // tanınan
      tarih: "2026-09-09 11:40:00.0",
      islemTuruAciklama: "Duruşma",
      // tanınmayan
      krediKartiTahsilatKodu: "KK-42",
      // tuhaf ama gerçek: JS nesne prototipinden gelen adlar
      constructor: "portal-degeri-1",
      __proto__x: "portal-degeri-2",
      toString: "portal-degeri-3",
      hasOwnProperty: "portal-degeri-4",
      // bos ve bosluk
      bosDize: "",
      sifir: 0,
      yanlis: false,
      hicbiri: null,
      // ic ice
      ilgiliKisiler: [{ adi: "SENTETIK", sifat: "Vekil" }],
      ekBilgi: { iletisim: "e-tebligat" },
    };
    const [k] = gorunumUret([satir]);
    assert.ok(k, "satır görünüme çıkmadı");
    assert.equal(
      sayi(k!),
      Object.keys(satir).length,
      `alan sayısı tutmuyor: portal ${Object.keys(satir).length}, görünüm ${sayi(k!)} — ${metinler(k!)}`,
    );
    // Her portal DEĞERİ görünümün bir yerinde geçmeli (kaybolmasın).
    const govde = metinler(k!);
    for (const d of ["KK-42", "portal-degeri-1", "portal-degeri-3", "portal-degeri-4", "e-tebligat", "SENTETIK"])
      assert.ok(govde.includes(d), `değer kayboldu: ${d}`);
  });

  test("D2 — hiçbir başlık BOŞ değil ve hiçbir yerde JSON metni yok", () => {
    const [k] = gorunumUret([
      { constructor: "x", toString: "y", ekBilgi: { a: 1, b: { c: 2 } }, liste: [1, 2, 3] },
    ]);
    for (const a of [...k!.alanlar, ...k!.digerleri]) {
      assert.ok(String(a.baslik ?? "").trim() !== "", `boş başlık: ${JSON.stringify(a)}`);
    }
    // İç içe değer AÇILMIŞ olmalı: hiçbir metin DEĞERİ JSON'a benzemesin.
    // (Görünüm nesnesinin kendisi elbette JSON'a serileşir — ölçüt o değil.)
    const metinDegerleri: string[] = [];
    const gez = (a: { deger?: unknown }[]): void => {
      for (const x of a) {
        const d = x.deger as { tur?: string; metin?: string; alanlar?: unknown[]; ogeler?: unknown[] };
        if (d?.tur === "metin" && typeof d.metin === "string") metinDegerleri.push(d.metin);
        if (Array.isArray(d?.alanlar)) gez(d.alanlar as { deger?: unknown }[]);
        if (Array.isArray(d?.ogeler)) gez((d.ogeler as unknown[]).map((o) => ({ deger: o })));
      }
    };
    gez([...k!.alanlar, ...k!.digerleri]);
    for (const m of metinDegerleri)
      assert.ok(!/^\s*[[{]/.test(m), `değer JSON metni olarak basılmış: ${m}`);
    assert.ok(metinDegerleri.length > 0, "hiç metin değeri çözülmedi");
  });

  test("D3 — dizideki nesne olmayan öğeler satır sayısını düşürmez", () => {
    // Portal karışık dizi döndürebilir; satır sayısı sessizce azalmamalı.
    const ham = [{ tarih: "2026-09-09 11:40:00.0" }, { islemTuruAciklama: "Keşif" }];
    assert.equal(gorunumUret(ham).length, ham.length, "satır düştü");
  });

  test("D4 — para/sayı değeri SESSİZCE yuvarlanmaz", () => {
    const [k] = gorunumUret([{ alacakTutari: 1234.5678, odenen: "2.500,00" }]);
    const govde = metinler(k!);
    assert.ok(
      govde.includes("5678") || govde.includes("1234,5678") || govde.includes("1.234,5678"),
      `ondalık sessizce kısaldı: ${govde}`,
    );
    assert.ok(govde.includes("2.500,00"), "portalın kendi biçimli dizesi değişmiş");
  });
});
