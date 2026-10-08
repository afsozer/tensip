// P07b — safahat / taraflar / hesap sekmelerinin okunur hâli.
//
// Üç katman sınanır:
//   (1) `src/uyap/detay-goster.ts` — SAF eşleme motoru (başlık, tarih, para,
//       iç içe değer, kronolojik sıra). Tek eşleme noktası budur.
//   (2) `web/detay.js` — ekranın SAF üreticileri (kayıt HTML'i, yaş satırı,
//       üç ayrı boşluk, sorgu disiplini kararı). Olay bağlama ve tıklama
//       KAPSAM DIŞIDIR; onun tek kanıtı elle UI kontrolüdür.
//   (3) daemon işleyicileri — `gorunum`/`sorguAt`/`onbellekten`/`sira`
//       sözleşmesi, 60 dk'lık önbellek (SAHTE SAATLE), UYAP'ın saatlik
//       limiti, oturum değişimi, gizlilik.
//
// GİZLİLİK: bütün taraf adları SENTETİKTİR. Gerçek arşivden, gerçek portaldan
// ya da müvekkil dosyasından tek karakter kopyalanmamıştır.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { daemonKur, type Daemon } from "../src/server/daemon.js";
import { RegistryDepo, caseKeyYap } from "../src/store/registry.js";
import { MockUyap, opakToken } from "./mock-uyap/sunucu.js";
import { OturumDepo } from "../src/uyap/session.js";
import { tmpKok } from "./yardimci.js";
import { SorguOnbellek } from "../src/server/onbellek.js";
import { panoSunucu } from "../src/server/web.js";
import {
  ALAN_TABLOSU,
  BOS_DEGER,
  alanBilgisi,
  anahtarNormal,
  degerCevir,
  gorunumUret,
  insanaOkunur,
  kaydaCevir,
  paraYaz,
  safahatSirala,
  zamanCoz,
  zamanYaz,
  type DetayKaydi,
} from "../src/uyap/detay-goster.js";

interface Kutu {
  yukleniyor: boolean;
  hata: { mesaj: string; kod: string | null } | null;
  veri: Record<string, unknown> | null;
}

const {
  bosKutu,
  detayHTML,
  kayitlarHTML,
  kutuTamamla,
  limitMetni,
  siraNotu,
  sorgulanmaliMi,
  sorguZamaniMetni,
  yasTazelemeMetni,
} = (await import(new URL("../../web/detay.js", import.meta.url).href)) as {
  bosKutu: () => Kutu;
  detayHTML: (ad: string, kutu: unknown, simdi?: Date) => string;
  kayitlarHTML: (gorunum: DetayKaydi[]) => string;
  kutuTamamla: (
    kutu: Kutu,
    sonuc: { veri?: unknown; hata?: unknown; yazilsin?: boolean },
  ) => Kutu;
  limitMetni: (veri: unknown) => string;
  siraNotu: (veri: unknown) => string;
  sorgulanmaliMi: (kutu: unknown, zorla?: boolean) => boolean;
  sorguZamaniMetni: (veri: unknown, simdi?: Date) => string;
  yasTazelemeMetni: (kutu: unknown, simdi?: Date) => string | null;
};

/** Görünümdeki EKRANA BASILACAK bütün dizeler (başlıklar hariç, değerler). */
function metinleriTopla(kayit: DetayKaydi): string[] {
  const out: string[] = [];
  const gez = (d: unknown): void => {
    const v = d as { tur?: string; metin?: string; ogeler?: unknown[]; alanlar?: { deger: unknown }[] };
    if (v?.tur === "metin") out.push(v.metin ?? "");
    else if (v?.tur === "liste") (v.ogeler ?? []).forEach(gez);
    else if (v?.tur === "alanlar") (v.alanlar ?? []).forEach((a) => gez(a.deger));
  };
  for (const a of kayit.alanlar.concat(kayit.digerleri)) gez(a.deger);
  return out;
}

/* ───────────────────────── (1) eşleme motoru ───────────────────────── */

describe("P07b okunur görünüm motoru", () => {
  test("HAM ALAN ADI ekrana düşmez: bilinen alan Türkçe başlığa çevrilir", () => {
    const kayit = kaydaCevir({
      safahatTarihiSTR: "08.09.2026",
      safahatTuruAciklama: "Tebligat",
      islemSonucuAciklama: "Davetiye tebliğ edildi",
      safahatStatuKodAciklama: "Tamamlandı",
    });
    assert.deepEqual(
      kayit.alanlar.map((a) => a.baslik),
      ["Tarih", "İşlem", "İşlem sonucu", "Durum"],
    );
    assert.equal(kayit.digerleri.length, 0);
    const metin = JSON.stringify(kayit);
    for (const ham of [
      "safahatTarihiSTR",
      "safahatTuruAciklama",
      "islemSonucuAciklama",
      "safahatStatuKodAciklama",
    ])
      assert.ok(!metin.includes(ham), `ham alan adı görünümde kaldı: ${ham}`);
  });

  test("TANINMAYAN ALAN GİZLENMEZ: ayrı bölümde ama DEĞERİYLE GÖRÜNÜR", () => {
    const kayit = kaydaCevir({
      aciklama: "Tanınan",
      krediKartiTahsilatKodu: "KK-42",
      MUHASEBE_FIS_NO: "9911",
    });
    assert.deepEqual(kayit.alanlar.map((a) => a.baslik), ["Açıklama"]);
    // Gizlemek YOK: iki alan da `digerleri` içinde, değerleriyle birlikte.
    assert.deepEqual(kayit.digerleri.map((a) => a.baslik), [
      "Kredi Karti Tahsilat Kodu",
      "Muhasebe Fis No",
    ]);
    assert.deepEqual(
      kayit.digerleri.map((a) => (a.deger as { metin: string }).metin),
      ["KK-42", "9911"],
    );
    const metin = JSON.stringify(kayit);
    assert.ok(!metin.includes("krediKartiTahsilatKodu"));
    assert.ok(!metin.includes("MUHASEBE_FIS_NO"));
  });

  test("iç içe nesne ve dizi JSON metni olarak BASILMAZ, alanlara açılır", () => {
    const kayit = kaydaCevir({
      tarih: "2026-09-09 11:40:00.0",
      dosyaTaraflari: [
        { isim: "SENTETİK", soyad: "DAVACIOĞLU", sifat: "DAVACI" },
        { isim: "SENTETİK", soyad: "DAVALIOĞLU", sifat: "DAVALI" },
      ],
      etiketler: ["a", "b"],
    });
    const taraf = kayit.digerleri.find((a) => a.baslik === "Dosya Taraflari");
    assert.ok(taraf, "iç içe dizi alanı kayboldu");
    assert.equal(taraf!.deger.tur, "liste");
    const ilk = (taraf!.deger as { ogeler: { tur: string; alanlar: { baslik: string }[] }[] })
      .ogeler[0]!;
    assert.equal(ilk.tur, "alanlar");
    assert.deepEqual(ilk.alanlar.map((a) => a.baslik), ["Adı", "Soyadı", "Sıfatı"]);
    // HİÇBİR metin değeri JSON yığını değildir: gösterilecek her dize
    // toplanır ve içinde süslü/köşeli parantez aranır.
    for (const m of metinleriTopla(kayit))
      assert.ok(!/[{}[\]]/.test(m), `değer JSON metnine çevrilmiş: ${m}`);
    // tanınan tarih okunur biçimde
    assert.deepEqual(kayit.alanlar[0], {
      baslik: "Tarih",
      deger: { tur: "metin", metin: "09.09.2026 11:40" },
    });
  });

  test("boş değer —, ÇÖZÜLEMEYEN tarih olduğu gibi, boş dizi/nesne de —", () => {
    const kayit = kaydaCevir({
      aciklama: "",
      durum: null,
      tarih: "belirsiz",
      dogumTarihi: "32.13.2026",
      ekler: [],
      ayrinti: {},
      isVekil: false,
    });
    const al = (b: string) =>
      (kayit.alanlar.concat(kayit.digerleri).find((a) => a.baslik === b)!.deger as {
        metin: string;
      }).metin;
    assert.equal(al("Açıklama"), BOS_DEGER);
    assert.equal(al("Durum"), BOS_DEGER);
    // UYDURMA YOK: tanınmayan tarih değeri olduğu gibi gösterilir.
    assert.equal(al("Tarih"), "belirsiz");
    assert.equal(al("Doğum tarihi"), "32.13.2026");
    assert.equal(al("Ekler"), BOS_DEGER);
    assert.equal(al("Ayrinti"), BOS_DEGER);
    assert.equal(al("Vekil mi"), "Hayır");
  });

  test("para YALNIZ sayı geldiğinde ayraçlanır; birim EKLENMEZ", () => {
    assert.equal(paraYaz(10000.5), "10.000,50");
    assert.equal(paraYaz(-1234567.891), "-1.234.567,89");
    assert.equal(paraYaz(0), "0,00");
    const kayit = kaydaCevir({ alacak: 10000.5, odendi: "2.500,00", bakiye: "?" });
    const al = (b: string) =>
      (kayit.alanlar.find((a) => a.baslik === b)!.deger as { metin: string }).metin;
    assert.equal(al("Alacak"), "10.000,50");
    // portal zaten biçimli dize gönderdiyse DOKUNULMAZ
    assert.equal(al("Ödenen"), "2.500,00");
    assert.equal(al("Bakiye"), "?");
    for (const a of kayit.alanlar)
      assert.ok(!/TL|₺/.test((a.deger as { metin: string }).metin), "para birimi uydurulmuş");
  });

  test("tarih yalnız TANINAN kalıplarda biçimlenir", () => {
    assert.equal(zamanYaz(zamanCoz("04.09.2026")!), "04.09.2026");
    assert.equal(zamanYaz(zamanCoz("01/09/2026")!), "01.09.2026");
    assert.equal(zamanYaz(zamanCoz("2026-09-09T11:40:00")!), "09.09.2026 11:40");
    assert.equal(zamanYaz(zamanCoz("04.09.2026 08:05:00")!), "04.09.2026 08:05");
    for (const kotu of ["", "yakında", "2026", "31.02.2026", "2026-13-01", "04.09.2026 25:00"])
      assert.equal(zamanCoz(kotu), null, `tarih sanılmamalı: ${kotu}`);
  });

  test("insanaOkunur HİÇBİR ZAMAN ham anahtarı geri vermez", () => {
    for (const ham of [
      "islemSonucuAciklama",
      "dosyaTurKod",
      "MUHASEBE_FIS_NO",
      "kredi-karti",
      "tahsilat.kodu",
      "x",
      "ABC",
    ])
      assert.notEqual(insanaOkunur(ham), ham, `ham anahtar ekrana düşüyor: ${ham}`);
    assert.equal(insanaOkunur("   "), "(adsız alan)");
  });

  test("anahtar eşlemesi ayraç ve büyük/küçük harften bağımsızdır", () => {
    assert.equal(anahtarNormal("safahat_Turu.Aciklama"), "safahatturuaciklama");
    assert.equal(alanBilgisi("SAFAHAT_TURU_ACIKLAMA").baslik, "İşlem");
    assert.equal(alanBilgisi("safahatTuruAciklama").taninan, true);
    assert.equal(alanBilgisi("bilinmeyenSey").taninan, false);
  });

  test("eşleme TEK YERDEDİR: tabloda tekrar eden anahtar yok", () => {
    const anahtarlar = Object.keys(ALAN_TABLOSU);
    assert.deepEqual(
      anahtarlar.filter((a) => a !== anahtarNormal(a)),
      [],
      "tablo anahtarı normalleştirilmiş biçimde değil",
    );
    assert.equal(new Set(anahtarlar).size, anahtarlar.length);
  });

  test("safahat KRONOLOJİK sıralanır; bir satırın tarihi çözülemezse PORTAL SIRASI korunur", () => {
    const satirlar = [
      { safahatTarihiSTR: "09.09.2026", aciklama: "ikinci" },
      { safahatTarihiSTR: "04.09.2026", aciklama: "birinci" },
      { safahatTarihiSTR: "20.09.2026", aciklama: "üçüncü" },
    ];
    const sirali = safahatSirala(satirlar);
    assert.equal(sirali.sira, "tarih");
    assert.deepEqual(sirali.satirlar.map((s) => s["aciklama"]), [
      "birinci",
      "ikinci",
      "üçüncü",
    ]);
    // Tek satırın tarihi bile çözülemiyorsa sıralama YAPILMAZ: yarısı tarihli
    // bir listeyi sıralamak portalın kendi sırasını sessizce bozar.
    const karisik = safahatSirala([...satirlar, { aciklama: "tarihsiz" }]);
    assert.equal(karisik.sira, "portal");
    assert.deepEqual(karisik.satirlar.map((s) => s["aciklama"]), [
      "ikinci",
      "birinci",
      "üçüncü",
      "tarihsiz",
    ]);
    assert.equal(safahatSirala([]).sira, "portal");
  });

  test("aynı gün ve saatteki iki kayıt portal sırasını korur (kararlı sıralama)", () => {
    const s = safahatSirala([
      { tarih: "04.09.2026 10:00", aciklama: "a" },
      { tarih: "04.09.2026 10:00", aciklama: "b" },
      { tarih: "03.09.2026 10:00", aciklama: "c" },
    ]);
    assert.deepEqual(s.satirlar.map((x) => x["aciklama"]), ["c", "a", "b"]);
  });

  test("çok derin iç içe yapı sessizce DÜŞMEZ, kaç alan olduğu söylenir", () => {
    let derin: unknown = { son: "değer" };
    for (let i = 0; i < 12; i++) derin = { katman: derin };
    const d = degerCevir(derin);
    assert.equal(JSON.stringify(d).includes("gösterilemeyecek kadar iç içe"), true);
  });
});

/* ───────────────────────── (2) ekran üreticileri ───────────────────── */

const ORNEK_SATIRLAR = {
  safahat: [
    {
      safahatTarihiSTR: "08.09.2026",
      safahatTuruAciklama: "Tebligat",
      islemSonucuAciklama: "Davetiye tebliğ edildi",
      krediKartiTahsilatKodu: "KK-42",
    },
  ],
  taraflar: [
    {
      isim: "SENTETİK",
      soyad: "DAVACIOĞLU",
      sifat: "DAVACI",
      vekil: "AV. SENTETİK VEKİL",
      dosyaTurKod: 0,
    },
  ],
  hesap: [{ tarih: "05.09.2026", alacak: 10000.5, odendi: "2.500,00", masrafKalemi: "posta" }],
};

const veriYap = (ad: keyof typeof ORNEK_SATIRLAR, ek: Record<string, unknown> = {}) => ({
  adet: ORNEK_SATIRLAR[ad].length,
  gorunum: gorunumUret(ORNEK_SATIRLAR[ad]),
  sira: ad === "safahat" ? "tarih" : null,
  sorguAt: "2026-09-13T09:40:00.000Z",
  onbellekten: false,
  ...ek,
});

describe("P07b ekran üreticileri", () => {
  const simdi = new Date("2026-09-13T09:40:20.000Z");

  test("ÜÇ SEKMEDE DE ham alan adı ve JSON metni GÖRÜNMEZ", () => {
    for (const ad of ["safahat", "taraflar", "hesap"] as const) {
      const html = detayHTML(ad, { ...bosKutu(), veri: veriYap(ad) }, simdi);
      for (const ham of [
        "safahatTarihiSTR",
        "safahatTuruAciklama",
        "islemSonucuAciklama",
        "krediKartiTahsilatKodu",
        "dosyaTurKod",
        "masrafKalemi",
        "sifat",
        "vekil",
      ])
        assert.ok(!html.includes(ham), `${ad}: ham alan adı ekranda — ${ham}`);
      assert.ok(!/[{}]/.test(html.replace(/&#?\w+;/g, "")), `${ad}: JSON metni ekranda`);
      assert.ok(!html.includes('":'), `${ad}: JSON metni ekranda`);
    }
  });

  test("TANINMAYAN ALAN yine de GÖRÜNÜR (birinci kural ikincisini bozmuyor)", () => {
    const safahat = detayHTML("safahat", { ...bosKutu(), veri: veriYap("safahat") }, simdi);
    assert.match(safahat, /Kredi Karti Tahsilat Kodu/);
    assert.match(safahat, /KK-42/);
    assert.match(safahat, /Tanınmayan 1 alan/);
    const hesap = detayHTML("hesap", { ...bosKutu(), veri: veriYap("hesap") }, simdi);
    assert.match(hesap, /Masraf Kalemi/);
    assert.match(hesap, /posta/);
    // tanınanlar da yerinde
    assert.match(hesap, /Alacak/);
    assert.match(hesap, /10\.000,50/);
  });

  test("taraf adı bu sekmede GÖRÜNÜR (sekmenin amacı bu)", () => {
    const html = detayHTML("taraflar", { ...bosKutu(), veri: veriYap("taraflar") }, simdi);
    assert.match(html, /SENTETİK/);
    assert.match(html, /DAVACIOĞLU/);
    assert.match(html, /Rolü|Sıfatı/);
  });

  test("BOŞ YANIT · HATA · UYAP LİMİTİ ekranda BİRBİRİNDEN ayrı", () => {
    const bos = detayHTML(
      "safahat",
      { ...bosKutu(), veri: { adet: 0, gorunum: [], sira: "portal", sorguAt: "2026-09-13T09:40:00.000Z", onbellekten: false } },
      simdi,
    );
    const hata = detayHTML(
      "safahat",
      { ...bosKutu(), hata: { mesaj: "klonlanmamış dava", kod: "NOT_FOUND" } },
      simdi,
    );
    const limit = detayHTML(
      "safahat",
      { ...bosKutu(), hata: { mesaj: "UYAP safahat sorgusunu sınırladı", kod: "OTOMASYON_BUTCESI" }, veri: veriYap("safahat") },
      simdi,
    );
    assert.match(bos, /Kayıt bulunamadı/);
    assert.match(bos, /Bu bir hata değildir/);
    assert.ok(!/role="alert"/.test(bos), "boş yanıt hata gibi görünüyor");
    assert.match(hata, /role="alert"/);
    assert.match(hata, /klonlanmamış dava/);
    assert.ok(!/Kayıt bulunamadı/.test(hata), "hata boş yanıt gibi görünüyor");
    // Limit KENDİ cümlesiyle anlatılır ve genel hata kutusu DEĞİLDİR.
    assert.match(limit, /UYAP bu sorguyu saatte bir kez veriyor/);
    assert.ok(!/role="alert"/.test(limit), "limit genel hata gibi gösteriliyor");
    // ve eldeki ölçüm ekranda KALIR
    assert.match(limit, /Tebligat/);
    assert.match(limit, /önceki ölçümdür/);
    assert.equal(new Set([bos, hata, limit]).size, 3);
  });

  test("limit cümlesi eldeki ölçüm YOKKEN de dürüsttür", () => {
    const html = detayHTML(
      "safahat",
      { ...bosKutu(), hata: { mesaj: "sınırlandı", kod: "OTOMASYON_BUTCESI" } },
      simdi,
    );
    assert.match(html, /UYAP bu sorguyu saatte bir kez veriyor/);
    assert.match(html, /Bir süre sonra yeniden deneyin/);
    assert.ok(!/önceki ölçümdür/.test(html));
    assert.equal(limitMetni(null).includes("önceki ölçümdür"), false);
  });

  test("SORGU ZAMANI ekranda: önbellekten gelen ile portaldan gelen AYRI cümle", () => {
    const taze = sorguZamaniMetni({ sorguAt: "2026-09-13T09:40:00.000Z", onbellekten: false }, simdi);
    const eski = sorguZamaniMetni(
      { sorguAt: "2026-09-13T08:42:00.000Z", onbellekten: true },
      simdi,
    );
    assert.match(taze, /portaldan az önce alındı/);
    assert.match(eski, /önbellekten, 58 dk önce ölçüldü/);
    assert.notEqual(taze, eski);
    // Damga yoksa İDDİA KURULMAZ (eski motor yanıtı).
    assert.equal(sorguZamaniMetni({ sorguAt: null }, simdi), "");
    assert.equal(sorguZamaniMetni({ sorguAt: "bozuk" }, simdi), "");
  });

  test("sıra kaynağı yazılı: kronolojik mi, portal sırası mı", () => {
    assert.match(siraNotu({ sira: "tarih" }), /Kronolojik/);
    assert.match(siraNotu({ sira: "portal" }), /Portal sırası korundu/);
    assert.equal(siraNotu({ sira: null }), "");
    assert.match(detayHTML("safahat", { ...bosKutu(), veri: veriYap("safahat") }, simdi), /Kronolojik/);
  });

  test("SEKMEYE DÖNMEK yeni istek doğurmaz; yalnız Yenile zorlar", () => {
    assert.equal(sorgulanmaliMi(bosKutu()), true, "ilk giriş bir kez sorgulamalı");
    assert.equal(sorgulanmaliMi({ ...bosKutu(), veri: veriYap("safahat") }), false);
    assert.equal(sorgulanmaliMi({ ...bosKutu(), yukleniyor: true }), false);
    assert.equal(sorgulanmaliMi({ ...bosKutu(), veri: veriYap("safahat") }, true), true);
  });

  test("HATA DA SONUÇTUR: sekmeye dönmek limit ucuna YENİDEN VURMAZ", () => {
    // P07b incelemesi — sahte portalın sayacıyla ölçüldü: limit hatasından
    // sonra Evrak↔Safahat üç gidiş-geliş, "saatte bir kez veriyor" yazan uca
    // ÜÇ istek atıyordu. Hata artık kutuda durur; tek sorgu yolu Yenile.
    const limit = { ...bosKutu(), hata: { mesaj: "sınırlandı", kod: "OTOMASYON_BUTCESI" } };
    const genel = { ...bosKutu(), hata: { mesaj: "x", kod: "INTERNAL" } };
    assert.equal(sorgulanmaliMi(limit), false, "limit ucuna sekme girişiyle vuruluyor");
    assert.equal(sorgulanmaliMi(genel), false, "hata sonrası her sekme girişi sorguluyor");
    // …ama kullanıcı kilitlenmez: iki ekranda da Yenile ÇİZİLİR.
    for (const kutu of [limit, genel])
      assert.match(detayHTML("safahat", kutu, simdi), /id="detay-yenile"/);
    assert.equal(sorgulanmaliMi(limit, true), true, "Yenile de sormuyorsa çıkış yolu yok");
    assert.equal(sorgulanmaliMi(genel, true), true);
  });

  test("GECİKEN YANIT sekmeyi kilitlemez: bayrak KOŞULSUZ düşer", () => {
    // P07b incelemesi — tarayıcıda ölçüldü: yanıt uçarken başka sekmeye
    // geçilince `yukleniyor` sonsuza kadar true kalıyor, sekme bir daha
    // sormuyor ve "Yükleniyor…" ekranında Yenile de çizilmediği için tek
    // çıkış yolu başka davaya geçmek oluyordu.
    const kutu = bosKutu();
    kutu.yukleniyor = true;
    kutuTamamla(kutu, { veri: veriYap("safahat"), yazilsin: false });
    assert.equal(kutu.yukleniyor, false, "sekme kalıcı Yükleniyor… ekranında kilitli");
    assert.equal(kutu.veri, null, "geciken yanıt ekrana yazılmış");
    assert.equal(kutu.hata, null);
    // Sekmeye dönmek YENİ istek doğurur (kutu boş, hata yok).
    assert.equal(sorgulanmaliMi(kutu), true);
    // Hata yolu da aynı: bayrak düşer, hata yazılmaz.
    const digeri = bosKutu();
    digeri.yukleniyor = true;
    kutuTamamla(digeri, { hata: { mesaj: "x", kod: "INTERNAL" }, yazilsin: false });
    assert.deepEqual(digeri, { yukleniyor: false, hata: null, veri: null });
  });

  test("kutuTamamla: LİMİTTE eldeki ölçüm durur, diğer hatalarda silinir", () => {
    const veri = veriYap("safahat");
    const limit = { ...bosKutu(), veri };
    kutuTamamla(limit, { hata: { mesaj: "sınırlandı", kod: "OTOMASYON_BUTCESI" } });
    assert.equal(limit.veri, veri, "limit yanıtı eldeki ölçümü sildi");
    assert.match(detayHTML("safahat", limit, simdi), /önceki ölçümdür/);
    const genel = { ...bosKutu(), veri };
    kutuTamamla(genel, { hata: { mesaj: "kopuk", kod: "INTERNAL" } });
    assert.equal(genel.veri, null, "eski ölçüm hatalı yanıttan sonra ekranda kaldı");
    // Başarılı yanıt önceki hatayı temizler.
    const duzelen = { ...bosKutu(), hata: { mesaj: "kopuk", kod: "INTERNAL" } };
    kutuTamamla(duzelen, { veri });
    assert.equal(duzelen.hata, null);
    assert.equal(duzelen.veri, veri);
  });

  test("YAŞ CÜMLESİ tıklama beklemeden tazelenir (yeni istek YOK)", () => {
    // P07b incelemesi — ekranda "portaldan az önce alındı" donuyordu: yaş
    // yalnız yeniden çizimde hesaplanıyor, 5 sn'lik tur ayrıntıyı çizmiyordu.
    const kutu = { ...bosKutu(), veri: veriYap("safahat") };
    const ilk = yasTazelemeMetni(kutu, simdi);
    const sonra = yasTazelemeMetni(kutu, new Date(simdi.getTime() + 3 * 60_000));
    assert.match(String(ilk), /az önce/);
    assert.match(String(sonra), /3 dk önce/);
    assert.notEqual(ilk, sonra, "yaş satırı zaman ilerlese de aynı kalıyor");
    // Yazacak bir şey yoksa ekrandaki satıra DOKUNULMAZ.
    assert.equal(yasTazelemeMetni(bosKutu(), simdi), null);
    assert.equal(yasTazelemeMetni({ ...bosKutu(), yukleniyor: true }, simdi), null);
    assert.equal(yasTazelemeMetni({ ...bosKutu(), veri: { sorguAt: null } }, simdi), null);
  });

  test("değerler KAÇIRILIR: portal metni HTML olarak çalışmaz", () => {
    const html = kayitlarHTML(
      gorunumUret([{ aciklama: '<img src=x onerror="alert(1)">', "<b>ham</b>": "y" }]),
    );
    assert.ok(!html.includes("<img"), "portal değeri HTML olarak basılıyor");
    assert.ok(!html.includes("<b>ham</b>"), "portal alan adı HTML olarak basılıyor");
    assert.match(html, /&lt;img/);
  });

  test("motor görünüm üretmezse SESSİZ KALINMAZ, kaç kayıt gizlendiği söylenir", () => {
    const html = detayHTML(
      "hesap",
      { ...bosKutu(), veri: { adet: 3, gorunum: undefined, sorguAt: "2026-09-13T09:40:00.000Z" } },
      simdi,
    );
    assert.match(html, /okunur görünüm üretmedi/);
    assert.match(html, /3 kayıt/);
  });
});

/* ───────────────────────── (3) daemon uçları ───────────────────────── */

const BIRIM = "P07b Sentetik Asliye Hukuk Mahkemesi";
const ESAS = "2026/707";

interface Sahne {
  d: Daemon;
  mock: MockUyap;
  caseKey: string;
  ayarKok: string;
  /** Yerel pano adresi + CSRF anahtarı (web yüzeyi testleri için). */
  pano: { url: string; token: string };
  kapat: () => Promise<void>;
}

async function sahneKur(sec: { safahatSaati?: () => number } = {}): Promise<Sahne> {
  const mock = new MockUyap({
    birimler: [{ birimId: "9707", birimAdi: BIRIM, yargiTuru: "0" }],
    davalar: [
      {
        dosyaId: opakToken("p07b-dosya"),
        birimAdi: BIRIM,
        birimId: "9707",
        esasNo: ESAS,
        dosyaTur: "Hukuk Dava Dosyası",
        dosyaDurum: "Açık",
        yargiTuru: "0",
        evraklar: [],
      },
    ],
  });
  await mock.baslat();
  const ayar = tmpKok();
  const kok = tmpKok();
  new OturumDepo(ayar.kok).yaz({
    surum: 1,
    cookie: "JSESSIONID=p07b-sentetik",
    loginAt: new Date().toISOString(),
    yontem: "manuel",
  });
  const caseKey = caseKeyYap(BIRIM, ESAS);
  const klonYolu = join(kok.kok, "p07b-dava");
  new RegistryDepo(join(ayar.kok, "davalarim.json")).koy({
    caseKey,
    portal: "avukat",
    kaynak: [],
    dosyaNo: ESAS,
    birimAdi: BIRIM,
    birimId: "9707",
    group: "Hukuk",
    kod: "",
    yargiTuru: "0",
    isIcra: false,
    isCbs: false,
    kapsam: "hepsi",
    portalGoruldu: new Date().toISOString(),
    klonYolu,
  });
  mkdirSync(klonYolu, { recursive: true });
  writeFileSync(
    join(klonYolu, "uyap-project.json"),
    JSON.stringify({ surum: 1, dosyaId: opakToken("p07b-dosya"), evraklar: [] }),
  );
  const d = daemonKur({
    ayarDir: ayar.kok,
    kok: kok.kok,
    portalUrl: mock.adres(),
    istekAralikMs: 1,
    oturumYenileMs: 0,
    webPort: 0,
    safahatSaati: sec.safahatSaati,
  });
  await d.rpc.baslat();
  const pano = panoSunucu(d, "test-p07b", mock.adres(), kok.kok);
  await new Promise<void>((r) => pano.listen(0, "127.0.0.1", r));
  const panoUrl = `http://127.0.0.1:${(pano.address() as { port: number }).port}`;
  const html = await (await fetch(panoUrl)).text();
  const token = html.match(/name="csrf-token" content="([^"]+)"/)?.[1] ?? "";
  return {
    d,
    mock,
    caseKey,
    ayarKok: ayar.kok,
    pano: { url: panoUrl, token },
    kapat: async () => {
      await new Promise<void>((r) => {
        pano.close(() => r());
        pano.closeAllConnections();
      });
      await d.kapat();
      await mock.durdur();
      ayar.temizle();
      kok.temizle();
    },
  };
}

const panoCagir = (s: Sahne, ad: string, govde: Record<string, unknown>) =>
  fetch(`${s.pano.url}/api/${ad}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": s.pano.token,
      origin: s.pano.url,
    },
    body: JSON.stringify(govde),
  });

const cagir = (s: Sahne, ad: string, g: Record<string, unknown> = {}) =>
  s.d.isleyiciler.get(ad)!({ caseKey: s.caseKey, ...g }) as Promise<Record<string, unknown>>;

describe("P07b daemon sözleşmesi", () => {
  test("ÜÇ UÇ da `gorunum` + `sorguAt` + `onbellekten` taşır; safahat ayrıca `sira`", async () => {
    const s = await sahneKur();
    try {
      for (const ad of ["safahat", "taraflar", "hesap"]) {
        const y = await cagir(s, ad);
        assert.ok(Array.isArray(y["gorunum"]), `${ad}: gorunum yok`);
        assert.equal((y["gorunum"] as unknown[]).length, y["adet"]);
        assert.ok(
          Number.isFinite(Date.parse(String(y["sorguAt"]))),
          `${ad}: sorguAt okunamıyor`,
        );
        assert.equal(typeof y["onbellekten"], "boolean", `${ad}: onbellekten yok`);
        // Görünümde ham alan adı yok, ama alan sayısı satırdakiyle AYNI.
        const satirlar = y["satirlar"] as Record<string, unknown>[];
        const gorunum = y["gorunum"] as DetayKaydi[];
        satirlar.forEach((satir, i) => {
          assert.equal(
            gorunum[i]!.alanlar.length + gorunum[i]!.digerleri.length,
            Object.keys(satir).length,
            `${ad}: görünümde alan kaybolmuş`,
          );
        });
      }
      const saf = await cagir(s, "safahat");
      assert.equal(saf["sira"], "tarih");
      assert.deepEqual(
        (saf["satirlar"] as Record<string, string>[]).map((r) => r["safahatTuruAciklama"]),
        ["Tebligat", "Duruşma"],
      );
    } finally {
      await s.kapat();
    }
  });

  test("60 DK ÖNBELLEK sahte saatle ölçülür: 59 dk'da portala GİDİLMEZ, 61 dk'da gidilir", async () => {
    let saat = Date.parse("2026-09-13T09:40:00.000Z");
    const s = await sahneKur({ safahatSaati: () => saat });
    try {
      const ilk = await cagir(s, "safahat");
      assert.equal(ilk["onbellekten"], false);
      assert.equal(ilk["sorguAt"], "2026-09-13T09:40:00.000Z");
      const sayacIlk = s.mock.istekler.length;

      saat += 59 * 60_000;
      const ikinci = await cagir(s, "safahat");
      assert.equal(ikinci["onbellekten"], true, "59 dk'da önbellekten gelmeliydi");
      assert.equal(ikinci["sorguAt"], "2026-09-13T09:40:00.000Z", "yaş damgası tazelenmiş");
      assert.equal(s.mock.istekler.length, sayacIlk, "önbellekliyken portala gidilmiş");

      saat += 2 * 60_000; // toplam 61 dk
      const ucuncu = await cagir(s, "safahat");
      assert.equal(ucuncu["onbellekten"], false, "61 dk'da yeniden sorulmalıydı");
      assert.equal(ucuncu["sorguAt"], "2026-09-13T10:41:00.000Z");
      assert.ok(s.mock.istekler.length > sayacIlk, "TTL dolunca portala gidilmemiş");
    } finally {
      await s.kapat();
    }
  });

  test("UYAP LİMİTİ (PRTL_GNL_1-1) OTOMASYON_BUTCESI koduyla döner ve önbelleğe YAZILMAZ", async () => {
    const s = await sahneKur();
    try {
      s.mock.safahatLimiti = true;
      await assert.rejects(
        cagir(s, "safahat"),
        (e: unknown) => (e as { code?: string }).code === "OTOMASYON_BUTCESI",
      );
      // Limit yanıtı önbelleğe yazılmamalı: sınır kalkınca ilk istek çalışsın.
      s.mock.safahatLimiti = false;
      const y = await cagir(s, "safahat");
      assert.equal(y["adet"], 2);
      assert.equal(y["onbellekten"], false);
    } finally {
      await s.kapat();
    }
  });

  test("BOŞ YANIT hata DEĞİLDİR: adet 0, gorunum [] ve sorguAt yine var", async () => {
    const s = await sahneKur();
    try {
      s.mock.detaySatirlari = { safahat: [], taraf: [], hesap: [] };
      for (const ad of ["safahat", "taraflar", "hesap"]) {
        const y = await cagir(s, ad);
        assert.equal(y["adet"], 0, `${ad}: boş yanıt hata sayıldı`);
        assert.deepEqual(y["gorunum"], []);
        assert.ok(Number.isFinite(Date.parse(String(y["sorguAt"]))));
      }
      assert.equal((await cagir(s, "safahat"))["sira"], "portal");
    } finally {
      await s.kapat();
    }
  });

  test("KLONLANMAMIŞ davada üç uç da NOT_FOUND: sekme dürüst davranır", async () => {
    const s = await sahneKur();
    try {
      const yok = caseKeyYap("P07b Olmayan Mahkeme", "1999/1");
      for (const ad of ["safahat", "taraflar", "hesap"])
        await assert.rejects(
          s.d.isleyiciler.get(ad)!({ caseKey: yok }) as Promise<unknown>,
          (e: unknown) => (e as { code?: string }).code === "NOT_FOUND",
          `${ad}: klonlanmamış davada NOT_FOUND beklenir`,
        );
    } finally {
      await s.kapat();
    }
  });

  test("OTURUM SORGU SIRASINDA DEĞİŞİRSE geciken yanıt EKRANA VERİLMEZ", async () => {
    const s = await sahneKur();
    try {
      // Taraf ucu TUTULUR: kimlik araması bitmiş, ASIL sorgu uçuyorken oturum
      // değişir. Opak kimlik oturuma bağlıdır; bu yanıt artık başka dosyanın
      // tarafı olabilir.
      //
      // ZAMANLAMAYA BIRAKILMAZ (P07b incelemesi): eski hâli 60 ms uyuyup
      // oturumu değiştiriyordu, ama uyku YALNIZ detay ucunu geciktiriyordu;
      // yük altında kimlik araması 60 ms'yi aşınca oturum değişimi
      // `klonluDosyaId`nin İÇİNDE yakalanıyor, ölçülmek istenen bekçi
      // (daemon.ts, "yanıt geldiğinde oturum değişmişti") hiç çalışmıyordu.
      // Ölçüm: `--test-concurrency=24` ile 4 koşunun 4'ünde düşüyordu.
      s.mock.detaySatirlari = { taraf: [{ isim: "SENTETİK", soyad: "GECİKEN", sifat: "DAVACI" }] };
      s.mock.detayTutulsun = true;
      const ulasti = s.mock.detayIstegiUlasti();
      const istek = cagir(s, "taraflar");
      await ulasti;
      s.d.oturum.girisYap("JSESSIONID=p07b-yeni-oturum", "manuel");
      s.mock.detaySerbestBirak();
      await assert.rejects(istek, (e: unknown) => {
        const h = e as { code?: string; message?: string };
        assert.equal(h.code, "LOGIN_REQUIRED");
        assert.match(String(h.message), /yanıt geldiğinde oturum değişmişti/);
        return true;
      });
    } finally {
      await s.kapat();
    }
  });

  test("GİZLİLİK: taraf adları uygulama günlüğüne DÜŞMEZ", async () => {
    const s = await sahneKur();
    try {
      s.mock.detaySatirlari = {
        taraf: [{ isim: "SENTETİK", soyad: "GİZLİOĞLU", sifat: "DAVACI" }],
      };
      const y = await cagir(s, "taraflar");
      // Ekranda görünmeli (sekmenin amacı bu)…
      assert.ok(JSON.stringify(y["gorunum"]).includes("GİZLİOĞLU"));
      // …ama günlüğe düşmemeli.
      const log = join(s.ayarKok, "tensip.log");
      const metin = existsSync(log) ? readFileSync(log, "utf8") : "";
      assert.ok(!metin.includes("GİZLİOĞLU"), "taraf adı günlüğe yazılmış");
      assert.ok(!metin.includes("SENTETİK"), "taraf adı günlüğe yazılmış");
    } finally {
      await s.kapat();
    }
  });
});

/* ───────────────────────── (4) web yüzeyi ──────────────────────────── */

describe("P07b web yüzeyi", () => {
  test("`/detay.js` 200 döner: modül 404'ü üç sekmeyi de boş açardı", async () => {
    const s = await sahneKur();
    try {
      const r = await fetch(`${s.pano.url}/detay.js`);
      assert.equal(r.status, 200, "varliklar haritasına eklenmemiş");
      assert.match(r.headers.get("content-type") ?? "", /javascript/);
      assert.match(await r.text(), /export function detayHTML/);
    } finally {
      await s.kapat();
    }
  });

  test("üç uç da pano üzerinden `gorunum` taşır ve CSRF'siz reddedilir", async () => {
    const s = await sahneKur();
    try {
      for (const ad of ["safahat", "taraflar", "hesap"]) {
        const r = await panoCagir(s, ad, { caseKey: s.caseKey });
        assert.equal(r.status, 200, ad);
        const govde = (await r.json()) as { data: Record<string, unknown> };
        assert.ok(Array.isArray(govde.data["gorunum"]), `${ad}: gorunum yok`);
        assert.equal(typeof govde.data["sorguAt"], "string", `${ad}: sorguAt yok`);
        const csrfsiz = await fetch(`${s.pano.url}/api/${ad}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: s.pano.url },
          body: JSON.stringify({ caseKey: s.caseKey }),
        });
        assert.equal(csrfsiz.status, 403, `${ad}: CSRF'siz geçti`);
      }
    } finally {
      await s.kapat();
    }
  });

  test("UYAP limiti istemciye KODUYLA ulaşır (429 + OTOMASYON_BUTCESI)", async () => {
    const s = await sahneKur();
    try {
      s.mock.safahatLimiti = true;
      const r = await panoCagir(s, "safahat", { caseKey: s.caseKey });
      assert.equal(r.status, 429);
      const govde = (await r.json()) as { error: { code: string; message: string } };
      // Ekran limiti genel hatadan KOD ile ayırır; metne bakmak metin
      // değişince sessizce bozulurdu.
      assert.equal(govde.error.code, "OTOMASYON_BUTCESI");
      assert.match(govde.error.message, /UYAP/);
    } finally {
      await s.kapat();
    }
  });

  test("GİZLİLİK: taraf adı `sorunlar.json`a ve ayar dizinine YAZILMAZ", async () => {
    const s = await sahneKur();
    try {
      s.mock.detaySatirlari = {
        taraf: [{ isim: "SENTETİK", soyad: "SIZMASIN", sifat: "DAVACI" }],
      };
      const r = await panoCagir(s, "taraflar", { caseKey: s.caseKey });
      assert.equal(r.status, 200);
      assert.ok((await r.text()).includes("SIZMASIN"), "ekrana da gitmemiş");
      // Ayar dizinindeki HİÇBİR dosyada geçmemeli: bu bir görüntüleme
      // paketidir, safahat/taraf diske yazılmaz.
      const { readdirSync, statSync } = await import("node:fs");
      const gez = (p: string): string[] =>
        readdirSync(p, { withFileTypes: true }).flatMap((g) =>
          g.isDirectory() ? gez(join(p, g.name)) : [join(p, g.name)],
        );
      for (const dosya of gez(s.ayarKok)) {
        if (statSync(dosya).size > 2_000_000) continue;
        assert.ok(
          !readFileSync(dosya, "utf8").includes("SIZMASIN"),
          `taraf adı diske yazılmış: ${dosya}`,
        );
      }
    } finally {
      await s.kapat();
    }
  });
});

/* ───────────────────────── (5) sorgu disiplini ─────────────────────── */

describe("P07b sorgu disiplini ve modül kaydı", () => {
  const oku = (ad: string) => readFileSync(new URL(`../../web/${ad}`, import.meta.url), "utf8");

  test("5 sn'lik `poll` turu ayrıntı sorgusu BAŞLATMAZ", () => {
    const app = oku("app.js");
    for (const uc of ['"safahat"', '"taraflar"', '"hesap"'])
      assert.ok(!app.includes(uc), `poll'ün olduğu modül ayrıntı sorguluyor: ${uc}`);
  });

  test("ayrıntı sorgusu arsiv.js'te TEK YERDEDİR ve kutu dolu ise atlanır", () => {
    const arsiv = oku("arsiv.js");
    assert.equal((arsiv.match(/await api\(name, \{ caseKey: key \}\)/g) ?? []).length, 1);
    assert.match(arsiv, /if \(!sorgulanmaliMi\(kutu, zorla\)\)/);
    // "Yenile" dışında hiçbir çağıran `zorla` geçmez.
    assert.equal((arsiv.match(/loadDetail\([^)]*true\)/g) ?? []).length, 1);
  });

  test("HATA KODU sunucudan ekrana kadar taşınır (limit genel hatadan ayrılsın)", () => {
    // `detayHTML` limiti KODA bakarak ayırıyor; kod yolda düşerse ekran yine
    // "bir şeyler bozuk" der ve bu davranış testi sessizce geçerdi.
    const ortak = oku("ortak.js");
    assert.match(ortak, /hata\.kod = result\.error\?\.code/, "api() hata kodunu düşürüyor");
    const arsiv = oku("arsiv.js");
    assert.match(arsiv, /kod: error\.kod/, "kutuya kod yazılmıyor");
    // Limitte ELDEKİ ÖLÇÜM SİLİNMEZ; diğer hatalarda silinir. Kural artık
    // kutunun sahibi olan modülde (`kutuTamamla`) ve testi yukarıda.
    assert.match(oku("detay.js"), /if \(hata\.kod !== LIMIT_KODU\) kutu\.veri = null/);
  });

  test("GECİKEN YANITTA bayrak SÜRÜM KORUMASININ İÇİNDE temizlenmez", () => {
    // Bu paketin en pahalı hatasıydı: koruma bayrağı da kapsayınca sekme
    // kalıcı "Yükleniyor…" oluyordu. Davranış testi yukarıda; burada
    // arsiv.js'in kararı KUTU MODÜLÜNE bıraktığı sabitleniyor.
    const arsiv = oku("arsiv.js");
    assert.match(arsiv, /kutuTamamla\(kutu, \{ \.\.\.sonuc, yazilsin \}\)/);
    assert.ok(
      !/yukleniyor = false/.test(arsiv.slice(arsiv.indexOf("async function loadDetail"))),
      "bayrak yine arsiv.js içinde, sürüm korumasına düşme riski geri geldi",
    );
  });

  test("YAŞ SATIRI 5 sn'lik tura bağlı: yeni zamanlayıcı ve yeni istek YOK", () => {
    const app = oku("app.js");
    const poll = app.slice(app.indexOf("async function poll()"));
    assert.match(poll, /detayYasiTazele\(\)/, "yaş satırı tura bağlanmamış");
    assert.match(oku("arsiv.js"), /export function detayYasiTazele/);
    // Tazeleme YALNIZ metin yazar: ne api() çağırır ne yeniden çizer.
    const govde = oku("arsiv.js").split("export function detayYasiTazele")[1]!.split("\n}")[0]!;
    for (const yasak of ["api(", "renderPreview(", "setInterval("])
      assert.ok(!govde.includes(yasak), `yaş tazelemesi fazlasını yapıyor: ${yasak}`);
  });

  test("ARAYÜZ İKİNCİ BİR BAŞLIK TABLOSU YAZMAZ", () => {
    const detay = oku("detay.js");
    // Motor tablosundaki başlıklardan hiçbiri web modülünde sabit yazılmamalı.
    for (const baslik of ["İşlem sonucu", "Vekâlet ücreti", "Safahat no", "Baba adı"])
      assert.ok(!detay.includes(baslik), `başlık web modülünde tekrarlanmış: ${baslik}`);
    assert.ok(!/ALAN_TABLOSU|ALAN_BASLIK/.test(detay));
    assert.ok(!/JSON\.stringify/.test(detay), "ekran JSON metni basıyor");
  });

  test("`detay.js` web varlıkları haritasında (yoksa üç sekme de boş açılır)", () => {
    const web = readFileSync(new URL("../../src/server/web.ts", import.meta.url), "utf8");
    assert.match(web, /\["\/detay\.js", \["detay\.js"/);
    for (const uc of ['"safahat"', '"taraflar"', '"hesap"'])
      assert.ok(web.includes(uc), `IZINLI kümesinde eksik: ${uc}`);
  });

  test("SorguOnbellek yaşı doğru söyler: süren sorguya katılan çağrı da önbellektendir", async () => {
    let saat = 1_000_000;
    const onbellek = new SorguOnbellek<number>(60 * 60_000, () => saat);
    let sayac = 0;
    const sorgu = async () => ++sayac;
    const a = await onbellek.getirDamgali("k", sorgu);
    assert.deepEqual(a, { deger: 1, at: saat, onbellekten: false });
    saat += 30 * 60_000;
    const b = await onbellek.getirDamgali("k", sorgu);
    assert.equal(b.onbellekten, true);
    assert.equal(b.at, 1_000_000, "önbellek yaşı tazelenmiş");
    assert.equal(sayac, 1);
    saat += 31 * 60_000;
    const c = await onbellek.getirDamgali("k", sorgu);
    assert.equal(c.onbellekten, false);
    assert.equal(c.at, saat);
    assert.equal(sayac, 2);
  });
});
