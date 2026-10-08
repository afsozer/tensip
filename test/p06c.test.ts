// P06c — YAZMA YARIDA KALIRSA ARŞİV TUTARLI KALIR MI?
//
// ── BU DOSYA NEYİ ÖLÇER ─────────────────────────────────────────────────────
// Bu turda yazma yollarında ÜÇ ayrı veri yok etme hatası bulundu (P19, P20 ve
// P20 onarımı) ve üçü de NORMAL akışta çıktı. Buradaki soru başka: yazım
// YARIDA KALIRSA ne oluyor? Yedi kesinti noktasının her biri için kesinti
// uygulanır, motor yeniden açılır ve sonuç ÖLÇÜLÜR.
//
// ÖLÇÜT SAYI DEĞİL İÇERİK (P20 dersi): kayıt ve dosya sayısı sabitken içerik
// yok olabiliyor. Bu yüzden kesinti testleri `belgeKumesi()` ile arşivdeki
// BELGE İÇERİKLERİNİN kümesini karşılaştırır; hiçbir senaryoda bir belge
// kümeden düşmez.
//
// Bütün veriler SENTETİKTİR. Gerçek arşive (~/Documents/UYAPAsistan), gerçek
// ayar dizinine (~/.config/tensip) ve çalışan motora dokunulmaz; portal
// istemcisi yalnız sahte portala bakar.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  constants,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import {
  geciciYazimYolu,
  yarimYazimHedefi,
  yazJsonAtomik,
  yazMetinAtomik,
} from "../src/store/fsops.js";
import {
  MANIFEST_ADI,
  MANIFEST_YEDEK_DESENI,
  manifestiYedekle,
} from "../src/store/manifest.js";
import { arsiviDenetle, type Bulgu } from "../src/store/denetim.js";
import { metniYenidenUret, onarimBilgisi } from "../src/store/onarim.js";
import { sadelestir } from "../src/store/sadelestir.js";
import { IsDepo } from "../src/jobs/depo.js";
import { daemonKur } from "../src/server/daemon.js";
import { MockUyap, opakToken, type MockEvrak } from "./mock-uyap/sunucu.js";
import { caseKeyYap, type DavaKaydi } from "../src/store/registry.js";
import { makeHtml, tmpKok } from "./yardimci.js";

const sha = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const turleri = (b: Bulgu[], t: string) => b.filter((x) => x.tur === t);

/** Klasördeki her dosyanın içerik özeti + boyut + izin biti. */
function parmakIzi(kok: string): Map<string, string> {
  const tablo = new Map<string, string>();
  const yuru = (dizin: string) => {
    for (const g of readdirSync(dizin, { withFileTypes: true })) {
      const tam = join(dizin, g.name);
      if (g.isDirectory()) {
        yuru(tam);
        continue;
      }
      if (!g.isFile()) continue;
      const bilgi = statSync(tam);
      tablo.set(
        relative(kok, tam),
        `${sha(readFileSync(tam))}:${bilgi.size}:${(bilgi.mode & 0o777).toString(8)}`,
      );
    }
  };
  yuru(kok);
  return tablo;
}

function fark(once: Map<string, string>, sonra: Map<string, string>): string[] {
  const cikti: string[] = [];
  for (const [k, v] of once) {
    if (!sonra.has(k)) cikti.push(`silindi: ${k}`);
    else if (sonra.get(k) !== v) cikti.push(`değişti: ${k}`);
  }
  for (const k of sonra.keys()) if (!once.has(k)) cikti.push(`eklendi: ${k}`);
  return cikti.sort();
}

/**
 * ARŞİVDEKİ BELGELERİN İÇERİK KÜMESİ — kesinti testlerinin asıl ölçütü.
 *
 * Kayıt sayısı ve dosya sayısı sabitken içeriğin yok olabildiği P20'de
 * ölçüldü. Bu yüzden "kaybolmadı" cümlesi ancak belgenin İÇİNDEKİ ayırt edici
 * damganın hâlâ diskte olmasıyla kurulur.
 */
function belgeKumesi(klasor: string): Set<string> {
  const kume = new Set<string>();
  const yuru = (dizin: string) => {
    for (const g of readdirSync(dizin, { withFileTypes: true })) {
      const tam = join(dizin, g.name);
      if (g.isDirectory()) {
        yuru(tam);
        continue;
      }
      if (!g.isFile()) continue;
      const metin = readFileSync(tam, "utf8");
      const damga = /SENTETIK ([A-Z0-9]+) belge/.exec(metin);
      if (damga !== null) kume.add(damga[1]!);
    }
  };
  yuru(join(klasor, "_kaynak"));
  return kume;
}

// ── BÖLÜM 1 — YAZICI (kabul ölçütü 8 + kesinti noktası 5) ───────────────────
//
// 14 Eylül'de ölçülen kusur: `yazMetinAtomik` (KULLANICININ BELGELERİNİ yazan
// yol) `yazJsonAtomik`ten zayıftı — `Date.now()` geçici ad, düz
// `writeFileSync`, fsync YOK, hata hâlinde temizlik YOK, izin belirtilmemiş.
describe("P06c yazıcı: yarım kalan yazım geride ARTIK BIRAKMAZ", () => {
  const t = tmpKok();
  after(() => t.temizle());

  test("rename düşerse geçici dosya TEMİZLENİR ve hedef bozulmaz", () => {
    const dizin = join(t.kok, "rename-dussun");
    mkdirSync(dizin, { recursive: true });
    // Hata enjeksiyonu: hedef yolda BOŞ OLMAYAN bir dizin duruyor; `rename`
    // ENOTEMPTY ile düşer. Bu, "yazım bitti ama yerine konamadı" anıdır —
    // ENOSPC'nin ve SIGKILL'in bıraktığı durumun aynısı.
    const hedef = join(dizin, "belge.html");
    mkdirSync(hedef, { recursive: true });
    writeFileSync(join(hedef, "icerik"), "dokunulmaması gereken veri");
    const once = parmakIzi(dizin);
    assert.throws(() => yazMetinAtomik(hedef, "yeni içerik"));
    const kalanlar = readdirSync(dizin).filter((a) => a.endsWith(".tmp"));
    assert.deepEqual(kalanlar, [], "yarım kalan yazım .tmp bırakmamalı");
    assert.deepEqual(fark(once, parmakIzi(dizin)), [], "hedefteki veri değişmemeli");
  });

  test("hiç açılamayan yazım (izin yok) geride dosya bırakmaz", () => {
    const dizin = join(t.kok, "yazilamaz");
    mkdirSync(dizin, { recursive: true });
    writeFileSync(join(dizin, "eski.html"), "eski içerik");
    const once = parmakIzi(dizin);
    chmodSync(dizin, 0o500);
    try {
      assert.throws(() => yazMetinAtomik(join(dizin, "eski.html"), "yeni içerik"));
    } finally {
      chmodSync(dizin, 0o700);
    }
    assert.deepEqual(fark(once, parmakIzi(dizin)), [], "tek bayt değişmemeli");
  });

  test("belge 0600 yazılır: manifestle aynı izin", () => {
    const hedef = join(t.kok, "izin", "belge.html");
    yazMetinAtomik(hedef, "içerik");
    assert.equal(statSync(hedef).mode & 0o777, 0o600);
  });

  // ÖLÇÜLEN KUSUR: eski geçici ad `pid + Date.now()` idi ve indirme döngüsü
  // aynı milisaniyede birden çok belge yazıyor. Bu test iki adı da üretir ve
  // ESKİ desenin gerçekten çakıştığını ÖLÇER — iddia değil.
  test("geçici ad çakışmaz; ESKİ Date.now deseni ÖLÇÜLEBİLİR biçimde çakışıyordu", () => {
    const yeni = new Set<string>();
    const eski = new Set<string>();
    const N = 5000;
    for (let i = 0; i < N; i++) {
      yeni.add(geciciYazimYolu(join(t.kok, "belge.html")));
      eski.add(join(t.kok, `.belge.html.${process.pid}.${Date.now()}.tmp`));
    }
    assert.equal(yeni.size, N, "yeni ad üreticisi tek bir çakışma bile vermemeli");
    assert.ok(
      eski.size < N,
      `eski desen bu makinede çakışmadı (${eski.size}/${N}); kusur ölçülemedi`,
    );
  });

  // BEKÇİ: iki yazıcının AYRI gövdeleri, bu paketin kapattığı kusurun ta
  // kendisiydi. Ayrışma yeniden başlarsa bu test düşer.
  test("JSON ve BELGE yazıcısı AYNI gövdeyi kullanır ve gövdede fsync vardır", async () => {
    const kaynak = readFileSync(
      new URL("../src/store/fsops.js", import.meta.url),
      "utf8",
    );
    assert.equal(
      (kaynak.match(/fsyncSync\(/g) ?? []).length,
      1,
      "fsync tek gövdede olmalı: ikinci bir yazıcı gövdesi açılmış olabilir",
    );
    assert.equal((kaynak.match(/atomikYaz\(/g) ?? []).length, 3, "iki çağıran + tanım");
    // Davranış tarafı: ikisi de aynı geçici ad desenini bırakır ve o desen
    // denetimin tanıdığı desendir.
    const ad = geciciYazimYolu(join(t.kok, "x.json"));
    assert.equal(yarimYazimHedefi(ad.split("/").pop()!), "x.json");
  });

  test("JSON yazıcısı da 0600 ve artıksız kalır", () => {
    const hedef = join(t.kok, "json", "kayit.json");
    yazJsonAtomik(hedef, { a: 1 });
    assert.equal(statSync(hedef).mode & 0o777, 0o600);
    assert.deepEqual(
      readdirSync(join(t.kok, "json")).filter((a) => a.endsWith(".tmp")),
      [],
    );
  });
});

// ── BÖLÜM 2 — MANİFEST YEDEĞİ (kabul ölçütü 10) ─────────────────────────────
describe("P06c manifest yedeği: aynı milisaniyede iki yedek ÇAKIŞMAZ", () => {
  const t = tmpKok();
  after(() => t.temizle());

  /** Saati DONDURUR: aynı milisaniyede arka arkaya yedek almanın tek yolu. */
  function donmusSaatte<T>(fn: () => T): T {
    const gercek = Date.now;
    Date.now = () => 1_757_800_000_000;
    try {
      return fn();
    } finally {
      Date.now = gercek;
    }
  }

  test("aynı milisaniyede ÜÇ yedek: üçü de yazılır, üçü de manifestin kopyasıdır", () => {
    const klasor = join(t.kok, "dava-1");
    mkdirSync(klasor, { recursive: true });
    const govde = JSON.stringify({ surum: 1, dosyaId: "X", evraklar: [] });
    writeFileSync(join(klasor, MANIFEST_ADI), govde);

    const adlar = donmusSaatte(() => [
      manifestiYedekle(klasor),
      manifestiYedekle(klasor),
      manifestiYedekle(klasor),
    ]);
    assert.equal(new Set(adlar).size, 3, "üç ayrı ad");
    for (const ad of adlar) {
      assert.match(ad, MANIFEST_YEDEK_DESENI, "ad deseni denetimin tanıdığı desen olmalı");
      assert.equal(readFileSync(join(klasor, ad), "utf8"), govde);
    }
    // ESKİ DAVRANIŞ ÖLÇÜLDÜ: tek adla ikinci kopya EEXIST fırlatıyordu.
    assert.throws(
      () =>
        donmusSaatte(() =>
          copyFileSync(
            join(klasor, MANIFEST_ADI),
            join(klasor, `uyap-project.yedek-${Date.now()}.json`),
            constants.COPYFILE_EXCL,
          ),
        ),
      /EEXIST/,
    );
  });

  // BEKÇİ (P06c): ad kalıbı TEK yerde. Orkestratör kendi `Date.now()` adını
  // kuran bir kopya taşıyordu; o kopya aynı milisaniyede EEXIST fırlatıp
  // eşitlemeyi düşürüyordu ve yeni desen eklendiğinde denetimin gözünden de
  // kaçardı. Yeni bir çağıran kendi adını kurarsa bu test düşer.
  test("BEKÇİ: yedek adını yalnız manifest modülü kurar", () => {
    for (const modul of ["../src/jobs/orchestrator.js", "../src/store/sadelestir.js", "../src/store/onarim.js", "../src/store/denetim.js"]) {
      // Yorum satırları elenir: kural KODA bakar, anlatıma değil.
      const kod = readFileSync(new URL(modul, import.meta.url), "utf8")
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join("\n");
      assert.equal(
        /uyap-project\.yedek-/.test(kod),
        false,
        `${modul} yedek adını kendisi kuruyor`,
      );
    }
  });

  test("soneki olan yedek denetimde YETİM sayılmaz", async () => {
    const kurulum = davaKur(t.kok, "Yedek Mahkemesi", "2026/701", [
      { ad: "a.html", icerik: "SENTETIK ALFA belge" },
    ]);
    const adlar = donmusSaatte(() => [
      manifestiYedekle(kurulum.klasor),
      manifestiYedekle(kurulum.klasor),
    ]);
    assert.equal(new Set(adlar).size, 2);
    const s = await arsiviDenetle({
      kok: t.kok,
      davalar: [kurulum.kayit],
      caseKey: kurulum.kayit.caseKey,
    });
    assert.equal(s.sayilar.yedek, 2, "iki yedek de yedek sayılmalı");
    assert.equal(turleri(s.bulgular, "yetim-dosya").length, 0);
    assert.equal(s.sayilar.bulgu, 0);
  });
});

// ── BÖLÜM 3 — DENETİM YARIM YAZIMI GÖRÜR (kabul ölçütleri 3, 5, 9) ──────────
describe("P06c denetim: yarım kalmış yazım AYRI bulgudur", () => {
  const t = tmpKok();
  after(() => t.temizle());

  const artikYaz = (klasor: string, hedefAd: string, damga: string): string => {
    const dizin = join(klasor, "_kaynak", "evraklar", "Gelen", "02-Dilekceler");
    mkdirSync(dizin, { recursive: true });
    const ad = `.${hedefAd}.4141.${damga}.tmp`;
    writeFileSync(join(dizin, ad), "yarım inmiş baytlar");
    return ad;
  };

  test("YENİ desen (uuid): ayrı tür, ayrı eksen, ağırlığı BULGU", async () => {
    const k = davaKur(t.kok, "Kesinti Mahkemesi", "2026/711", [
      { ad: "a.html", icerik: "SENTETIK ALFA belge" },
    ]);
    const ad = artikYaz(k.klasor, "beta.html", randomUUID());
    const s = await arsiviDenetle({ kok: t.kok, davalar: [k.kayit], caseKey: k.kayit.caseKey });
    const bulgu = turleri(s.bulgular, "yarim-yazim");
    assert.equal(bulgu.length, 1, "yarım yazım tek satır olarak görünmeli");
    assert.equal(bulgu[0]!.eksen, "yarim");
    assert.equal(bulgu[0]!.agirlik, "bulgu", "kesinti sonrası denetim 'temiz' diyemez");
    assert.ok(bulgu[0]!.yol.endsWith(ad));
    assert.match(bulgu[0]!.aciklama, /beta\.html/, "hangi yazımın kesildiği yazılmalı");
    assert.equal(turleri(s.bulgular, "yetim-dosya").length, 0, "kayıtsız dosyayla aynı kefeye girmemeli");
    assert.equal(s.sayilar.yarim, 1);
    assert.equal(s.sayilar.bulgu, 1);
  });

  test("ESKİ desen (Date.now) de tanınır: eski sürümün artığı görünmez kalmaz", async () => {
    const k = davaKur(t.kok, "Kesinti Mahkemesi", "2026/712", [
      { ad: "a.html", icerik: "SENTETIK ALFA belge" },
    ]);
    artikYaz(k.klasor, "gama.html", "1757800000000");
    const s = await arsiviDenetle({ kok: t.kok, davalar: [k.kayit], caseKey: k.kayit.caseKey });
    assert.equal(turleri(s.bulgular, "yarim-yazim").length, 1);
  });

  test("NEGATİF: .DS_Store ve diğer gizli dosyalar hâlâ ATLANIR", async () => {
    const k = davaKur(t.kok, "Kesinti Mahkemesi", "2026/713", [
      { ad: "a.html", icerik: "SENTETIK ALFA belge" },
    ]);
    writeFileSync(join(k.klasor, ".DS_Store"), "finder");
    writeFileSync(join(k.klasor, ".gizli-not.txt"), "kullanıcının kendi dosyası");
    const s = await arsiviDenetle({ kok: t.kok, davalar: [k.kayit], caseKey: k.kayit.caseKey });
    assert.equal(turleri(s.bulgular, "yarim-yazim").length, 0);
    assert.equal(s.sayilar.bulgu, 0);
    assert.ok(s.sayilar.atlanan >= 2);
  });

  test("onarım tablosu: düğme ÇİZİLMEZ ve sebebi yazılıdır", () => {
    const o = onarimBilgisi("yarim-yazim");
    assert.equal(o.eylem, null, "ürün ilk kez belge dosyası SİLEN düğmeye sahip olmamalı");
    assert.ok(o.sebep.length > 20);
  });

  // ── İNCELEME BULGUSU — KAPANMAYAN BULGU ───────────────────────────────────
  // ÖLÇÜLDÜ: hedef belge sağlam biçimde geri geldikten SONRA da satır `bulgu`
  // kalıyordu ve "ilgili dosyayı yeniden eşitleyin" diyordu — kullanıcı o
  // eşitlemeyi zaten yapmıştı. Düğme de bilerek yok, yani bulgu uygulama
  // içinden ASLA kapanamıyordu: sağlıklı arşiv kalıcı olarak "1 bulgu"
  // okunuyordu. Paketin korumaya çalıştığı sinyalin tersi.
  test("HEDEF SAĞLAM GELDİYSE satır kapanır: ağırlık `bilgi`, metin yeniden eşitleme İSTEMEZ", async () => {
    const k = davaKur(t.kok, "Kesinti Mahkemesi", "2026/714", [
      { ad: "a.html", icerik: "SENTETIK ALFA belge" },
    ]);
    // Artığın hedefi TAM DA kayıtlı ve özetiyle birebir duran belge.
    const ad = artikYaz(k.klasor, "a.html", randomUUID());
    const s = await arsiviDenetle({ kok: t.kok, davalar: [k.kayit], caseKey: k.kayit.caseKey });

    assert.equal(s.sayilar.saglam, 1, "hedef belge özetiyle birebir ölçülmeli");
    assert.equal(turleri(s.bulgular, "yarim-yazim").length, 0, "arıza satırı kalmamalı");
    const kapali = turleri(s.bulgular, "yarim-yazim-artigi");
    assert.equal(kapali.length, 1);
    assert.equal(kapali[0]!.eksen, "yarim", "kesinti hâlâ kendi grubunda görünür");
    assert.equal(kapali[0]!.agirlik, "bilgi");
    assert.ok(kapali[0]!.yol.endsWith(ad));
    assert.match(kapali[0]!.aciklama, /a\.html/, "hangi hedefin sağlam olduğu yazılmalı");
    // Cümle eşitlemeyi EMRETMEZ; tam tersini söyler.
    assert.equal(
      /eşitleyin/i.test(kapali[0]!.aciklama),
      false,
      "kullanıcının zaten yaptığı iş tekrar önerilmemeli",
    );
    assert.match(kapali[0]!.aciklama, /eşitlemeye gerek yok/);
    // KESİNTİ GÖRÜNÜR KALIR ama sağlıklı arşiv artık "bulgu" okunmaz.
    assert.equal(s.sayilar.yarim, 1, "artık hâlâ sayılıyor");
    assert.equal(s.sayilar.bulgu, 0, "sağlam arşiv kalıcı olarak bozuk okunmamalı");
    assert.equal(s.sayilar.bilgi, 1);
  });

  test("NEGATİF: hedef YERİNDE ama içeriği kaydını TUTMUYORSA satır BULGU kalır", async () => {
    const k = davaKur(t.kok, "Kesinti Mahkemesi", "2026/715", [
      { ad: "a.html", icerik: "SENTETIK ALFA belge" },
    ]);
    // Yazım yarıda kalmış ve hedef ESKİ/BOZUK hâlinde: tam da uyarılması
    // gereken durum. Özet tutmadığı için "sağlam" denemez.
    writeFileSync(
      join(k.klasor, "_kaynak", "evraklar", "Gelen", "02-Dilekceler", "a.html"),
      "SENTETIK ALFA belge (yarım)",
    );
    artikYaz(k.klasor, "a.html", randomUUID());
    const s = await arsiviDenetle({ kok: t.kok, davalar: [k.kayit], caseKey: k.kayit.caseKey });
    assert.equal(turleri(s.bulgular, "yarim-yazim-artigi").length, 0);
    const acik = turleri(s.bulgular, "yarim-yazim");
    assert.equal(acik.length, 1);
    assert.equal(acik[0]!.agirlik, "bulgu");
    assert.match(acik[0]!.aciklama, /yeniden eşitleyin/);
    assert.equal(turleri(s.bulgular, "hash-uyusmuyor").length, 1, "hedefin kendi satırı da çıkar");
  });

  test("NEGATİF: hedef KAYITSIZ bir dosyaysa (özeti hiç ölçülmedi) satır BULGU kalır", async () => {
    const k = davaKur(t.kok, "Kesinti Mahkemesi", "2026/716", [
      { ad: "a.html", icerik: "SENTETIK ALFA belge" },
    ]);
    const dizin = join(k.klasor, "_kaynak", "evraklar", "Gelen", "02-Dilekceler");
    writeFileSync(join(dizin, "kayitsiz.html"), "SENTETIK KAYITSIZ belge");
    artikYaz(k.klasor, "kayitsiz.html", randomUUID());
    const s = await arsiviDenetle({ kok: t.kok, davalar: [k.kayit], caseKey: k.kayit.caseKey });
    assert.equal(
      turleri(s.bulgular, "yarim-yazim-artigi").length,
      0,
      "manifest'te özeti olmayan dosyaya 'sağlam' denemez",
    );
    assert.equal(turleri(s.bulgular, "yarim-yazim").length, 1);
    assert.equal(s.sayilar.bulgu, 1);
  });

  test("NEGATİF: hedef .md TÜREVİYSE satır BULGU kalır (manifestte özeti yoktur)", async () => {
    const k = davaKur(t.kok, "Kesinti Mahkemesi", "2026/717", [
      { ad: "a.html", icerik: "SENTETIK ALFA belge" },
    ]);
    const mdDizin = join(k.klasor, "evraklar", "Gelen", "02-Dilekceler");
    writeFileSync(join(mdDizin, `.a.md.4141.${randomUUID()}.tmp`), "yarım metin");
    const s = await arsiviDenetle({ kok: t.kok, davalar: [k.kayit], caseKey: k.kayit.caseKey });
    assert.equal(turleri(s.bulgular, "yarim-yazim-artigi").length, 0);
    assert.equal(turleri(s.bulgular, "yarim-yazim").length, 1);
    assert.equal(s.sayilar.bulgu, 1);
  });

  test("onarım tablosu: kapanmış artıkta da düğme YOK ama sebep yeniden eşitleme İSTEMEZ", () => {
    const o = onarimBilgisi("yarim-yazim-artigi");
    assert.equal(o.eylem, null, "ürün hâlâ belge dosyası SİLEN düğmeye sahip olmamalı");
    assert.notEqual(o.sebep, onarimBilgisi("yarim-yazim").sebep, "iki durum aynı cümleyi almaz");
    assert.equal(
      /yeniden eşitle/i.test(o.sebep),
      false,
      "kapanmış kesinti için bitmeyen iş önerilmemeli",
    );
    // Tabloda GERÇEKTEN kendi satırı olmalı: eksik anahtar genel "tanımlı
    // onarım yok" cümlesine düşer ve kullanıcıya hedefin sağlam olduğunu
    // söylemez.
    assert.match(o.sebep, /birebir/, "sebep hedefin durumunu anlatmalı");
  });

  test("arayüz: 'Kayıtsız dosyalar' grubunun ALTINA düşmez, düğme yoktur", async () => {
    const M = (await import(new URL("../../web/denetim.js", import.meta.url).href)) as Record<
      string,
      (...a: unknown[]) => unknown
    >;
    const bulgu: Bulgu = {
      tur: "yarim-yazim",
      eksen: "yarim",
      agirlik: "bulgu",
      onarim: onarimBilgisi("yarim-yazim"),
      caseKey: "X",
      dava: "X Mahkemesi 2026/1",
      yol: "_kaynak/evraklar/Gelen/02-Dilekceler/.beta.html.41.abc12345.tmp",
      aciklama: "Bir yazım tamamlanmadan kesilmiş.",
    };
    const gruplar = (M["denetimGruplari"] as (b: Bulgu[]) => { eksen: string; baslik: string }[])([
      bulgu,
    ]);
    assert.deepEqual(
      gruplar.map((g) => g.eksen),
      ["yarim"],
    );
    assert.match(gruplar[0]!.baslik, /Yarım kalmış/);
    const html = (M["bulguSatiri"] as (b: Bulgu) => string)(bulgu);
    assert.equal(html.includes("<button"), false, "onarılamayan satırda düğme çizilmez");
    assert.match(html, /Yarım kalmış yazım/);
    // Özet cümlesi kesintiden sonra "Bulgu yok" DEMEZ.
    const ozet = (M["denetimOzetMetni"] as (s: unknown) => string)({
      tamamlandi: true,
      kapsam: { tumArsiv: true },
      sayilar: { dava: 1, denetlenen: 1, kayit: 1, saglam: 1, bulgu: 1, bilgi: 0 },
    });
    assert.equal(ozet.includes("Bulgu yok"), false);
  });

  test("arayüz: KAPANMIŞ artık ayrı etiket alır, grup notu bitmeyen iş VAAT ETMEZ", async () => {
    const M = (await import(new URL("../../web/denetim.js", import.meta.url).href)) as Record<
      string,
      (...a: unknown[]) => unknown
    >;
    const kapali: Bulgu = {
      tur: "yarim-yazim-artigi",
      eksen: "yarim",
      agirlik: "bilgi",
      onarim: onarimBilgisi("yarim-yazim-artigi"),
      caseKey: "X",
      dava: "X Mahkemesi 2026/1",
      yol: "_kaynak/evraklar/Gelen/02-Dilekceler/.a.html.41.abc12345.tmp",
      aciklama: "Bir yazım kesilmiş ama hedefi sonradan tamamlanmış.",
    };
    const gruplar = (
      M["denetimGruplari"] as (b: Bulgu[]) => { eksen: string; baslik: string; not: string }[]
    )([kapali]);
    assert.deepEqual(
      gruplar.map((g) => g.eksen),
      ["yarim"],
      "kesinti hâlâ kendi grubunda görünür, gizlenmez",
    );
    assert.equal(
      /asıl soru hedef belgenin durumudur/.test(gruplar[0]!.not),
      false,
      "bütün satırlar kapanmışsa grup cevaplanmamış soru vaat etmez",
    );

    const html = (M["bulguSatiri"] as (b: Bulgu) => string)(kapali);
    assert.equal(html.includes("<button"), false, "silme düğmesi hâlâ yok");
    assert.match(html, /Artık dosya \(hedef sağlam\)/, "ayrı etiket");
    assert.equal(
      html.includes("Yarım kalmış yazım<"),
      false,
      "arıza etiketiyle aynı kefeye girmemeli",
    );
    assert.match(html, /class="tag bilinmiyor"/, "rozet kırmızı (bad) değil");

    // TEK BULGU olan artık kapandığında özet cümlesi "bulgu" DEMEZ.
    const ozet = (M["denetimOzetMetni"] as (s: unknown) => string)({
      tamamlandi: true,
      kapsam: { tumArsiv: true },
      sayilar: { dava: 1, denetlenen: 1, kayit: 1, saglam: 1, bulgu: 0, bilgi: 1 },
    });
    assert.match(ozet, /Bulgu yok/);
    assert.equal((M["denetimSekmeSayaci"] as (s: unknown) => string)({ sayilar: { bulgu: 0 } }), "");
  });

  // ARIZA VARKEN grup notu ESKİSİ GİBİ kalmalı: kapanmış satırın metni,
  // yanındaki gerçek arızayı yumuşatmamalı.
  test("arayüz: aynı grupta bir arıza varsa not YİNE hedef belgeyi işaret eder", async () => {
    const M = (await import(new URL("../../web/denetim.js", import.meta.url).href)) as Record<
      string,
      (...a: unknown[]) => unknown
    >;
    const yap = (tur: string, agirlik: string): Bulgu =>
      ({
        tur,
        eksen: "yarim",
        agirlik,
        onarim: onarimBilgisi(tur as Bulgu["tur"]),
        caseKey: "X",
        dava: "X Mahkemesi 2026/1",
        yol: `_kaynak/.${tur}.41.abc12345.tmp`,
        aciklama: "…",
      }) as Bulgu;
    const gruplar = (
      M["denetimGruplari"] as (b: Bulgu[]) => { not: string }[]
    )([yap("yarim-yazim-artigi", "bilgi"), yap("yarim-yazim", "bulgu")]);
    assert.equal(gruplar.length, 1);
    assert.match(gruplar[0]!.not, /asıl soru hedef belgenin durumudur/);
  });
});

// ── SENTETİK DAVA KURUCU (denetim testlerinin ortak zemini) ─────────────────
interface EvrakTanim {
  ad: string;
  icerik: string;
}

const OPAK = (ad: string) => `OPAK-TOKEN-${ad}-4c1e9a`;

function davaKur(
  kok: string,
  birimAdi: string,
  esasNo: string,
  evraklar: EvrakTanim[],
): { kayit: DavaKaydi; klasor: string } {
  const klasor = join(kok, "Avukat UYAP", "AVUKAT", "Hukuk", `${birimAdi} ${esasNo.replace("/", "-")}`);
  mkdirSync(klasor, { recursive: true });
  const satirlar = evraklar.map((e, i) => {
    const rel = `_kaynak/evraklar/Gelen/02-Dilekceler/${e.ad}`;
    const tam = join(klasor, rel);
    mkdirSync(join(tam, ".."), { recursive: true });
    writeFileSync(tam, e.icerik);
    const mdRel = `evraklar/Gelen/02-Dilekceler/${e.ad.replace(/\.[^.]+$/, "")}.md`;
    const mdTam = join(klasor, mdRel);
    mkdirSync(join(mdTam, ".."), { recursive: true });
    writeFileSync(mdTam, `# ${e.ad}\n\nsentetik metin\n`);
    return {
      evrakId: OPAK(e.ad),
      stableKey: `ana:${100 + i}`,
      path: rel,
      sha256: sha(e.icerik),
      isEkEvrak: false,
      category: "02-Dilekceler",
      yon: "Gelen",
      tur: "Dilekçe",
      gonderen: "Sentetik Gönderen",
      tarih: `0${(i % 9) + 1}/09/2026`,
      birimEvrakNo: String(100 + i),
      dosyaKey: "sentetik-dosya-key",
      mdStatus: "ok",
      mdPath: mdRel,
      boyut: Buffer.byteLength(e.icerik),
    };
  });
  writeFileSync(
    join(klasor, MANIFEST_ADI),
    JSON.stringify(
      {
        surum: 1,
        dosyaId: OPAK(`dosya-${esasNo}`),
        mahkeme: birimAdi,
        birimId: "7100",
        esasNo,
        isIcra: false,
        clonedAt: "2026-09-01T10:00:00.000Z",
        evraklar: satirlar,
      },
      null,
      2,
    ),
  );
  const kayit: DavaKaydi = {
    caseKey: caseKeyYap(birimAdi, esasNo),
    portal: "avukat",
    kaynak: ["sentetik"],
    dosyaNo: esasNo,
    birimAdi,
    birimId: "7100",
    group: "Hukuk",
    kod: "HUKUK MAHKEMESI",
    yargiTuru: "1",
    isIcra: false,
    isCbs: false,
    kapsam: "hepsi",
    portalGoruldu: "2026-09-01T10:00:00.000Z",
    klonYolu: klasor,
  };
  return { kayit, klasor };
}

// ── BÖLÜM 4 — YEDİ KESİNTİ NOKTASI, GERÇEK MOTORLA ──────────────────────────
//
// Kurulum: izole ayar dizini + izole arşiv + sahte portal. Her senaryoda
// kesinti DİSKTEKİ DURUM olarak kurulur (yazımın yarıda kaldığı an), motor
// YENİDEN AÇILIR ve sonuç ölçülür.
describe("P06c yedi kesinti noktası: motor yeniden açılınca ne oluyor?", () => {
  const BIRIM = "Sentetik P06c Asliye Hukuk";
  const BIRIM_ID = "9460";
  const ESAS = "2026/706";
  const ayar = tmpKok();
  const kok = tmpKok();
  let mock: MockUyap;
  let klasor = "";
  let baslangicBelgeler: Set<string>;

  const belge = (ad: string, no: string): MockEvrak => ({
    evrakId: opakToken(`p06c-${ad}`),
    tur: "Müzekkere",
    gonderen: "Sentetik Kalem",
    tip: "GDN",
    tarih: "08/09/2026",
    birimEvrakNo: no,
    durum: "yuklu",
    contentTipi: "text/html; charset=UTF-8",
    icerik: makeHtml(`<div>SENTETIK ${ad.toUpperCase()} belge metni.</div>`, "Sentetik Belge"),
  });

  const motor = () =>
    daemonKur({
      ayarDir: ayar.kok,
      kok: kok.kok,
      portalUrl: mock.adres(),
      appVersion: "1.1.0-p06c",
      istekAralikMs: 1,
      oturumYenileMs: 0,
      webPort: 0,
    });

  async function bekle(d: ReturnType<typeof daemonKur>, isId: string): Promise<string> {
    for (let i = 0; i < 900; i++) {
      const is = d.orkestrator.isGetir(isId);
      if (is && is.durum !== "calisiyor" && is.durum !== "bekliyor") return is.durum;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("iş bitmedi");
  }

  before(async () => {
    mock = new MockUyap({
      birimler: [{ birimId: BIRIM_ID, birimAdi: BIRIM, yargiTuru: "1" }],
      davalar: [
        {
          dosyaId: opakToken("p06c-dosya"),
          birimAdi: BIRIM,
          birimId: BIRIM_ID,
          esasNo: ESAS,
          dosyaTur: "Hukuk Dava Dosyası",
          dosyaDurum: "Açık",
          yargiTuru: "1",
          evraklar: [belge("alfa", "801"), belge("beta", "802"), belge("cem", "803")],
        },
      ],
    });
    await mock.baslat();
    const d = motor();
    await d.rpc.baslat();
    d.oturum.girisYap("JSESSIONID=p06c-sentetik-cerez", "manuel");
    const is = d.orkestrator.klonlaBaslat({
      birimAdi: BIRIM,
      esasNo: ESAS,
      kapsam: "hepsi",
      avukat: "Sentetik Avukat",
    });
    assert.equal(await bekle(d, is.isId), "hazir");
    klasor = d.registry.hepsi()[0]!.klonYolu!;
    baslangicBelgeler = belgeKumesi(klasor);
    assert.deepEqual([...baslangicBelgeler].sort(), ["ALFA", "BETA", "CEM"]);
    await d.kapat();
  });

  after(async () => {
    await mock.durdur();
    ayar.temizle();
    kok.temizle();
  });

  const manifestOku = () =>
    JSON.parse(readFileSync(join(klasor, MANIFEST_ADI), "utf8")) as {
      evraklar: { path: string; mdPath?: string; birimEvrakNo?: string }[];
    };

  // ── KESİNTİ 1 — kaynak yazıldı, manifest yazılmadı ────────────────────────
  test("1) kaynak diskte, kaydı yok: belge KAYBOLMAZ, denetim 'temiz' demez, eşitleme kaydı geri getirir", async () => {
    const oncekiManifest = readFileSync(join(klasor, MANIFEST_ADI), "utf8");
    const m = manifestOku();
    const dusen = m.evraklar.find((e) => e.birimEvrakNo === "803")!;
    // Kesintinin DİSKTEKİ hâli: dosya yazıldı, manifest o kaydı hiç görmedi.
    writeFileSync(
      join(klasor, MANIFEST_ADI),
      JSON.stringify(
        { ...JSON.parse(oncekiManifest), evraklar: m.evraklar.filter((e) => e !== dusen) },
        null,
        2,
      ),
    );

    const d = motor();
    await d.rpc.baslat();
    try {
      const s = await arsiviDenetle({ kok: kok.kok, davalar: d.registry.hepsi() });
      // Kayıtsız kaynak "çöp" değildir ve SİLİNMEZ; ama sessiz de kalmaz.
      const yetim = turleri(s.bulgular, "yetim-dosya");
      assert.ok(yetim.length >= 1, "kayıtsız kaynak raporda görünmeli");
      assert.ok(
        yetim.some((b) => b.yol === dusen.path),
        "raporda tam da o belge görünmeli",
      );
      assert.deepEqual(belgeKumesi(klasor), baslangicBelgeler, "hiçbir belge kaybolmadı");

      // Motor yeniden açılıp eşitlerse kayıt geri gelir ve BELGE KÜMESİ AYNI kalır.
      d.oturum.girisYap("JSESSIONID=p06c-sentetik-cerez", "manuel");
      const is = d.orkestrator.esitleBaslat(caseKeyYap(BIRIM, ESAS));
      assert.equal(await bekle(d, is.isId), "hazir");
      assert.equal(manifestOku().evraklar.length, 3, "üç kayıt geri geldi");
      assert.deepEqual(belgeKumesi(klasor), baslangicBelgeler, "eşitleme belge yok etmedi");
      // ÖLÇÜLEN DAVRANIŞ: kaydı olmayan dosya EZİLMEZ; portal aynı belgeyi
      // yeni bir yola indirir ve eski dosya kayıtsız kalır. Yani bu kesinti
      // arşivi BİR dosya büyütür, hiçbir belgeyi kaybettirmez.
      const yeniKayit = manifestOku().evraklar.find((e) => e.birimEvrakNo === "803")!;
      assert.notEqual(yeniKayit.path, dusen.path, "eski dosya ezilmedi, yeni yol açıldı");
      assert.equal(
        readFileSync(join(klasor, dusen.path), "utf8").includes("SENTETIK CEM"),
        true,
        "kayıtsız kalan eski dosya olduğu gibi duruyor",
      );
    } finally {
      await d.kapat();
    }
  });

  // ── KESİNTİ 2 / 6 — iş kaydı yarıda: "hazır" GÖRÜNMEZ ─────────────────────
  test("2+6) süreç iş sırasında ölürse iş 'kesildi' olur, 'hazir' GÖRÜNMEZ ve devam ettirilebilir", async () => {
    const depo = new IsDepo(ayar.kok);
    const isler = depo.oku();
    const sonIs = isler[isler.length - 1]!;
    // SIGKILL'in bıraktığı hâl: kayıt "calisiyor" kalmış, bitişi yazılmamış.
    depo.yaz([...isler.slice(0, -1), { ...sonIs, durum: "calisiyor", bitisAt: undefined }]);

    const d = motor();
    await d.rpc.baslat();
    try {
      const geri = d.orkestrator.isGetir(sonIs.isId)!;
      assert.equal(geri.durum, "kesildi", "yarım kalan iş 'hazir' görünemez");
      assert.match(geri.hata?.message ?? "", /kesildi/);
      assert.notEqual(geri.durum, "hazir");
      // Kullanıcı kararı: devam edebilir. Otomatik yeniden başlatma YOK.
      const devam = d.orkestrator.devamEt(sonIs.isId);
      assert.ok(devam !== null, "kesilen iş kullanıcı isterse devam ettirilebilir");
      assert.equal(await bekle(d, devam!.isId), "hazir");
      assert.deepEqual(belgeKumesi(klasor), baslangicBelgeler);
    } finally {
      await d.kapat();
    }
  });

  // ── KESİNTİ 3 ve 4 — onarım / sadeleştirme yarıda kaldı ───────────────────
  test("3+4) yedek alındı, yazım yarım: yedek kullanılabilir, denetim onu yetim SAYMAZ", async () => {
    const oncekiManifest = readFileSync(join(klasor, MANIFEST_ADI), "utf8");
    // Kesintinin diskteki hâli: `manifestiYedekle` döndü, yeni manifest yazılmadı.
    const yedek = manifestiYedekle(klasor);
    assert.match(yedek, MANIFEST_YEDEK_DESENI);

    const d = motor();
    await d.rpc.baslat();
    try {
      assert.equal(readFileSync(join(klasor, MANIFEST_ADI), "utf8"), oncekiManifest, "manifest bozulmadı");
      const yedekIcerik = JSON.parse(readFileSync(join(klasor, yedek), "utf8")) as {
        evraklar: unknown[];
      };
      assert.equal(yedekIcerik.evraklar.length, 3, "yedek kullanılabilir hâlde");
      const s = await arsiviDenetle({ kok: kok.kok, davalar: d.registry.hepsi() });
      assert.equal(
        turleri(s.bulgular, "yetim-dosya").filter((b) => MANIFEST_YEDEK_DESENI.test(b.yol)).length,
        0,
        "yedek çöp sayılmamalı",
      );
      assert.ok(s.sayilar.yedek >= 1);
      assert.deepEqual(belgeKumesi(klasor), baslangicBelgeler);

      // Yarıda kalan sadeleştirme TEKRAR denendiğinde aynı milisaniyede ikinci
      // yedek gerekebilir; eski adlandırma burada EEXIST ile düşüyordu.
      const plan = await sadelestir(kok.kok, klasor, true);
      assert.equal(plan.uygulandi, false, "düşürülecek fazla kayıt yok");
      assert.deepEqual(belgeKumesi(klasor), baslangicBelgeler);
    } finally {
      await d.kapat();
    }
  });

  // ── KESİNTİ 5 — yazım hatası (ENOSPC sınıfı) eşitlemenin ortasında ────────
  test("5) belge yazımı düşerse arşivde .tmp artığı kalmaz ve denetim onu görür", async () => {
    const dizin = join(klasor, "_kaynak", "evraklar", "Gelen", "02-Dilekceler");
    const hedef = join(dizin, "yazilamayan.html");
    mkdirSync(hedef, { recursive: true });
    writeFileSync(join(hedef, "engel"), "x");
    try {
      assert.throws(() => yazMetinAtomik(hedef, "yeni belge"));
      assert.deepEqual(
        readdirSync(dizin).filter((a) => a.endsWith(".tmp")),
        [],
        "başarısız yazım artık bırakmamalı",
      );
      // Artık BIRAKSAYDI denetim onu görürdü: aynı klasöre elle bir artık
      // konur ve denetimin bunu ayrı bulgu yaptığı ölçülür.
      const artik = `.yazilamayan.html.4141.${randomUUID()}.tmp`;
      writeFileSync(join(dizin, artik), "yarım baytlar");
      const d = motor();
      await d.rpc.baslat();
      try {
        const s = await arsiviDenetle({ kok: kok.kok, davalar: d.registry.hepsi() });
        assert.equal(turleri(s.bulgular, "yarim-yazim").length, 1);
        assert.equal(s.sayilar.bulgu, 1, "kesintiden sonra rapor 'bulgu yok' diyemez");
      } finally {
        await d.kapat();
        rmSync(join(dizin, artik), { force: true });
      }
    } finally {
      rmSync(hedef, { recursive: true, force: true });
    }
    assert.deepEqual(belgeKumesi(klasor), baslangicBelgeler);
  });

  // ── KESİNTİ 5 (devamı) — KULLANICI DÜZELTTİKTEN SONRA ─────────────────────
  // İncelemede ÖLÇÜLEN hasar buydu: gerçek SIGKILL'den sonra kullanıcı "Devam
  // et"e basıyor, iş tamamlanıyor, hedef belge artığın TAM YANINDA aynı
  // baytlarla duruyor — ama denetim hâlâ "1 bulgu" diyor ve zaten yapılmış
  // eşitlemeyi tekrar öneriyordu. Burada aynı disk durumu GERÇEK MOTORUN
  // indirdiği belgeyle kurulur.
  test("5b) hedef belge sağlam yanında duruyorsa denetim ARTIK 'bulgu' DEMEZ", async () => {
    const m = manifestOku();
    const hedefKayit = m.evraklar[0]!;
    const hedefTam = join(klasor, hedefKayit.path);
    const hedefAd = hedefKayit.path.split("/").pop()!;
    const oncekiBayt = readFileSync(hedefTam);
    const artik = join(hedefTam, "..", `.${hedefAd}.4141.${randomUUID()}.tmp`);
    writeFileSync(artik, "yarım inmiş baytlar");
    const d = motor();
    await d.rpc.baslat();
    try {
      const s = await arsiviDenetle({ kok: kok.kok, davalar: d.registry.hepsi() });
      assert.equal(turleri(s.bulgular, "yarim-yazim").length, 0, "kapanmış kesinti arıza değil");
      const kapali = turleri(s.bulgular, "yarim-yazim-artigi");
      assert.equal(kapali.length, 1, "kesinti yine de görünür kalmalı");
      assert.equal(kapali[0]!.agirlik, "bilgi");
      assert.equal(s.sayilar.yarim, 1);
      assert.equal(s.sayilar.bulgu, 0, "sağlam arşiv kalıcı olarak bozuk okunmamalı");
      // Denetim HİÇBİR ŞEYE DOKUNMAZ: artık da hedef de olduğu gibi duruyor.
      assert.equal(statSync(artik).size > 0, true, "artık silinmedi");
      assert.deepEqual(readFileSync(hedefTam), oncekiBayt, "hedef belgeye dokunulmadı");
    } finally {
      await d.kapat();
      rmSync(artik, { force: true });
    }
    assert.deepEqual(belgeKumesi(klasor), baslangicBelgeler);
  });

  // ── KESİNTİ 7 — rapor eskidi + kesinti birlikte ───────────────────────────
  test("7) rapor alındıktan sonra kaynak kaybolursa onarım TEK BAYT yazmaz", async () => {
    const d = motor();
    await d.rpc.baslat();
    try {
      const m = manifestOku();
      const hedef = m.evraklar[0]!;
      // Rapor: türev silindi, "Hazır metin yok" satırı çıkar.
      rmSync(join(klasor, hedef.mdPath!), { force: true });
      const rapor = await arsiviDenetle({ kok: kok.kok, davalar: d.registry.hepsi() });
      const satir = turleri(rapor.bulgular, "turev-yok")[0]!;
      assert.equal(satir.onarim.eylem, "metin");

      // ARADA KESİNTİ: kaynak da gitti (yarım kalmış bir yazımın hedefi gibi).
      const kaynakYedegi = readFileSync(join(klasor, hedef.path));
      rmSync(join(klasor, hedef.path), { force: true });
      const once = parmakIzi(klasor);
      const sonuc = metniYenidenUret(kok.kok, klasor, satir.yol, true);
      assert.equal(sonuc.durum, "kaynak-saglam-degil");
      assert.equal(sonuc.uygulandi, false);
      assert.deepEqual(fark(once, parmakIzi(klasor)), [], "bayat rapordan onarım tek bayt yazmamalı");

      // Kaynağı geri koy: aynı satır artık gerçekten onarılabilir.
      writeFileSync(join(klasor, hedef.path), kaynakYedegi);
      const ikinci = metniYenidenUret(kok.kok, klasor, satir.yol, true);
      assert.equal(ikinci.durum, "onarildi");
      assert.deepEqual(belgeKumesi(klasor), baslangicBelgeler);
    } finally {
      await d.kapat();
    }
  });
});
