// P07a — ajanda ekranı + Mac Takvim'e aktarma.
//
// Bu dosya iki katmanı sınar:
//   (1) `src/store/takvim.ts` — .ics üreten SAF motor (dosya sistemi yok).
//   (2) `web/ajanda.js` — ekranın SAF üreticileri (gün grupları, arşiv
//       eşleşmesi, satır HTML'i). Olay bağlama ve tıklama KAPSAM DIŞIDIR;
//       onun tek kanıtı elle UI kontrolüdür.
//
// .ics doğrulaması "gözle baktım" DEĞİLDİR: aşağıdaki `icsCoz` bağımsız bir
// ayrıştırıcıdır (katlamayı açar, satır satır sözleşmeyi ölçer) ve üretici
// koddan hiçbir şey ödünç almaz.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  duvarEkle,
  gunMetni,
  icsKacir,
  icsKatla,
  kimlikSadelestir,
  simdiDuvar,
  takvimUret,
  tarihSaatCoz,
  TZID,
  uidTabani,
  utcDamga,
  VARSAYILAN_SURE_DK,
  type TakvimDurum,
  type TakvimKaydi,
} from "../src/store/takvim.js";

const {
  tarihCoz,
  gunGruplari,
  gunEtiketi,
  davaEsle,
  ajandaHTML,
  aktarmaKaydi,
  aktarmaOzetiHTML,
  sorguZamaniMetni,
} = await import(new URL("../../web/ajanda.js", import.meta.url).href);

/* ── bağımsız .ics ayrıştırıcı (üreticiden bir şey ödünç almaz) ─────────── */

interface Ozellik {
  ad: string;
  parametreler: string;
  deger: string;
}

function icsCoz(ics: string): {
  fiziksel: string[];
  ozellikler: Ozellik[];
  bilesenler: string[];
  veventler: Map<string, string>[];
} {
  assert.ok(ics.endsWith("\r\n"), "dosya CRLF ile bitmeli");
  const crlfsiz = ics.replace(/\r\n/g, "");
  assert.ok(!crlfsiz.includes("\n"), "yalnız LF taşıyan satır var");
  assert.ok(!crlfsiz.includes("\r"), "yalnız CR taşıyan satır var");
  const fiziksel = ics.slice(0, -2).split("\r\n");
  for (const s of fiziksel)
    assert.ok(
      Buffer.byteLength(s, "utf8") <= 75,
      `satır 75 okteti aşıyor (${Buffer.byteLength(s, "utf8")}): ${s.slice(0, 40)}`,
    );
  // katlamayı aç: devam satırı tek boşlukla başlar
  const mantiksal: string[] = [];
  for (const s of fiziksel) {
    if ((s.startsWith(" ") || s.startsWith("\t")) && mantiksal.length)
      mantiksal[mantiksal.length - 1] += s.slice(1);
    else mantiksal.push(s);
  }
  const ozellikler: Ozellik[] = [];
  const yigin: string[] = [];
  const bilesenler: string[] = [];
  const veventler: Map<string, string>[] = [];
  let acikVevent: Map<string, string> | null = null;
  for (const satir of mantiksal) {
    const m = /^([A-Za-z0-9-]+)((?:;[^:]*)?):([\s\S]*)$/.exec(satir);
    assert.ok(m, `özellik satırı biçimi bozuk: ${satir.slice(0, 60)}`);
    const ad = m![1]!.toUpperCase();
    const ozellik = { ad, parametreler: m![2]!, deger: m![3]! };
    ozellikler.push(ozellik);
    if (ad === "BEGIN") {
      yigin.push(ozellik.deger);
      bilesenler.push(ozellik.deger);
      if (ozellik.deger === "VEVENT") acikVevent = new Map();
    } else if (ad === "END") {
      assert.equal(yigin.pop(), ozellik.deger, "BEGIN/END eşleşmiyor");
      if (ozellik.deger === "VEVENT" && acikVevent) {
        veventler.push(acikVevent);
        acikVevent = null;
      }
    } else if (acikVevent) {
      acikVevent.set(ad + ozellik.parametreler, ozellik.deger);
      acikVevent.set(ad, ozellik.deger);
    }
  }
  assert.equal(yigin.length, 0, "kapanmamış bileşen var");
  return { fiziksel, ozellikler, bilesenler, veventler };
}

/** TEXT değerini geri açar; kaçırmanın tersi. */
function textAc(deger: string): string {
  return deger.replace(/\\([\\;,nN])/g, (_, c: string) =>
    c === "n" || c === "N" ? "\n" : c,
  );
}

/* ── sentetik veri (müvekkil verisi DEĞİL) ─────────────────────────────── */

const SIMDI = new Date("2026-09-13T15:04:05.000Z");

function kayit(ek: Partial<TakvimKaydi> = {}): TakvimKaydi {
  return {
    tarihSaat: "2026-09-09 11:40:00.0",
    dosyaNo: "2026/918",
    yerelBirimAd: "Sentetik 1. İş Mahkemesi",
    birimId: "7000",
    islemTuru: 0,
    islemTuruAciklama: "Duruşma",
    islemSonucuAciklama: "Günü Verildi",
    dosyaTurKodAciklama: "Hukuk Dava Dosyası",
    dosyaTaraflari: [
      { isim: "SENTETİK", soyad: "DAVACIOĞLU", sifat: "DAVACI", isVekil: false },
    ],
    ...ek,
  };
}

const uret = (kayitlar: TakvimKaydi[], sec: Record<string, unknown> = {}) =>
  takvimUret(kayitlar, { simdi: SIMDI, ...sec });

/* ── 1. biçim sözleşmesi ───────────────────────────────────────────────── */

describe("P07a .ics biçim sözleşmesi", () => {
  test("KABUL 7 — üretilen dosya satır satır geçerli", () => {
    const sonuc = uret([kayit(), kayit({ tarihSaat: "2026-09-10 09:05:00.0", dosyaNo: "2026/119" })]);
    const c = icsCoz(sonuc.ics);
    assert.equal(c.ozellikler[0]?.ad, "BEGIN");
    assert.equal(c.ozellikler[0]?.deger, "VCALENDAR");
    assert.equal(c.ozellikler.at(-1)?.deger, "VCALENDAR");
    assert.equal(c.ozellikler.at(-1)?.ad, "END");
    const oz = (ad: string) => c.ozellikler.find((o) => o.ad === ad)?.deger;
    assert.equal(oz("VERSION"), "2.0");
    assert.match(oz("PRODID") ?? "", /Tensip/);
    assert.ok(c.bilesenler.includes("VTIMEZONE"), "VTIMEZONE bloğu yok");
    assert.equal(c.veventler.length, 2);
    for (const e of c.veventler) {
      for (const gerekli of ["UID", "DTSTAMP", "DTSTART", "DTEND", "SUMMARY", "SEQUENCE"])
        assert.ok(e.has(gerekli), `VEVENT ${gerekli} taşımıyor`);
      assert.match(e.get("DTSTAMP") ?? "", /^\d{8}T\d{6}Z$/);
      assert.match(e.get("UID") ?? "", /^uyap-[a-z0-9-]+@uyap-asistan\.local$/);
    }
    // METHOD bilerek yok (ORGANIZER istemesin diye)
    assert.equal(oz("METHOD"), undefined);
  });

  test("VTIMEZONE Europe/Istanbul: sabit +03, yaz saati kuralı YOK", () => {
    const ics = uret([kayit()]).ics;
    const c = icsCoz(ics);
    const tzid = c.ozellikler.find((o) => o.ad === "TZID");
    assert.equal(tzid?.deger, TZID);
    assert.ok(c.bilesenler.includes("STANDARD"));
    assert.ok(!c.bilesenler.includes("DAYLIGHT"), "yaz saati gözlemi yazılmamalı");
    assert.equal(c.ozellikler.find((o) => o.ad === "TZOFFSETTO")?.deger, "+0300");
  });

  test("KABUL 5 — Türkçe karakter ve UZUN başlık katlamada bozulmaz", () => {
    const uzun = "Şırnak Çığlıöz Ağır Ceza Mahkemesi Müşterek İhtisas Dairesi Öğleden Sonra Şubesi";
    const sonuc = uret([kayit({ yerelBirimAd: uzun })]);
    const c = icsCoz(sonuc.ics);
    const summary = textAc(c.veventler[0]?.get("SUMMARY") ?? "");
    assert.ok(summary.startsWith(uzun), `başlık bozuldu: ${summary}`);
    assert.ok(summary.includes("2026/918"));
    // katlama gerçekten oldu (tek satıra sığmıyor)
    assert.ok(
      c.fiziksel.some((s) => s.startsWith(" ")),
      "uzun satır katlanmadı",
    );
    // ve hiçbir Türkçe harf yarıda bölünmedi: dosya baştan sona geçerli UTF-8
    assert.equal(
      Buffer.from(sonuc.ics, "utf8").toString("utf8"),
      sonuc.ics,
      "UTF-8 sürek baytı ortadan bölünmüş",
    );
    assert.ok(!sonuc.ics.includes("�"));
  });

  test("kaçırma: `;` `,` `\\` ve yeni satır TEXT değerinde kaçırılır", () => {
    assert.equal(icsKacir("a;b,c\\d"), "a\\;b\\,c\\\\d");
    assert.equal(icsKacir("bir\niki"), "bir\\niki");
    const sonuc = uret([kayit({ yerelBirimAd: "A; B, C \\ D" })]);
    const c = icsCoz(sonuc.ics);
    assert.equal(textAc(c.veventler[0]?.get("LOCATION") ?? ""), "A; B, C \\ D");
  });

  test("katlama sınırı OKTETTİR: 75 baytı aşan satır bölünür, devam boşlukla başlar", () => {
    const parcalar = icsKatla(`X:${"ş".repeat(60)}`);
    assert.ok(parcalar.length > 1);
    assert.ok(parcalar.every((p) => Buffer.byteLength(p, "utf8") <= 75));
    assert.equal(parcalar.join(""), `X:${"ş".repeat(60)}`);
  });
});

/* ── 2. saat kaymaz ────────────────────────────────────────────────────── */

describe("P07a saat kaymaz", () => {
  test("KABUL 4 — 11:40 duruşma .ics'te 11:40; yaz saati geçişinin İKİ YANINDA da", () => {
    // Avrupa yaz saati geçişleri 2026: 29 Mart ve 25 Ekim. Türkiye 2016'dan
    // beri sabit +03 (bu makinede ölçüldü) — ama asıl kanıt şudur: dosyaya
    // duvar saati yazılır, UTC'ye çevrilmez; hangi tarafta olursa olsun saat
    // AYNI kalır.
    const gunler = [
      "2026-03-28",
      "2026-03-29",
      "2026-03-30",
      "2026-10-24",
      "2026-10-25",
      "2026-10-26",
    ];
    for (const gun of gunler) {
      const sonuc = uret([kayit({ tarihSaat: `${gun} 11:40:00.0` })]);
      const e = icsCoz(sonuc.ics).veventler[0]!;
      const beklenen = `${gun.replace(/-/g, "")}T114000`;
      assert.equal(e.get(`DTSTART;TZID=${TZID}`), beklenen, gun);
      assert.ok(!(e.get("DTSTART") ?? "").endsWith("Z"), "UTC'ye çevrilmiş");
    }
  });

  test("makinenin saat dilimi sonucu DEĞİŞTİRMEZ", () => {
    const eski = process.env["TZ"];
    const cikti: string[] = [];
    try {
      for (const tz of ["Europe/Istanbul", "America/New_York", "Pacific/Kiritimati", "UTC"]) {
        process.env["TZ"] = tz;
        const sonuc = takvimUret([kayit()], { simdi: SIMDI });
        cikti.push(icsCoz(sonuc.ics).veventler[0]!.get(`DTSTART;TZID=${TZID}`) ?? "");
      }
    } finally {
      if (eski === undefined) delete process.env["TZ"];
      else process.env["TZ"] = eski;
    }
    assert.deepEqual(new Set(cikti), new Set(["20260909T114000"]));
  });

  test("süre varsayılanı 30 dk; gün devri doğru", () => {
    const sonuc = uret([kayit({ tarihSaat: "2026-09-09 23:50:00.0" })]);
    const e = icsCoz(sonuc.ics).veventler[0]!;
    assert.equal(e.get(`DTSTART;TZID=${TZID}`), "20260909T235000");
    assert.equal(e.get(`DTEND;TZID=${TZID}`), "20260910T002000");
    assert.equal(sonuc.sureDk, VARSAYILAN_SURE_DK);
    assert.equal(VARSAYILAN_SURE_DK, 30);
  });

  test("duvarEkle ve utcDamga birim davranışı", () => {
    assert.deepEqual(duvarEkle({ yil: 2026, ay: 12, gun: 31, saat: 23, dakika: 45 }, 30), {
      yil: 2027,
      ay: 1,
      gun: 1,
      saat: 0,
      dakika: 15,
    });
    assert.equal(utcDamga(new Date("2026-01-02T03:04:05Z")), "20260102T030405Z");
    assert.equal(gunMetni({ yil: 2026, ay: 9, gun: 9, saat: 1, dakika: 2 }), "20260909");
  });
});

/* ── 3. UID ve SEQUENCE ────────────────────────────────────────────────── */

describe("P07a etkinlik kimliği", () => {
  test("KABUL 2 — aynı duruşma iki kez aktarılınca TEK etkinlik (UID sabit, SEQUENCE artmaz)", () => {
    const birinci = uret([kayit()]);
    const ikinci = uret([kayit()], { durum: birinci.durum });
    const ucuncu = uret([kayit()], { durum: ikinci.durum });
    assert.equal(birinci.etkinlikler[0]?.uid, ikinci.etkinlikler[0]?.uid);
    assert.equal(ikinci.etkinlikler[0]?.uid, ucuncu.etkinlikler[0]?.uid);
    assert.deepEqual(
      [birinci, ikinci, ucuncu].map((s) => s.etkinlikler[0]?.sequence),
      [0, 0, 0],
    );
    assert.equal(ucuncu.durum.etkinlikler.length, 1, "durum dosyası şişiyor");
    assert.equal(icsCoz(ucuncu.ics).veventler.length, 1);
  });

  test("UID DURUM DOSYASI OLMADAN da aynı kalır (kayıttan türetilir)", () => {
    const a = uret([kayit()]);
    const b = uret([kayit()], { durum: null });
    assert.equal(a.etkinlikler[0]?.uid, b.etkinlikler[0]?.uid);
  });

  test("KABUL 3 — ertelenen duruşma AYNI etkinliği günceller: UID aynı, SEQUENCE artar", () => {
    // ERTELEME, HENÜZ YAPILMAMIŞ duruşmanın saatinin değişmesidir: defterdeki
    // kayıt SIMDI'ye göre İLERİDE olmalı. (SIMDI = 13 Eylül 2026.)
    const once = uret([kayit({ tarihSaat: "2026-09-20 10:00:00.0" })]);
    const sonra = uret([kayit({ tarihSaat: "2026-10-14 09:30:00.0" })], {
      durum: once.durum,
    });
    assert.equal(sonra.etkinlikler[0]?.uid, once.etkinlikler[0]?.uid);
    assert.equal(sonra.etkinlikler[0]?.sequence, 1);
    assert.equal(sonra.etkinlikler[0]?.ertelendi, true);
    const e = icsCoz(sonra.ics).veventler[0]!;
    assert.equal(e.get("SEQUENCE"), "1");
    assert.equal(e.get(`DTSTART;TZID=${TZID}`), "20261014T093000");
    assert.equal(sonra.durum.etkinlikler.length, 1, "erteleme ikinci kayıt açtı");
    // ikinci erteleme: SEQUENCE 2
    const ucuncu = uret([kayit({ tarihSaat: "2026-11-02 14:00:00.0" })], {
      durum: sonra.durum,
    });
    assert.equal(ucuncu.etkinlikler[0]?.sequence, 2);
    assert.equal(ucuncu.etkinlikler[0]?.uid, once.etkinlikler[0]?.uid);
  });

  test("YAPILMIŞ duruşmanın kaydı DEVRALINMAZ: yeni celse yeni etkinliktir", () => {
    // Duruşma sorgusu her zaman BUGÜNDEN ileri bakar (src/uyap/durusma.ts):
    // bir dosyanın SONRAKİ celsesi ekrana düştüğünde defterdeki önceki celse
    // ZATEN GEÇMİŞTEDİR. Koşulsuz devralma, duruşmanın yapıldığı günün
    // kaydını avukatın takviminden siler — burada kilitlenen budur.
    const gecmis = uret([kayit({ tarihSaat: "2026-09-09 11:40:00.0" })], {
      simdi: new Date("2026-09-01T09:00:00.000Z"),
    });
    assert.equal(gecmis.etkinlikler[0]?.dtstart, "20260909T114000");
    // SIMDI 13 Eylül: 9 Eylül duruşması OLDU. Mahkeme yeni celseyi verdi.
    const yeniCelse = uret([kayit({ tarihSaat: "2026-11-20 09:30:00.0" })], {
      durum: gecmis.durum,
    });
    assert.notEqual(
      yeniCelse.etkinlikler[0]?.uid,
      gecmis.etkinlikler[0]?.uid,
      "geçmiş celsenin UID'si devralındı: 9 Eylül etkinliği 20 Kasım'a TAŞINIR",
    );
    assert.equal(yeniCelse.etkinlikler[0]?.sequence, 0);
    assert.equal(yeniCelse.etkinlikler[0]?.ertelendi, false);
    assert.equal(yeniCelse.etkinlikler[0]?.yeni, true);
    assert.equal(yeniCelse.etkinlikler[0]?.oncekiDtstart, undefined);
    // Geçmiş kayıt defterde DURUYOR (takvimdeki etkinliğin karşılığı).
    assert.ok(
      yeniCelse.durum.etkinlikler.some(
        (e) => e.uid === gecmis.etkinlikler[0]?.uid && e.dtstart === "20260909T114000",
      ),
      "yapılmış duruşmanın kaydı defterden silindi",
    );
    assert.equal(yeniCelse.durum.etkinlikler.length, 2);
    // .ics yalnız yeni celseyi taşır ve SEQUENCE 0'dır (güncelleme değil).
    const e = icsCoz(yeniCelse.ics).veventler[0]!;
    assert.equal(e.get("SEQUENCE"), "0");
    assert.equal(e.get(`DTSTART;TZID=${TZID}`), "20261120T093000");
    // Kullanıcı SESSİZ bırakılmaz.
    assert.ok(
      yeniCelse.uyarilar.some((u) => u.includes("tarihi geçmiş")),
      `uyarı çıkmadı: ${JSON.stringify(yeniCelse.uyarilar)}`,
    );
    // Aynı taban iki kez gelse bile uyarı BİR kez yazılır.
    const ikili = uret(
      [
        kayit({ tarihSaat: "2026-11-20 09:30:00.0" }),
        kayit({ tarihSaat: "2026-11-21 09:30:00.0" }),
      ],
      { durum: gecmis.durum },
    );
    assert.equal(
      ikili.uyarilar.filter((u) => u.includes("tarihi geçmiş")).length,
      1,
    );
  });

  test("erteleme eşiği TÜRKİYE duvar saatidir, makinenin saati değil", () => {
    // Eşik 3 saat geriye kayarsa (UTC bileşenleriyle hesaplanırsa) az önce
    // yapılmış duruşma "ileride" sanılır ve kaydı taşınır.
    assert.deepEqual(simdiDuvar(new Date("2026-09-13T15:04:05.000Z")), {
      yil: 2026,
      ay: 9,
      gun: 13,
      saat: 18,
      dakika: 4,
    });
    // gün/ay/yıl devri: 23:30 UTC → ertesi gün 02:30 İstanbul
    assert.deepEqual(simdiDuvar(new Date("2026-12-31T23:30:00.000Z")), {
      yil: 2027,
      ay: 1,
      gun: 1,
      saat: 2,
      dakika: 30,
    });
    // gece yarısı 24 değil 0 yazılır
    assert.equal(simdiDuvar(new Date("2026-09-13T21:00:00.000Z")).saat, 0);

    // BUGÜN 12:00'de yapılmış duruşma, 14:00'te aktarılırken GEÇMİŞTİR.
    const sabah = uret([kayit({ tarihSaat: "2026-09-13 12:00:00.0" })], {
      simdi: new Date("2026-09-13T06:00:00.000Z"), // İstanbul 09:00
    });
    const oglenSonrasi = uret([kayit({ tarihSaat: "2026-09-25 10:00:00.0" })], {
      simdi: new Date("2026-09-13T11:00:00.000Z"), // İstanbul 14:00
      durum: sabah.durum,
    });
    assert.equal(oglenSonrasi.etkinlikler[0]?.ertelendi, false);
    assert.notEqual(oglenSonrasi.etkinlikler[0]?.uid, sabah.etkinlikler[0]?.uid);
    // Aynı duruşma HENÜZ YAPILMAMIŞKEN (İstanbul 09:00) ertelenirse devralınır.
    const ertelendi = uret([kayit({ tarihSaat: "2026-09-13 16:00:00.0" })], {
      simdi: new Date("2026-09-13T06:00:00.000Z"),
      durum: sabah.durum,
    });
    assert.equal(ertelendi.etkinlikler[0]?.ertelendi, true);
    assert.equal(ertelendi.etkinlikler[0]?.uid, sabah.etkinlikler[0]?.uid);
  });

  test("aynı dosyanın aynı türdeki İKİ AYRI duruşması birleşmez", () => {
    // Bu, tarihsiz UID tabanının sessizce yiyeceği durumdur: iki duruşma tek
    // etkinliğe iner ve biri kaybolur. Ayrı UID + uyarı bekleniyor.
    const sonuc = uret([
      kayit({ tarihSaat: "2026-09-20 10:00:00.0" }),
      kayit({ tarihSaat: "2026-10-05 10:00:00.0" }),
    ]);
    const uidler = sonuc.etkinlikler.map((e) => e.uid);
    assert.equal(new Set(uidler).size, 2, "iki duruşma tek UID'ye indi");
    assert.equal(icsCoz(sonuc.ics).veventler.length, 2);
    assert.ok(
      sonuc.uyarilar.some((u) => u.includes("aynı türde")),
      "kullanıcı belirsizlik hakkında uyarılmadı",
    );
    // ikinci turda ikisi de BİREBİR eşleşir: yeni kopya doğmaz
    const ikinci = uret(
      [
        kayit({ tarihSaat: "2026-09-20 10:00:00.0" }),
        kayit({ tarihSaat: "2026-10-05 10:00:00.0" }),
      ],
      { durum: sonuc.durum },
    );
    assert.deepEqual(ikinci.etkinlikler.map((e) => e.uid).sort(), [...uidler].sort());
    assert.deepEqual(ikinci.etkinlikler.map((e) => e.sequence), [0, 0]);
    assert.equal(ikinci.durum.etkinlikler.length, 2);
  });

  test("BELİRSİZ ERTELEME TAHMİN EDİLMEZ: mevcut etkinlik başka saate taşınmaz", () => {
    const ilk = uret([
      kayit({ tarihSaat: "2026-09-20 10:00:00.0" }),
      kayit({ tarihSaat: "2026-10-05 10:00:00.0" }),
    ]);
    const sonra = uret([kayit({ tarihSaat: "2026-09-27 10:00:00.0" })], {
      durum: ilk.durum,
    });
    assert.equal(sonra.etkinlikler[0]?.ertelendi, false, "hangisi ertelendi TAHMİN edildi");
    assert.ok(!ilk.etkinlikler.some((e) => e.uid === sonra.etkinlikler[0]?.uid));
    assert.ok(sonra.uyarilar.some((u) => u.includes("ölçülemiyor")));
  });

  test("aynı listede AYNI duruşma iki kez varsa tek etkinlik olur", () => {
    const sonuc = uret([kayit(), kayit()]);
    assert.equal(sonuc.etkinlikler.length, 1);
    assert.equal(sonuc.yinelenen, 1);
    assert.equal(icsCoz(sonuc.ics).veventler.length, 1);
  });

  test("UID opak token ya da müvekkil adı TAŞIMAZ; kalıcı alanlardan türer", () => {
    const uid = uret([kayit({ dosyaTaraflari: [{ isim: "GİZLİ", soyad: "KİŞİ" }] })])
      .etkinlikler[0]!.uid;
    assert.match(uid, /^uyap-7000-2026-918-t0-20260909@uyap-asistan\.local$/);
    for (const yasak of ["gizli", "kisi", "GİZLİ", "opak"])
      assert.ok(!uid.toLowerCase().includes(yasak.toLowerCase()), uid);
    assert.equal(uidTabani(kayit()), "uyap-7000-2026-918-t0");
    // farklı mahkeme, aynı esas → farklı kimlik
    assert.notEqual(uidTabani(kayit({ birimId: "7001" })), uidTabani(kayit()));
    // farklı işlem türü → farklı kimlik
    assert.notEqual(uidTabani(kayit({ islemTuru: 1 })), uidTabani(kayit()));
    // birimId yoksa mahkeme adından türer (yine kalıcı alan)
    assert.equal(
      uidTabani(kayit({ birimId: "" })),
      "uyap-sentetik-1-is-mahkemesi-2026-918-t0",
    );
    assert.equal(kimlikSadelestir("Şırnak 2. Ağır Ceza"), "sirnak-2-agir-ceza");
    assert.equal(uidTabani({ dosyaNo: "", yerelBirimAd: "", birimId: "" }), null);
  });
});

/* ── 4. gizlilik ───────────────────────────────────────────────────────── */

describe("P07a gizlilik", () => {
  test("KABUL 6 — VARSAYILAN çıktıda hiçbir taraf adı geçmez", () => {
    const sonuc = uret([
      kayit({
        dosyaTaraflari: [
          { isim: "SENTETİK", soyad: "DAVACIOĞLU", sifat: "DAVACI" },
          { isim: "ÖRNEK", soyad: "DAVALIGİL", sifat: "DAVALI", isVekil: true },
        ],
      }),
    ]);
    const acik = icsCoz(sonuc.ics)
      .ozellikler.map((o) => textAc(o.deger))
      .join("\n");
    for (const ad of ["SENTETİK", "DAVACIOĞLU", "ÖRNEK", "DAVALIGİL"])
      assert.ok(!acik.includes(ad), `taraf adı sızdı: ${ad}`);
    assert.ok(acik.includes("Taraf adları gizlilik gereği yazılmadı"));
    assert.equal(sonuc.taraflariEkle, false);
  });

  test("seçenek AÇIKKEN taraf adları yazılır", () => {
    const sonuc = uret(
      [kayit({ dosyaTaraflari: [{ isim: "SENTETİK", soyad: "DAVACIOĞLU", sifat: "DAVACI" }] })],
      { taraflariEkle: true },
    );
    const aciklama = textAc(icsCoz(sonuc.ics).veventler[0]!.get("DESCRIPTION") ?? "");
    assert.ok(aciklama.includes("DAVACI SENTETİK DAVACIOĞLU"), aciklama);
    assert.equal(sonuc.taraflariEkle, true);
  });

  test("arayüz katmanı da kapalıyken taraf adını YOLA ÇIKARMAZ", () => {
    const ham = kayit();
    assert.equal(aktarmaKaydi(ham, false).dosyaTaraflari, undefined);
    assert.equal(aktarmaKaydi(ham, true).dosyaTaraflari?.length, 1);
  });
});

/* ── 5. tarih uydurulmaz ───────────────────────────────────────────────── */

describe("P07a tarih uydurulmaz", () => {
  test("tarihi okunamayan satır ATLANIR, sebebiyle bildirilir", () => {
    const sonuc = uret([
      kayit({ tarihSaat: "" }),
      kayit({ tarihSaat: "belirsiz", dosyaNo: "2026/120" }),
      kayit({ tarihSaat: "2026-02-30 10:00:00.0", dosyaNo: "2026/121" }),
      kayit(),
    ]);
    assert.equal(sonuc.etkinlikler.length, 1);
    assert.equal(sonuc.atlananlar.length, 3);
    for (const a of sonuc.atlananlar) assert.match(a.sebep, /uydurma|okunamadı/i);
    assert.equal(icsCoz(sonuc.ics).veventler.length, 1);
  });

  test("tarihSaatCoz sınır değerleri", () => {
    assert.deepEqual(tarihSaatCoz("2026-09-09 11:40:00.0"), {
      yil: 2026,
      ay: 9,
      gun: 9,
      saat: 11,
      dakika: 40,
    });
    for (const kotu of [
      "",
      undefined,
      null,
      "09.09.2026 11:40",
      "2026-13-01 10:00:00.0",
      "2026-09-31 10:00:00.0",
      "2026-09-09 24:00:00.0",
      "2026-09-09 10:61:00.0",
      "yarın",
    ])
      assert.equal(tarihSaatCoz(kotu as string), null, String(kotu));
  });

  test("ekran ile motor AYNI tarihi okur (ikiz ayrışmasın)", () => {
    const tablo = [
      "2026-09-09 11:40:00.0",
      "2026-09-09T11:40:00",
      "2026-02-29 10:00:00.0",
      "2026-02-28 10:00:00.0",
      "2026-12-31 23:59:00.0",
      "1969-01-01 10:00:00.0",
      "",
      "bilinmiyor",
      "2026-00-10 10:00:00.0",
      "2026-09-09 25:00:00.0",
    ];
    for (const deger of tablo) {
      const motor = tarihSaatCoz(deger);
      const ekran = tarihCoz(deger);
      assert.equal(
        motor === null,
        ekran === null,
        `karar ayrıştı: ${JSON.stringify(deger)}`,
      );
      if (motor && ekran) {
        assert.equal(
          ekran.gun,
          `${motor.yil}-${String(motor.ay).padStart(2, "0")}-${String(motor.gun).padStart(2, "0")}`,
        );
        assert.equal(
          ekran.saat,
          `${String(motor.saat).padStart(2, "0")}:${String(motor.dakika).padStart(2, "0")}`,
        );
      }
    }
  });
});

/* ── 6. ekran: gün grupları ────────────────────────────────────────────── */

const BUGUN = "2026-09-13";

describe("P07a ajanda ekranı (saf üreticiler)", () => {
  test("KABUL 1 — gün başlıkları: Bugün, Yarın, tarih, sonra tarihsiz", () => {
    const gruplar = gunGruplari(
      [
        { tarihSaat: "2026-09-15 14:00:00.0", dosyaNo: "2026/3" },
        { tarihSaat: "2026-09-13 11:40:00.0", dosyaNo: "2026/1" },
        { tarihSaat: "", dosyaNo: "2026/4" },
        { tarihSaat: "2026-09-14 09:00:00.0", dosyaNo: "2026/2" },
      ],
      BUGUN,
    );
    assert.deepEqual(
      gruplar.map((g: { baslik: string }) => g.baslik),
      ["Bugün", "Yarın", "15 Eylül 2026 Salı", "Tarihi belirsiz"],
    );
    // ham listedeki sıra korunur: aktarma düğmesi doğru satırı bulmalı
    assert.equal(gruplar[0].satirlar[0].indeks, 1);
    assert.equal(gruplar[3].satirlar[0].indeks, 2);
  });

  test("aynı günde çok duruşma SAAT sırasına girer", () => {
    const gruplar = gunGruplari(
      [
        { tarihSaat: "2026-09-13 15:30:00.0", dosyaNo: "2026/3" },
        { tarihSaat: "2026-09-13 09:05:00.0", dosyaNo: "2026/1" },
        { tarihSaat: "2026-09-13 11:40:00.0", dosyaNo: "2026/2" },
      ],
      BUGUN,
    );
    assert.equal(gruplar.length, 1);
    assert.deepEqual(
      gruplar[0].satirlar.map((s: { an: { saat: string } }) => s.an.saat),
      ["09:05", "11:40", "15:30"],
    );
  });

  test("tek gün, boş liste ve gün etiketleri", () => {
    assert.equal(gunGruplari([], BUGUN).length, 0);
    assert.equal(gunGruplari(null, BUGUN).length, 0);
    assert.equal(gunEtiketi("2026-09-13", BUGUN), "Bugün");
    assert.equal(gunEtiketi("2026-09-14", BUGUN), "Yarın");
    assert.equal(gunEtiketi("2026-10-01", BUGUN), "1 Ekim 2026 Perşembe");
    // ay/yıl devri
    assert.equal(gunEtiketi("2027-01-01", "2026-12-31"), "Yarın");
  });

  test("boş aralık ekranda boşluk metni verir, satır uydurmaz", () => {
    const html = ajandaHTML([], { bugun: BUGUN, davalar: [] });
    assert.ok(html.includes("Bu aralıkta kayıt bulunamadı"));
    assert.ok(!html.includes("<button"));
  });

  test("tarihsiz satırda aktarma düğmesi ÇİZİLMEZ", () => {
    const html = ajandaHTML([{ tarihSaat: "", dosyaNo: "2026/9" }], {
      bugun: BUGUN,
      davalar: [],
    });
    assert.ok(html.includes("Tarihi belirsiz"));
    assert.ok(html.includes("takvime aktarılamaz"));
    assert.ok(!html.includes("data-ajanda-ics"));
  });

  test("satır HTML'i kaçırılır (XSS)", () => {
    const html = ajandaHTML(
      [
        {
          tarihSaat: "2026-09-13 10:00:00.0",
          dosyaNo: "2026/1",
          yerelBirimAd: '<img src=x onerror="alert(1)">',
          islemTuruAciklama: "Duruşma",
        },
      ],
      { bugun: BUGUN, davalar: [] },
    );
    assert.ok(!html.includes("<img"));
    assert.ok(html.includes("&lt;img"));
  });
});

/* ── 7. ekran: arşiv eşleşmesi ─────────────────────────────────────────── */

describe("P07a arşiv eşleşmesi", () => {
  const dava = (ek: Record<string, unknown> = {}) => ({
    caseKey: "Sentetik 1. İş Mahkemesi\u00002026/918",
    birimAdi: "Sentetik 1. İş Mahkemesi",
    birimId: "7000",
    dosyaNo: "2026/918",
    klonYolu: "/tmp/sentetik/dava",
    ...ek,
  });
  const satir = {
    tarihSaat: "2026-09-13 10:00:00.0",
    dosyaNo: "2026/918",
    birimId: "7000",
    yerelBirimAd: "Sentetik 1. İş Mahkemesi",
  };

  test("caseKey'in NUL ayıracı DOM'a HAM geçmez (ELLE UI KONTROLÜNDE yakalandı)", () => {
    // Arşiv anahtarı "Birim\u0000Esas"tır. HTML ayrıştırıcısı öznitelikteki
    // U+0000'ı U+FFFD'ye çevirir, dolayısıyla ham geçen anahtar geri
    // okunduğunda hiçbir davayı tutmaz: düğme tarayıcıda "klonlanmamış dava"
    // hatası veriyordu. Kural: anahtar encodeURIComponent ile taşınır.
    const html = ajandaHTML([satir], { bugun: BUGUN, davalar: [dava()] });
    assert.ok(
      !html.includes("\u0000"),
      "ham NUL DOM'a gidiyor; tarayıcı onu U+FFFD yapar ve satır yanlış davaya bakar",
    );
    const m = /data-ajanda-dava="([^"]*)"/.exec(html);
    assert.ok(m, "arşiv düğmesi çizilmedi");
    assert.equal(decodeURIComponent(m![1]!), dava().caseKey);
  });

  test("tek aday → bağlantı çıkar", () => {
    const e = davaEsle(satir, [dava()]);
    assert.equal(e.durum, "tek");
    assert.equal(e.kayit.caseKey, dava().caseKey);
    const html = ajandaHTML([satir], { bugun: BUGUN, davalar: [dava()] });
    assert.ok(html.includes("data-ajanda-dava"));
    assert.ok(html.includes("Arşivde aç"));
  });

  test("İKİ aday → BAĞLANTI ÇIKMAZ, sebebi yazılır", () => {
    const davalar = [
      dava(),
      dava({ caseKey: "İkiz Mahkemesi\u00002026/918", birimId: "7000", birimAdi: "İkiz Mahkemesi" }),
    ];
    const e = davaEsle(satir, davalar);
    assert.equal(e.durum, "belirsiz");
    assert.equal(e.adet, 2);
    const html = ajandaHTML([satir], { bugun: BUGUN, davalar });
    assert.ok(!html.includes("data-ajanda-dava"), "belirsiz eşleşmede düğme çizildi");
    assert.ok(html.includes("belirsiz olduğu için bağlantı verilmedi"));
  });

  test("indirilmemiş dava, farklı mahkeme ve farklı esas eşleşmez", () => {
    assert.equal(davaEsle(satir, [dava({ klonYolu: undefined })]).durum, "yok");
    assert.equal(
      davaEsle(satir, [dava({ birimId: "9999", birimAdi: "Başka Mahkeme" })]).durum,
      "yok",
    );
    assert.equal(davaEsle(satir, [dava({ dosyaNo: "2026/119" })]).durum, "yok");
    assert.equal(davaEsle({ ...satir, dosyaNo: "" }, [dava()]).durum, "yok");
  });

  test("birimId yoksa mahkeme ADIYLA eşleşir (boşluk/büyük harf farkı yenilmez)", () => {
    const e = davaEsle(
      { ...satir, birimId: "", yerelBirimAd: "SENTETİK 1.  İŞ MAHKEMESİ" },
      [dava({ birimId: "" })],
    );
    assert.equal(e.durum, "tek");
  });
});

/* ── 8. durum dosyası budama ───────────────────────────────────────────── */

describe("P07a durum dosyası", () => {
  test("çok eski etkinlikler budanır, gelecektekiler korunur", () => {
    const durum: TakvimDurum = {
      surum: 1,
      etkinlikler: [
        { uid: "eski@x", taban: "uyap-1-2020-1-t0", dtstart: "20200101T100000", sequence: 0, at: "" },
        { uid: "yeni@x", taban: "uyap-1-2026-1-t0", dtstart: "20261230T100000", sequence: 0, at: "" },
      ],
    };
    const sonuc = uret([kayit()], { durum });
    const uidler = sonuc.durum.etkinlikler.map((e) => e.uid);
    assert.ok(!uidler.includes("eski@x"), "180 günden eski kayıt budanmadı");
    assert.ok(uidler.includes("yeni@x"));
  });
});

/* ── 8b. ekranın söylediği zaman ve sayı ───────────────────────────────── */

describe("P07a ekran doğruyu söyler", () => {
  const T = (iso: string) => new Date(iso);

  test("ÖNBELLEKTEN gelen veri tıklama anı kadar TAZE görünmez", () => {
    // `durusmalar` daemon'da 10 dk önbelleğin arkasındadır: 19:23'te ölçülen
    // liste 19:31'de yeniden istenince portala GİDİLMEZ. Ekran o zaman
    // "19:31" yazarsa avukat verinin 8 dakikalık olduğunu göremez.
    const a = {
      gun: 7,
      sorguAt: "2026-09-13T16:31:00.000Z", // tıklama anı
      olcumAt: "2026-09-13T16:23:00.000Z", // verinin ölçüldüğü an
      onbellekten: true,
    };
    const metin = sorguZamaniMetni(a, T("2026-09-13T16:31:00.000Z"));
    assert.ok(metin.includes("önbellek"), metin);
    assert.ok(metin.includes("8 dk önce"), metin);
    assert.ok(!metin.includes("19:31"), `tıklama anı gösteriliyor: ${metin}`);
    assert.ok(metin.includes("19:23"), metin);
    assert.ok(metin.includes("7 günlük aralık"), metin);
  });

  test("PORTALDAN taze gelen veri önbellek diye etiketlenmez", () => {
    const metin = sorguZamaniMetni(
      {
        gun: 31,
        sorguAt: "2026-09-13T16:31:00.000Z",
        olcumAt: "2026-09-13T16:31:00.000Z",
        onbellekten: false,
      },
      T("2026-09-13T16:31:10.000Z"),
    );
    assert.ok(!metin.includes("önbellek"), metin);
    assert.ok(metin.includes("portaldan"), metin);
    assert.ok(metin.includes("31 günlük aralık"), metin);
  });

  test("damga yoksa uydurma yaş İDDİA EDİLMEZ", () => {
    assert.equal(sorguZamaniMetni({ gun: 7 }), "Henüz sorgulanmadı.");
    assert.equal(sorguZamaniMetni(null), "Henüz sorgulanmadı.");
    assert.equal(sorguZamaniMetni({ gun: 7, olcumAt: "çöp" }), "Henüz sorgulanmadı.");
    // `olcumAt` göndermeyen bir yanıt: tıklama anı yazılır ama ÖNBELLEK ya da
    // TAZELİK iddiası kurulmaz.
    const metin = sorguZamaniMetni(
      { gun: 7, sorguAt: "2026-09-13T16:31:00.000Z", onbellekten: true },
      T("2026-09-13T16:39:00.000Z"),
    );
    assert.ok(!metin.includes("önbellek"), metin);
    assert.ok(!metin.includes("portaldan"), metin);
  });

  test("aktarma özeti KARIŞIK sonuçta olanın tersini söylemez", () => {
    // 1 erteleme + 2 yeni celse: "yenisi eklenmedi" YALANDIR.
    const karisik = aktarmaOzetiHTML({
      adet: 3,
      guncellenen: 1,
      acildi: true,
      kisaYol: "~/x/ajanda.ics",
    });
    assert.ok(!karisik.includes("yenisi eklenmedi"), karisik);
    assert.ok(karisik.includes("2 yeni etkinlik eklendi"), karisik);
    assert.ok(karisik.includes("1 etkinlik"), karisik);
    // Yalnız güncelleme varsa bunu söylemeye devam eder.
    const yalnizGuncelleme = aktarmaOzetiHTML({
      adet: 1,
      guncellenen: 1,
      acildi: true,
      kisaYol: "~/x/ajanda.ics",
    });
    assert.ok(yalnizGuncelleme.includes("yeni etkinlik eklenmedi"), yalnizGuncelleme);
    // Hiç güncelleme yoksa kırılım hiç yazılmaz.
    const hepsiYeni = aktarmaOzetiHTML({
      adet: 2,
      guncellenen: 0,
      acildi: true,
      kisaYol: "~/x/ajanda.ics",
    });
    assert.ok(!hepsiYeni.includes("güncellendi"), hepsiYeni);
    // Motorun uyarısı ekrana ÇIKAR (geçmiş celse sessiz kalmaz).
    const uyarili = aktarmaOzetiHTML({
      adet: 1,
      guncellenen: 0,
      acildi: true,
      kisaYol: "~/x/ajanda.ics",
      uyarilar: ["Sentetik 1. İş Mahkemesi 2026/918: tarihi geçmiş bir duruşma var"],
    });
    assert.ok(uyarili.includes("tarihi geçmiş"), uyarili);
  });
});

/* ── 9. sorgu disiplini (kaynak bekçisi) ───────────────────────────────── */

describe("P07a sorgu disiplini", () => {
  const oku = (ad: string) =>
    readFileSync(new URL(`../../web/${ad}`, import.meta.url), "utf8");

  test("5 sn'lik `poll` turu NE sorgu NE aktarma başlatır", () => {
    const app = oku("app.js");
    assert.ok(!/"durusmalar"/.test(app), "poll'ün olduğu modül duruşma sorguluyor");
    assert.ok(!/takvime-aktar/.test(app), "giriş noktası aktarma çağırıyor");
    // renderCalendar yalnız iki yerde: import satırı ve sayfa dağıtımı.
    assert.equal((app.match(/renderCalendar/g) ?? []).length, 2);
  });

  test("ajanda modülünde portal sorgusu TEK yerdedir ve aktarma ondan bağımsızdır", () => {
    const ajanda = oku("ajanda.js");
    assert.equal((ajanda.match(/api\(\s*"durusmalar"/g) ?? []).length, 1);
    assert.equal((ajanda.match(/api\("takvime-aktar"/g) ?? []).length, 1);
    // Sorgu düğmesi form gönderimindedir; sekmeye girmek sorgu başlatmaz.
    assert.match(ajanda, /#calendar-form"\)\.onsubmit/);
    assert.ok(
      !/setInterval|setTimeout\(/.test(ajanda),
      "ajanda kendi zamanlayıcısını kurmuş",
    );
  });
});
