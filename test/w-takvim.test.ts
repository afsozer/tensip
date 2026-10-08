// ── ORKESTRATÖRÜN BAĞIMSIZ KONTROLÜ — P07a takvim çıktısı ───────────────────
//
// Paketin kendi testleri .ics'i kendi ürettiği kurallara göre sınıyor. Buradaki
// ayırt edici nokta şudur: saat, projenin KENDİ saat dilimi tablosuyla değil
// SİSTEMİN IANA veritabanıyla (Intl, tam ICU) karşılaştırılır. Bir duruşmayı
// bir saat kaydırmak, kaçırmak demektir; o yüzden ölçüt dışarıdan gelmeli.
//
// Erteleme ile YENİ CELSE ayrımı da burada: inceleme, geçmişte kalmış bir
// duruşmanın takvim kaydının sessizce yeni tarihe taşındığını bulmuştu.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { takvimUret, type TakvimKaydi, type TakvimDurum } from "../src/store/takvim.js";

const BOS: TakvimDurum = { surum: 1, etkinlikler: [] };
const kayit = (tarihSaat: string, o: Partial<TakvimKaydi> = {}): TakvimKaydi => ({
  tarihSaat,
  dosyaNo: "2026/924",
  yerelBirimAd: "Çamlık İcra Müdürlüğü",
  birimId: "1042",
  islemTuru: 3,
  islemTuruAciklama: "Duruşma",
  dosyaTurKodAciklama: "İcra Dosyası",
  dosyaTaraflari: [{ isim: "SENTETIK", soyad: "MUVEKKIL", sifat: "Alacaklı", isVekil: false }],
  ...o,
});

/** Katlamayı açar; VTIMEZONE alt bileşenlerini DIŞARIDA bırakır. */
function veventSatirlari(ics: string): string[] {
  const acik: string[] = [];
  for (const l of ics.split("\r\n")) {
    if (l.startsWith(" ") && acik.length) acik[acik.length - 1] += l.slice(1);
    else acik.push(l);
  }
  const out: string[] = [];
  let ic = false;
  for (const l of acik) {
    if (l === "BEGIN:VEVENT") ic = true;
    else if (l === "END:VEVENT") ic = false;
    else if (ic) out.push(l);
  }
  return out;
}
const alan = (ics: string, ad: string): string[] =>
  veventSatirlari(ics).filter((l) => l.startsWith(ad));

/** SİSTEMİN tz veritabanına göre o anın Istanbul ofseti, dakika cinsinden. */
function sistemOfsetiDk(yil: number, ay: number, gun: number, saat: number, dk: number): number {
  const b = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Istanbul",
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  // Duvar saatini UTC sanıp Istanbul'da nasıl göründüğüne bakarak ofsetı çöz.
  const varsayilanUtc = Date.UTC(yil, ay - 1, gun, saat, dk);
  const p = Object.fromEntries(b.formatToParts(new Date(varsayilanUtc)).map((x) => [x.type, x.value]));
  const gorunen = Date.UTC(
    Number(p["year"]), Number(p["month"]) - 1, Number(p["day"]),
    Number(p["hour"]) % 24, Number(p["minute"]), Number(p["second"]),
  );
  return (gorunen - varsayilanUtc) / 60000;
}

describe("BAĞIMSIZ KONTROL — P07a takvim çıktısı", () => {
  test("W1 — duvar saati birebir korunur ve TZID taşır (kış ve yaz)", () => {
    const s = takvimUret([kayit("2027-01-15 11:40:00.0"), kayit("2027-07-15 11:40:00.0", { islemTuru: 4 })], {
      simdi: new Date("2026-12-01T09:00:00Z"),
      durum: BOS,
    });
    const ds = alan(s.ics, "DTSTART");
    assert.equal(ds.length, 2, `iki etkinlik bekleniyordu: ${JSON.stringify(ds)}`);
    for (const d of ds) {
      assert.match(d, /^DTSTART;TZID=Europe\/Istanbul:\d{8}T114000$/, `UTC'ye çevrilmiş ya da TZID yok: ${d}`);
      assert.ok(!d.endsWith("Z"), `Z ile bitmemeli: ${d}`);
    }
  });

  test("W2 — bildirilen ofset SİSTEMİN tz veritabanıyla uyuşur", () => {
    const s = takvimUret([kayit("2027-01-15 11:40:00.0"), kayit("2027-07-15 11:40:00.0", { islemTuru: 4 })], {
      simdi: new Date("2026-12-01T09:00:00Z"),
      durum: BOS,
    });
    const ofsetler = [...s.ics.matchAll(/TZOFFSETTO:([+-])(\d{2})(\d{2})/g)].map(
      (m) => (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])),
    );
    assert.ok(ofsetler.length > 0, "VTIMEZONE ofset bildirmiyor");
    // Türkiye 2016'dan beri yıl boyu UTC+3; ikisini de sistemden ölçüp doğrula.
    const kis = sistemOfsetiDk(2027, 1, 15, 11, 40);
    const yaz = sistemOfsetiDk(2027, 7, 15, 11, 40);
    assert.equal(kis, yaz, "sistem yaz saati uyguluyor: tek STANDARD bileşeni yetmez");
    assert.ok(ofsetler.includes(kis), `ics ${ofsetler} diyor, sistem ${kis} dakika diyor`);
  });

  test("W3 — varsayılan çıktıda müvekkil adı yok; seçenek açıkken var", () => {
    const sec = { simdi: new Date("2027-05-01T09:00:00Z"), durum: BOS };
    const kapali = takvimUret([kayit("2027-05-04 10:00:00.0")], sec);
    assert.ok(!kapali.ics.includes("SENTETIK"), "varsayılan çıktıya taraf adı sızdı");
    assert.ok(!kapali.ics.includes("MUVEKKIL"), "varsayılan çıktıya taraf adı sızdı");
    const acik = takvimUret([kayit("2027-05-04 10:00:00.0")], { ...sec, taraflariEkle: true });
    assert.ok(acik.ics.includes("SENTETIK"), "seçenek açıkken taraf adı yazılmalı");
  });

  test("W4 — erteleme GÜNCELLER, geçmiş duruşmanın kaydı yeni celseye TAŞINMAZ", () => {
    const uid = (ics: string): string => alan(ics, "UID:")[0] ?? "";
    const ilk = takvimUret([kayit("2027-03-10 09:15:00.0")], {
      simdi: new Date("2027-03-01T09:00:00Z"), durum: BOS,
    });
    // Duruşma HENÜZ GELMEDİ, tarihi değişti → aynı etkinlik güncellenir.
    const erteleme = takvimUret([kayit("2027-03-18 15:20:00.0")], {
      simdi: new Date("2027-03-01T09:00:00Z"), durum: ilk.durum,
    });
    assert.equal(uid(erteleme.ics), uid(ilk.ics), "erteleme yeni etkinlik doğurdu");
    assert.match(erteleme.ics, /^SEQUENCE:[1-9]/m, "SEQUENCE artmadı: takvim güncellemeyi görmez");
    // Duruşma GEÇTİ, portal yeni celse veriyor → AYRI etkinlik olmalı.
    const yeniCelse = takvimUret([kayit("2027-04-05 10:00:00.0")], {
      simdi: new Date("2027-03-20T09:00:00Z"), durum: ilk.durum,
    });
    assert.notEqual(uid(yeniCelse.ics), uid(ilk.ics), "geçmiş duruşmanın kaydı yeni tarihe taşındı");
    assert.ok(yeniCelse.uyarilar.length > 0, "kullanıcı bu ayrımdan haberdar edilmiyor");
  });
});
