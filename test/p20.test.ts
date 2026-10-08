// P20 — BELİRSİZ GRUPTA ÜYE DEĞİŞİMİ BELGEYİ SESSİZCE KAYBETTİRİYORDU.
//
// Ürünün yapabileceği en kötü hata: portalda duran bir belge arşivde yok ve
// hiçbir yüzey bunu söylemiyor. Kusur 13 Eylül'de izole motorda ölçüldü:
//   arşivde [ALFA, BETA], portal [ALFA, GAMA] veriyor
//   → eşitleme "0 yeni, 0 eksik", denetim "0 bulgu", GAMA HİÇ İNMİYOR.
// Grup BÜYÜMEDİĞİ için eski tazeleme koşulu (yalnız N > M) tetiklenmiyordu.
// P19 ÖNCESİ kod bu belgeyi — şişerek de olsa — İNDİRİYORDU; yani gerilemeydi.
//
// ── BU DOSYA NEYİ ÖLÇER ─────────────────────────────────────────────────────
// ÜÇÜNÜ BİRDEN: kayıt sayısı, DOSYA sayısı ve METİNLER. Biri atlanırsa kusur
// görünmez — düzeltmenin ilk denemesi tam da bu yüzden "geçmiş" gibi
// duruyordu: doğruluk düzelmişti ama disk eşitleme başına +4 dosya şişiyordu.
//
// ── HER TEST KENDİ ARŞİVİNİ KURAR ───────────────────────────────────────────
// Paylaşılan tek klon üzerinde çalışılsaydı bir testin bıraktığı FAZLA
// kayıtlar sonrakinin ölçümüne karışırdı (bu dosyanın ilk hâlinde yaşandı:
// görsel evrak testi kendi senaryosunun değil, önceki testlerin biriktirdiği
// kayıtların şişmesini ölçüyordu — ve o karışıklık gerçek bir kusuru ortaya
// çıkardı, bkz. `tazeleme.ts`de METİNSİZ İÇERİK istisnası). Kurulum maliyeti
// bilerek ödeniyor.
//
// Bütün veriler SENTETİKTİR; gerçek arşive tek bayt dokunulmaz.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { MockUyap, opakToken, type MockDava, type MockEvrak } from "./mock-uyap/sunucu.js";
import { daemonKur } from "../src/server/daemon.js";
import { makeHtml, tmpKok } from "./yardimci.js";
import { BelirsizHavuz, type AdayKayit } from "../src/store/tazeleme.js";
import { baytlardanMetin } from "../src/convert/run.js";
import { htmlToMd } from "../src/convert/htmlmd.js";
import { caseKeyYap } from "../src/store/registry.js";
import type { ManifestEvrak } from "../src/store/manifest.js";

const CEREZ = "JSESSIONID=p20mock1234567890";
const BIRIM = "Sentetik P20 Asliye Ceza Mahkemesi";
const BIRIM_ID = "9020";
const ESAS = "2026/520";
/** Belirsiz grup: birden çok satır aynı numara/tür/tarih taşır. */
const BELIRSIZ_NO = "7742";
/** Tekil grup: portalda da manifestte de tek satır. */
const TEKIL_NO = "1002";
const TARIH = "04/09/2026";

interface Tanim {
  ad: string;
  /** null → GÖRSEL evrak: metin katmanı yok, aynılık metinle ölçülemez. */
  metin: string | null;
  no?: string;
  /** UYAP'ın "her indirişte yeniden üret" davranışı (baytlar değişir). */
  damga?: boolean;
}

function evrak(t: Tanim): MockEvrak {
  const gorsel = t.metin === null;
  return {
    evrakId: opakToken(`p20-${t.ad}`),
    tur: "Müzekkere",
    gonderen: "Sentetik Kalem",
    tip: "GDN",
    tarih: TARIH,
    birimEvrakNo: t.no ?? BELIRSIZ_NO,
    durum: "yuklu",
    contentTipi: gorsel ? "image/png" : "text/html; charset=UTF-8",
    icerik: gorsel
      ? Buffer.from(`PNG\r\n\n sentetik ${t.ad}`, "binary")
      : makeHtml(`<div>${t.metin}</div>`, "Sentetik Belge"),
    uretimDamgasi: t.damga ?? !gorsel,
  };
}

/** Bir dava klasöründeki TÜM dosyaların sayısı (ham + .md + manifest). */
function dosyaSayisi(kok: string): number {
  let n = 0;
  const gez = (d: string): void => {
    for (const g of readdirSync(d, { withFileTypes: true })) {
      const t = join(d, g.name);
      if (g.isDirectory()) gez(t);
      else if (g.isFile()) n++;
    }
  };
  gez(kok);
  return n;
}

interface Sonuc {
  yeniEvrak: number;
  korunanEvrak: number;
  yenilenenEvrak: number;
  eksikEvrak: number;
}

interface Sahne {
  /** Portalı bu satırlara çevirir (dizi sırası portalın bildirdiği sıradır). */
  portal(satirlar: Tanim[]): void;
  esitle(beklenen?: string): Promise<Sonuc>;
  kayitSayisi(): number;
  dosyaSayisi(): number;
  /** Bir gruptaki kayıtların METİNLERİ, sıralı. Metinsiz kayıt işaretlenir. */
  metinler(no?: string): string[];
  metinVar(kelime: string, no?: string): boolean;
  /**
   * Bir gruptaki kayıtların HAM dosyalarındaki ayırt edici etiket, sıralı.
   * `metinler` GÖRSEL evrakta hiçbir şey söylemez (`.md` yoktur) — kaybı
   * yalnız bu ölçüm görür: kayıt ve dosya SAYISI sabit kalırken içerik yok
   * olabiliyor (ölçüldü; bu dosyanın KABUL 5d testinin varlık sebebi).
   */
  hamEtiketler(no?: string): string[];
  /** Ham dosyası `kelime` içeren kaydın diskteki TAM yolu. */
  hamYol(kelime: string, no?: string): string;
  denetle(): Promise<{ bulgu: number; portalIstegi: number }>;
  portalIstekleri(): number;
  /** Sahte portala DOĞRUDAN sorgu için (mock'un kendi bekçisi). */
  adres(): string;
  dosyaId(): string;
  kapat(): Promise<void>;
}

/** İzole motor + sahte portal + klonlanmış sentetik arşiv. */
async function sahneKur(ilk: Tanim[]): Promise<Sahne> {
  const dava: MockDava = {
    dosyaId: opakToken("p20-dosya"),
    birimAdi: BIRIM,
    birimId: BIRIM_ID,
    esasNo: ESAS,
    dosyaTur: "Ceza Dava Dosyası",
    dosyaDurum: "Açık",
    yargiTuru: "1",
    // Portalın hiçbir kimliği kalıcı değil: kusur ancak böyle üretilebilir.
    kimlikDoner: true,
    evraklar: ilk.map(evrak),
    taraflar: [{ adi: "SENTETİK DAVACI", rol: "Davacı" }],
  };
  const mock = new MockUyap({
    birimler: [{ birimId: BIRIM_ID, birimAdi: BIRIM, yargiTuru: "1" }],
    davalar: [dava],
  });
  await mock.baslat();
  const ayar = tmpKok();
  const kok = tmpKok();
  const daemon = daemonKur({
    ayarDir: ayar.kok,
    kok: kok.kok,
    portalUrl: mock.adres(),
    appVersion: "test",
    istekAralikMs: 1,
    gunlukTavan: 800,
  });
  await daemon.rpc.baslat();
  const h = (ad: string) => daemon.isleyiciler.get(ad)!;
  await h("giris")({ cerez: CEREZ });

  const isBekle = async (isId: string): Promise<{ durum: string; sonuc?: Sonuc }> => {
    for (let i = 0; i < 600; i++) {
      const is = (await h("is")({ isId })) as { durum: string; sonuc?: Sonuc };
      if (["hazir", "eksikli", "hata", "iptal", "duraklatildi"].includes(is.durum)) return is;
      await new Promise((c) => setTimeout(c, 10));
    }
    throw new Error("iş zaman aşımı");
  };

  const baslat = (await h("klonla")({ birim: BIRIM, esas: ESAS, kapsam: "hepsi" })) as { isId: string };
  const klonIs = await isBekle(baslat.isId);
  assert.equal(klonIs.durum, "hazir", `klon düştü: ${JSON.stringify(klonIs)}`);
  const davalar = (await h("davalar")({})) as { davalar: { klonYolu?: string }[] };
  const klonYolu = davalar.davalar[0]?.klonYolu ?? "";
  assert.notEqual(klonYolu, "", "klon yolu bulunamadı");

  interface ManifestSekli {
    evraklar: { path: string; birimEvrakNo?: string; mdStatus?: string; mdPath?: string }[];
  }
  const manifest = (): ManifestSekli =>
    JSON.parse(readFileSync(join(klonYolu, "uyap-project.json"), "utf8")) as ManifestSekli;

  /**
   * Ham dosyanın içindeki etiket: sentetik gövdelerin hepsi "sentetik <ad>"
   * ya da "Sentetik <AD> belge metni." taşır. Büyük harfe çevrilir ki görsel
   * (`sentetik tarama`) ve metinli (`Sentetik ALFA`) aynı ölçekte okunsun.
   */
  const hamEtiket = (yol: string): string => {
    const ham = readFileSync(yol).toString("latin1");
    return (/sentetik\s+([A-Za-z0-9]+)/i.exec(ham)?.[1] ?? "?").toUpperCase();
  };

  const metinler = (no = BELIRSIZ_NO): string[] =>
    manifest()
      .evraklar.filter((e) => e.birimEvrakNo === no)
      .map((e) =>
        e.mdStatus === "ok" && e.mdPath !== undefined
          ? readFileSync(join(klonYolu, e.mdPath), "utf8").replace(/\s+/g, " ").trim()
          : `(metinsiz:${e.mdStatus})`,
      )
      .sort();

  return {
    portal(satirlar) {
      dava.evraklar = satirlar.map(evrak);
    },
    async esitle(beklenen = "hazir") {
      const b = (await h("esitle")({ caseKey: caseKeyYap(BIRIM, ESAS) })) as { isId: string };
      const is = await isBekle(b.isId);
      assert.equal(is.durum, beklenen, `eşitleme beklenmedik durumda bitti: ${JSON.stringify(is)}`);
      return is.sonuc!;
    },
    kayitSayisi: () => manifest().evraklar.length,
    dosyaSayisi: () => dosyaSayisi(klonYolu),
    metinler,
    metinVar: (kelime, no = BELIRSIZ_NO) => metinler(no).some((m) => m.includes(kelime)),
    hamEtiketler: (no = BELIRSIZ_NO) =>
      manifest()
        .evraklar.filter((e) => e.birimEvrakNo === no)
        .map((e) => hamEtiket(join(klonYolu, e.path)))
        .sort(),
    hamYol(kelime, no = BELIRSIZ_NO) {
      const bulunan = manifest()
        .evraklar.filter((e) => e.birimEvrakNo === no)
        .map((e) => join(klonYolu, e.path))
        .filter((y) => readFileSync(y).toString("latin1").includes(kelime));
      assert.equal(bulunan.length, 1, `ham dosya bulunamadı ya da tekil değil: ${kelime}`);
      return bulunan[0]!;
    },
    async denetle() {
      const once = mock.istekler.length;
      const dn = (await h("arsiv-denetle")({})) as { sayilar: { bulgu: number } };
      return { bulgu: dn.sayilar.bulgu, portalIstegi: mock.istekler.length - once };
    },
    portalIstekleri: () => mock.istekler.length,
    adres: () => mock.adres(),
    dosyaId: () => dava.dosyaId,
    async kapat() {
      await daemon.kapat();
      await mock.durdur();
      ayar.temizle();
      kok.temizle();
    },
  };
}

const ALFA: Tanim = { ad: "alfa", metin: "Sentetik ALFA belge metni." };
const BETA: Tanim = { ad: "beta", metin: "Sentetik BETA belge metni." };
const GAMA: Tanim = { ad: "gama", metin: "Sentetik GAMA belge metni." };
const DELTA: Tanim = { ad: "delta", metin: "Sentetik DELTA belge metni." };

describe("P20 belirsiz grupta üye değişimi", () => {
  test("sahte portal kusuru ÜRETEBİLİYOR: DÖNEN kimlik, DEĞİŞEN bayt, AYNI metin", async () => {
    // BEKÇİNİN BEKÇİSİ. Kimliği sabit, baytı sabit bir portalda P20 kusuru
    // ÜRETİLEMEZ; mock bu davranışı yitirirse aşağıdaki testler "geçer" ama
    // hiçbir şey ölçmez. Sorgu doğrudan sahte portala gider.
    const s = await sahneKur([ALFA, BETA]);
    try {
      const listele = async (): Promise<{ evrakId: string; birimEvrakNo: string }[]> => {
        const r = await fetch(`${s.adres()}/list_dosya_evraklar.ajx`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie: CEREZ },
          body: JSON.stringify({ dosyaId: s.dosyaId(), pageNumber: 1 }),
        });
        const g = (await r.json()) as { tumEvraklar: { ana: { evrakId: string; birimEvrakNo: string }[] } };
        return g.tumEvraklar.ana;
      };
      const indir = async (evrakId: string): Promise<Buffer> => {
        const r = await fetch(
          `${s.adres()}/view_document_brd.uyap?evrakId=${encodeURIComponent(evrakId)}` +
            `&dosyaId=${encodeURIComponent(s.dosyaId())}`,
          { headers: { cookie: CEREZ } },
        );
        return Buffer.from(await r.arrayBuffer());
      };
      const ilk = await listele();
      const ikinci = await listele();
      assert.equal(ilk.length, 2);
      assert.equal(
        ilk.filter((e, i) => e.evrakId === ikinci[i]!.evrakId).length,
        0,
        "portal kimliği dönmüyor: P20 kusuru bu mock'ta ÜRETİLEMEZ",
      );
      assert.equal(ikinci.filter((e) => e.birimEvrakNo === BELIRSIZ_NO).length, 2, "grup belirsiz değil");
      const a = await indir(ikinci[0]!.evrakId);
      const b = await indir(ikinci[0]!.evrakId);
      assert.notEqual(
        createHash("sha256").update(a).digest("hex"),
        createHash("sha256").update(b).digest("hex"),
        "baytlar her indirişte değişmiyor: yeniden üretim taklit edilmiyor",
      );
      assert.equal(
        htmlToMd(a.toString("utf8")).md,
        htmlToMd(b.toString("utf8")).md,
        "çıkarılan metin de değişti: 'aynı belge' ölçütü bu mock'ta ölçülemez",
      );
      // Klon iki AYRI kayıt üretmiş olmalı: birleşme yok.
      assert.equal(new Set(s.metinler()).size, 2, "iki farklı belge tek metne indi");
    } finally {
      await s.kapat();
    }
  });

  test("KABUL 1 — ÜYE DEĞİŞİMİ: portal [ALFA, GAMA] verince GAMA arşive İNER", async () => {
    // P20 öncesi burada eşitleme "0 yeni, 0 eksik" diyordu, denetim "0 bulgu"
    // diyordu ve GAMA HİÇ İNMİYORDU. Grup doygun (2 = 2) sayıldığı için bir
    // daha da inmiyordu. ÖLÇÜT METİNDİR: sayı zaten doğruydu.
    const s = await sahneKur([ALFA, BETA]);
    try {
      assert.ok(s.metinVar("ALFA") && s.metinVar("BETA"), "kurulum bozuk");
      const oncekiDosya = s.dosyaSayisi();
      const oncekiKayit = s.kayitSayisi();

      s.portal([ALFA, GAMA]);
      const r = await s.esitle();

      assert.ok(s.metinVar("GAMA"), "portaldaki belge arşive İNMEDİ: sessiz kayıp sürüyor");
      assert.ok(s.metinVar("ALFA"), "değişmeyen belge kayboldu");
      assert.equal(s.metinler().length, 2, "grup portalın bildirdiği satır sayısında kalmalı");
      assert.equal(new Set(s.metinler()).size, 2, "iki satır tek belgeye indirgendi");
      // Metni tanınan satır KORUNUR; yalnız tanınmayan satır yazılır.
      assert.equal(r.yenilenenEvrak, 1, "değişen tek belge yerine fazlası yazıldı");
      assert.equal(r.yeniEvrak, 0, "yeni kayıt eklenmemeliydi: grup büyümedi");
      // Yazım EŞLEŞEN KAYDIN YOLUNA gitti: yeni dosya AÇILMADI.
      assert.equal(s.dosyaSayisi(), oncekiDosya, "üye değişimi diske yeni dosya ekledi");
      assert.equal(s.kayitSayisi(), oncekiKayit, "manifest şişti");

      // Değişim OTURDU: ardından gelen eşitleme hiçbir şey yazmamalı.
      const r2 = await s.esitle();
      assert.equal(r2.yeniEvrak, 0);
      assert.equal(r2.yenilenenEvrak, 0, "oturmuş değişim her turda yeniden yazılıyor");
      assert.ok(s.metinVar("GAMA") && s.metinVar("ALFA"));
    } finally {
      await s.kapat();
    }
  });

  test("KABUL 1b — ÜYE DEĞİŞİMİ satır BAŞTAYKEN de belge iner", async () => {
    // Sıra tahmininin en kötü hâli: değişen satır listenin başında, yani her
    // satır bir öncekinin kaydına kayıyor.
    const s = await sahneKur([ALFA, BETA]);
    try {
      const dosya = s.dosyaSayisi();
      s.portal([GAMA, ALFA]);
      await s.esitle();
      assert.ok(s.metinVar("GAMA"), "başa gelen değişik belge inmedi");
      assert.ok(s.metinVar("ALFA"), "yerinde duran belge kayboldu");
      assert.equal(s.metinler().length, 2);
      assert.equal(s.dosyaSayisi(), dosya, "disk şişti");
      const r2 = await s.esitle();
      assert.equal(r2.yenilenenEvrak, 0, "değişim oturmadı: her tur yeniden yazılıyor");
    } finally {
      await s.kapat();
    }
  });

  test("KABUL 2 — hiçbir şey değişmeyince ÜÇ eşitlemede kayıt, DOSYA ve METİN sabit", async () => {
    // Doğruluğun bedeli budur ve ölçülmeden kabul edilmez: belirsiz grup her
    // turda yeniden İNER ama arşiv tek bayt DEĞİŞMEZ. Önceki (terk edilen)
    // denemede bu ölçüm "kayit 5 / dosya 9 → 13 → 17, her turda 4 yenilenen"
    // veriyordu.
    const s = await sahneKur([ALFA, BETA, { ad: "tekil", metin: "Sentetik TEKIL metni.", no: TEKIL_NO }]);
    try {
      const taban = { kayit: s.kayitSayisi(), dosya: s.dosyaSayisi(), metin: s.metinler().join("|") };
      const olcum: { kayit: number; dosya: number; yeni: number; yenilenen: number; metin: string }[] = [];
      for (let tur = 0; tur < 3; tur++) {
        const r = await s.esitle();
        olcum.push({
          kayit: s.kayitSayisi(),
          dosya: s.dosyaSayisi(),
          yeni: r.yeniEvrak,
          yenilenen: r.yenilenenEvrak,
          metin: s.metinler().join("|"),
        });
      }
      assert.deepEqual(
        olcum.map((o) => o.kayit),
        [taban.kayit, taban.kayit, taban.kayit],
        `manifest şişti: ${JSON.stringify(olcum)}`,
      );
      assert.deepEqual(
        olcum.map((o) => o.dosya),
        [taban.dosya, taban.dosya, taban.dosya],
        `DİSK şişti: ${JSON.stringify(olcum)}`,
      );
      assert.deepEqual(
        olcum.map((o) => o.yeni),
        [0, 0, 0],
        `"yeni" sayacı yalan söylüyor: ${JSON.stringify(olcum)}`,
      );
      assert.deepEqual(
        olcum.map((o) => o.yenilenen),
        [0, 0, 0],
        `metni tanınan belge boşuna yeniden yazıldı: ${JSON.stringify(olcum)}`,
      );
      assert.deepEqual(
        olcum.map((o) => o.metin),
        [taban.metin, taban.metin, taban.metin],
        "belgeler grup içinde yer değiştirdi",
      );
    } finally {
      await s.kapat();
    }
  });

  test("KABUL 3 — grup BÜYÜRSE (satır BAŞTA) yeni belge iner, eskiler YENİDEN YAZILMAZ", async () => {
    // P19'un düzelttiği kusurun bekçisi ayakta kalmalı; P20 üstüne şunu ekler:
    // eski iki belge metniyle tanındığı için dosyaları KORUNUR. Sayma kuralı
    // olmasaydı yeni satır kardeşinin kaydını ezer, zincirleme üç yazma olur
    // ve sayaç "2 yenilenen" derdi (ölçüldü).
    const s = await sahneKur([ALFA, BETA]);
    try {
      s.portal([DELTA, ALFA, BETA]);
      const r = await s.esitle();
      for (const kelime of ["ALFA", "BETA", "DELTA"]) {
        assert.ok(s.metinVar(kelime), `${kelime} arşivde yok: belge KAYBOLDU`);
      }
      assert.equal(new Set(s.metinler()).size, 3, "bir belgenin kopyası ikinci kez kaydedilmiş");
      assert.equal(r.yeniEvrak, 1, "tam olarak bir kayıt eklenmeliydi");
      assert.equal(r.yenilenenEvrak, 0, "metni tanınan belge boşuna yeniden yazıldı");
      assert.equal(r.korunanEvrak, 2, "metni tanınan belge korunan sayılmadı");
    } finally {
      await s.kapat();
    }
  });

  test("KABUL 4 — metni BİREBİR AYNI iki gerçek satır tek kayda İNDİRGENMEZ", async () => {
    // UYAP aynı şablonu iki ayrı satır olarak bildirebiliyor (gerçek arşivde
    // ölçüldü). Metin ölçütü "aynı metin = aynı kayıt" diye okunursa iki satır
    // tek kayda düşer ve arşiv bir belge EKSİLİR.
    const sablon = (n: string): Tanim => ({ ad: `sablon-${n}`, metin: "Sentetik ayni sablon metni." });
    const s = await sahneKur([sablon("1"), sablon("2")]);
    try {
      assert.equal(s.metinler().length, 2, "klon aşamasında birleşti");
      const dosya = s.dosyaSayisi();
      for (let tur = 0; tur < 3; tur++) {
        const r = await s.esitle();
        assert.equal(s.metinler().length, 2, `tur ${tur}: aynı metinli iki satır tek kayda indirgendi`);
        assert.equal(r.yeniEvrak, 0, `tur ${tur}: kayıt eklendi`);
        assert.equal(r.yenilenenEvrak, 0, `tur ${tur}: aynı metinli iki satır birbirini kovaladı`);
        assert.equal(s.dosyaSayisi(), dosya, `tur ${tur}: disk şişti`);
      }
    } finally {
      await s.kapat();
    }
  });

  test("KABUL 4b — üç gerçek belgeden ORTADAKİ değişirse yalnız o yazılır", async () => {
    const CETA: Tanim = { ad: "ceta", metin: "Sentetik CETA belge metni." };
    const s = await sahneKur([ALFA, BETA, CETA]);
    try {
      const dosya = s.dosyaSayisi();
      s.portal([ALFA, DELTA, CETA]);
      const r = await s.esitle();
      assert.equal(r.yenilenenEvrak, 1, "değişmeyen kardeşler de yazıldı");
      assert.equal(r.korunanEvrak, 2);
      assert.equal(s.dosyaSayisi(), dosya, "disk şişti");
      assert.deepEqual(
        s.metinler().map((m) => m.replace(/^Sentetik (\w+).*$/, "$1")),
        ["ALFA", "CETA", "DELTA"],
        "küme yanlış: belge kayboldu ya da karıştı",
      );
    } finally {
      await s.kapat();
    }
  });

  test("KABUL 5 — METNİ OLMAYAN (görsel) evrak: kayıt ve DOSYA sabit, bedel yalnız sayaçta", async () => {
    // Görsel evrakta aynılık METİNLE ölçülemez. Bayt eşitliği ikinci ölçüttür
    // ama UYAP belgeyi yeniden üretiyorsa o da tutmaz. KARAR: kaybolma riski
    // ALINMAZ — baytlar eşleşen kaydın YOLUNA yazılır (disk şişmez) ve satır
    // "yenilenen" sayılır. Bedeli yalnız gereksiz bir "yenilendi" satırıdır.
    const tarama: Tanim = { ad: "tarama", metin: null, damga: true };
    const s = await sahneKur([ALFA, tarama]);
    try {
      const taban = { kayit: s.kayitSayisi(), dosya: s.dosyaSayisi() };
      assert.ok(
        s.metinler().some((m) => m.startsWith("(metinsiz:")),
        "görsel evrak metinsiz kayıt olarak durmalı",
      );
      const olcum: { kayit: number; dosya: number; yenilenen: number }[] = [];
      for (let tur = 0; tur < 3; tur++) {
        const r = await s.esitle();
        olcum.push({ kayit: s.kayitSayisi(), dosya: s.dosyaSayisi(), yenilenen: r.yenilenenEvrak });
      }
      assert.deepEqual(
        olcum.map((o) => o.kayit),
        [taban.kayit, taban.kayit, taban.kayit],
        `görsel evrak manifesti şişirdi: ${JSON.stringify(olcum)}`,
      );
      assert.deepEqual(
        olcum.map((o) => o.dosya),
        [taban.dosya, taban.dosya, taban.dosya],
        `görsel evrak DİSKİ şişirdi: ${JSON.stringify(olcum)}`,
      );
      assert.deepEqual(
        olcum.map((o) => o.yenilenen),
        [1, 1, 1],
        `beklenen bedel TAM BİR "yenilendi" satırıdır; ölçüm: ${JSON.stringify(olcum)}`,
      );
      // Metinli kardeş ETKİLENMEZ: görsel satır onun kaydını kurban ETMEMELİ.
      assert.ok(s.metinVar("ALFA"), "görsel satır metinli kardeşinin belgesini ezdi");
    } finally {
      await s.kapat();
    }
  });

  test("KABUL 5b — BAYTI SABİT görsel evrak hiç yazılmaz: bayt eşitliği tanır", async () => {
    const tarama: Tanim = { ad: "tarama", metin: null, damga: false };
    const s = await sahneKur([ALFA, tarama]);
    try {
      const dosya = s.dosyaSayisi();
      for (let tur = 0; tur < 2; tur++) {
        const r = await s.esitle();
        assert.equal(r.yenilenenEvrak, 0, "baytı değişmeyen görsel evrak boşuna yeniden yazıldı");
        assert.equal(s.dosyaSayisi(), dosya);
      }
    } finally {
      await s.kapat();
    }
  });

  test("KABUL 5c — FAZLA kayıtlı grupta görsel evrak: arşiv HER TURDA bir kayıt daha almaz", async () => {
    // Bu kusur bu dosyanın kendi kurulum karışıklığında bulundu (bkz. başlık).
    // Portal bir satır düşürünce grupta FAZLA kayıt kalır (P19 KABUL 4: kayıt
    // silinmez). Sayma kuralı orada "yeni yol aç" der; metni ölçülemeyen bir
    // satır için bu SINIRSIZ şişmedir — yeni kayıt bir daha asla tanınamaz.
    // Ölçüm (istisna yokken): 8 → 9 kayıt, 15 → 16 dosya, her eşitlemede +1.
    const tarama: Tanim = { ad: "tarama", metin: null, damga: true };
    const s = await sahneKur([ALFA, BETA, tarama]);
    try {
      s.portal([ALFA, tarama]); // BETA düştü: grupta bir FAZLA kayıt kalıyor
      await s.esitle();
      const taban = { kayit: s.kayitSayisi(), dosya: s.dosyaSayisi() };
      assert.ok(s.metinVar("BETA"), "portalın düşürdüğü kayıt silinmiş (P19 KABUL 4 bozuldu)");
      const olcum: { kayit: number; dosya: number }[] = [];
      for (let tur = 0; tur < 3; tur++) {
        await s.esitle();
        olcum.push({ kayit: s.kayitSayisi(), dosya: s.dosyaSayisi() });
      }
      assert.deepEqual(
        olcum.map((o) => o.kayit),
        [taban.kayit, taban.kayit, taban.kayit],
        `fazla kayıtlı grupta manifest her turda şişiyor: ${JSON.stringify(olcum)}`,
      );
      assert.deepEqual(
        olcum.map((o) => o.dosya),
        [taban.dosya, taban.dosya, taban.dosya],
        `fazla kayıtlı grupta DİSK her turda şişiyor: ${JSON.stringify(olcum)}`,
      );
      // Portalın düşürdüğü BETA hâlâ duruyor ve METİNLİ kardeş ezilmemiş.
      assert.ok(s.metinVar("BETA"), "görsel satır, portalın düşürdüğü belgeyi ezdi");
      assert.ok(s.metinVar("ALFA"), "görsel satır metinli kardeşinin belgesini ezdi");
    } finally {
      await s.kapat();
    }
  });

  test("KABUL 5d — FAZLALIĞIN KENDİSİ DE METİNSİZKEN hiçbir belge YOK EDİLMEZ", async () => {
    // GERİLEMENİN BEKÇİSİ (inceleme, 13 Eylül). KABUL 5c'de fazla kayıt
    // METİNLİYDİ; metinsiz satır "önce metinsiz kaydı seç" dediği için kendi
    // kaydını eziyor ve metinli kardeş kurtuluyordu. Fazlalığın kendisi de
    // metinsiz olunca istisna, portalın artık bildirmediği belgeleri BİRER
    // BİRER yok ediyordu: [T1,T2,T3] → [T2,T3,T3] → [T3,T3,T3].
    //
    // ÖLÇÜT SAYI DEĞİL KÜMEDİR: kayıt sayısı 3'te, dosya sayısı sabit kalırken
    // üç ayrı belge aynı belgenin üç kopyasına dönüşüyordu ve denetim
    // "0 bulgu" diyordu. `metinler()` de göremez (görsel evrakta `.md` yok).
    const T1: Tanim = { ad: "tara1", metin: null, damga: true };
    const T2: Tanim = { ad: "tara2", metin: null, damga: true };
    const T3: Tanim = { ad: "tara3", metin: null, damga: true };
    const s = await sahneKur([T1, T2, T3]);
    try {
      const ilkKume = s.hamEtiketler();
      assert.deepEqual(ilkKume, ["TARA1", "TARA2", "TARA3"], "kurulum bozuk");
      const ilkKayit = s.kayitSayisi();
      s.portal([T3]); // portal İKİ satırı düşürdü: M=3 > N=1, üçü de metinsiz
      const olcum: { kayit: number; dosya: number; kume: string[] }[] = [];
      for (let tur = 0; tur < 4; tur++) {
        await s.esitle();
        olcum.push({ kayit: s.kayitSayisi(), dosya: s.dosyaSayisi(), kume: s.hamEtiketler() });
      }
      for (const [i, o] of olcum.entries()) {
        for (const etiket of ilkKume) {
          assert.ok(
            o.kume.includes(etiket),
            `tur ${i}: portalın düşürdüğü ${etiket} belgesi YOK EDİLDİ — küme ${JSON.stringify(o.kume)}`,
          );
        }
      }
      // Şişme BİRDE durur: tanınamayan içerik için açılan yol kayıtta
      // işaretlenir ve bir sonraki turda yeniden kullanılır.
      assert.ok(
        olcum[0]!.kayit <= ilkKayit + 1,
        `ilk eşitleme bir kayıttan fazlasını ekledi: ${ilkKayit} → ${olcum[0]!.kayit}`,
      );
      assert.deepEqual(
        olcum.map((o) => o.kayit),
        olcum.map(() => olcum[0]!.kayit),
        `arşiv HER TURDA şişiyor: ${JSON.stringify(olcum.map((o) => o.kayit))}`,
      );
      assert.deepEqual(
        olcum.map((o) => o.dosya),
        olcum.map(() => olcum[0]!.dosya),
        `disk HER TURDA şişiyor: ${JSON.stringify(olcum.map((o) => o.dosya))}`,
      );
    } finally {
      await s.kapat();
    }
  });

  test("KABUL 6 — YERELDE DEĞİŞMİŞ kaynak üye değişiminde de ezilmez", async () => {
    // README "Veri düzeni": "Yerelde değişmiş kaynak üzerine yazılmaz, yeni
    // indirme ayrı dosyaya kaydedilir." Belirsiz grupta bu söz tutulmuyordu:
    // yerinde yazım, hedefin hâlâ kaydın sha256'sını tutup tutmadığını hiç
    // sormuyordu. Ölçüldü: avukatın kendi eklediği not sessizce siliniyor,
    // sayaç "1 yenilenen" diyor, denetim "0 bulgu" diyordu.
    const s = await sahneKur([ALFA, BETA]);
    try {
      const yol = s.hamYol("BETA");
      const NOT = "<!-- AVUKATIN YEREL NOTU -->";
      writeFileSync(yol, `${readFileSync(yol, "utf8")}\n${NOT}\n`);
      assert.ok(readFileSync(yol, "utf8").includes(NOT), "kurulum bozuk");

      s.portal([ALFA, GAMA]); // üye değişimi: BETA düştü, GAMA geldi
      const r = await s.esitle();

      assert.ok(
        readFileSync(yol, "utf8").includes(NOT),
        "yerelde değişmiş kaynak EZİLDİ: kullanıcının kendi yazdığı veri yok oldu",
      );
      assert.ok(readFileSync(yol, "utf8").includes("BETA"), "yerel dosyanın gövdesi de değişti");
      assert.ok(s.metinVar("GAMA"), "yeni belge inmedi: koruma kaybı kayıpla değiştirmiş");
      assert.ok(s.metinVar("ALFA"), "değişmeyen kardeş kayboldu");
      // Yeni belge AYRI yola indi: kayıt bir artar, hiçbir şey yok olmaz.
      assert.equal(r.yeniEvrak, 1, "yeni belge ayrı yola inmedi");
      assert.equal(r.yenilenenEvrak, 0, "korunması gereken kayıt yine de yazıldı");
      assert.equal(s.kayitSayisi(), 3, "kayıt sayısı beklenmedik");

      // Değişim OTURUR: sonraki turda hiçbir şey yazılmaz, not hâlâ yerinde.
      const r2 = await s.esitle();
      assert.equal(r2.yeniEvrak, 0, "her eşitleme bir kayıt daha ekliyor");
      assert.equal(s.kayitSayisi(), 3, "arşiv şişiyor");
      assert.ok(readFileSync(yol, "utf8").includes(NOT), "not ikinci turda silindi");
    } finally {
      await s.kapat();
    }
  });

  test("SINIR — TEKİL grupta belge değişimi ÖLÇÜLMEZ ve bu bilerek böyle", async () => {
    // P20 belirsiz grubu kapsar. Portalda 1, manifestte 1 satır varsa
    // (birimEvrakNo, tür, tarih) üçlüsü portalın verebildiği en yakın
    // kimliktir (gerçek dosyada 112/113 tekil) ve orayı da tazelemek arşivin
    // TAMAMINI her eşitlemede yeniden indirmek demektir. Sınır README'de ve
    // ROADMAP §15c'de yazılıdır; bu test onun BEKÇİSİDİR — sessizce kalkarsa
    // maliyet ölçülmeden ödenmeye başlar, sessizce daralırsa kayıp geri gelir.
    const s = await sahneKur([{ ad: "tekil", metin: "Sentetik TEKIL belge metni.", no: TEKIL_NO }]);
    try {
      s.portal([{ ad: "tekil-yeni", metin: "Sentetik TEKIL DEGISTI metni.", no: TEKIL_NO }]);
      const r = await s.esitle();
      assert.equal(r.korunanEvrak, 1, "tekil grup tazelendi: sınır değişmiş, maliyeti ÖLÇÜN");
      assert.ok(s.metinVar("TEKIL belge", TEKIL_NO), "tekil kayıt beklenmedik biçimde değişti");
      assert.equal(
        s.metinVar("TEKIL DEGISTI", TEKIL_NO),
        false,
        "sınır kalktıysa README ve ROADMAP §15c güncellensin",
      );
    } finally {
      await s.kapat();
    }
  });

  test("MALİYET — tazeleme yalnız BELİRSİZ gruba iner, tekil satır portala sorulmaz", async () => {
    // "Belirsiz grup her turda iner" cümlesinin bedeli sayıyla sabitleniyor:
    // iki belirsiz satır + bir tekil satırda eşitleme başına 2 belge isteği
    // olmalı, 3 değil. Sayı büyürse tekil sınır sessizce kalkmış demektir.
    const s = await sahneKur([ALFA, BETA, { ad: "tekil", metin: "Sentetik TEKIL metni.", no: TEKIL_NO }]);
    try {
      await s.esitle(); // ilk turda sayaç otursun
      const once = s.portalIstekleri();
      await s.esitle();
      const fark = s.portalIstekleri() - once;
      // Liste + detay istekleri de sayılıyor; belge isteği farkı 2 olmalı.
      assert.ok(fark >= 2, `eşitleme hiç indirme yapmadı: ${fark} istek`);
      assert.ok(fark <= 5, `beklenenden çok istek atıldı (${fark}); tekil satır da mı iniyor?`);
    } finally {
      await s.kapat();
    }
  });

  test("DENETİM PORTALA BAKMAZ: eksik belgeyi göremez, gördüğünü de iddia etmez", async () => {
    // Dürüstlük yarısı: denetim yalnız DİSKİ okur. "Portalda var, arşivde yok"
    // sorusunu yanıtlayamaz — o yüzden P20 eşitlemede çözüldü, denetimde
    // değil. Portal istek sayacı denetim boyunca DEĞİŞMEZ (README'de yazılı).
    const s = await sahneKur([ALFA, BETA]);
    try {
      const dn = await s.denetle();
      assert.equal(dn.portalIstegi, 0, "denetim portala istek attı");
      assert.equal(dn.bulgu, 0, "sağlam sentetik arşivde bulgu üretildi");
    } finally {
      await s.kapat();
    }
  });
});

// ── BİRİM TESTLERİ: karar kuralı ─────────────────────────────────────────────

describe("P20 belirsiz havuz", () => {
  const kayit = (ad: string, sha: string): ManifestEvrak =>
    ({
      evrakId: `"${ad}"`,
      stableKey: `ana:${ad}`,
      path: `_kaynak/evraklar/Dosya/03-Kararlar/${ad}.html`,
      sha256: sha,
      isEkEvrak: false,
      category: "03-Kararlar",
      yon: "Dosya",
      tur: "Müzekkere",
      gonderen: "Sentetik Kalem",
      tarih: TARIH,
      birimEvrakNo: BELIRSIZ_NO,
      dosyaKey: TARIH,
      mdStatus: "ok",
      boyut: 10,
    }) as unknown as ManifestEvrak;

  const aday = (k: ManifestEvrak, metin: string | null, ezilebilir?: boolean): AdayKayit => ({
    kayit: k,
    metin,
    bayt: k.sha256,
    ...(ezilebilir === undefined ? {} : { ezilebilir: () => ezilebilir }),
  });
  /** Tanınamayan içerik için BU MEKANİZMANIN açtığı yedek kopya kaydı. */
  const kopya = (ad: string, sha: string): ManifestEvrak => {
    const k = kayit(ad, sha);
    k.belirsizKopya = true;
    return k;
  };
  const YAZ = (k: ManifestEvrak) => ({ tur: "yaz", kayit: k });
  const YENI_YOL = (yedek: boolean) => ({ tur: "yeni-yol", yedek });
  const G = "grup";

  test("metni tanınan satır eldeki kaydı SAHİPLENİR (baytı bambaşka olsa da)", () => {
    // UYAP belgeyi her indirişte yeniden üretiyor: bayt ölçütü tek başına
    // "bende zaten var mı" sorusunu YANITLAYAMAZ.
    const a = kayit("alfa", "sha-a");
    const b = kayit("beta", "sha-b");
    const h = new BelirsizHavuz(new Map([[G, [aday(a, "M-ALFA"), aday(b, "M-BETA")]]]));
    assert.equal(h.esle(G, { metin: "M-BETA", bayt: "bambaska" }), b, "metinle tanınmadı");
  });

  test("sahiplenilen kayıt İKİNCİ satıra verilmez: iki belge tek kayda inmez", () => {
    const a = kayit("s1", "sha-1");
    const b = kayit("s2", "sha-2");
    // İki kaydın metni BİREBİR AYNI (UYAP aynı şablonu iki kez gönderiyor).
    const h = new BelirsizHavuz(new Map([[G, [aday(a, "AYNI"), aday(b, "AYNI")]]]));
    assert.equal(h.esle(G, { metin: "AYNI", bayt: "x" }), a);
    assert.equal(h.esle(G, { metin: "AYNI", bayt: "y" }), b, "ikinci satır aynı kaydı sahiplendi");
    assert.equal(h.esle(G, { metin: "AYNI", bayt: "z" }), undefined, "havuz tükenmedi");
  });

  test("metin ölçülemiyorsa BAYT eşitliği tanır; bayt farklıysa hiçbir şey iddia edilmez", () => {
    const a = kayit("tarama", "sha-gorsel");
    const h = new BelirsizHavuz(new Map([[G, [aday(a, null)]]]));
    assert.equal(h.esle(G, { metin: null, bayt: "sha-gorsel" }), a, "bayt eşitliği tanınmadı");
    const h2 = new BelirsizHavuz(new Map([[G, [aday(a, null)]]]));
    assert.equal(h2.esle(G, { metin: null, bayt: "baska" }), undefined, "ölçülemeyen 'aynı' sayıldı");
  });

  test("metni null olan kayıt METİNLE asla eşleşmez", () => {
    const a = kayit("tarama", "sha-g");
    const h = new BelirsizHavuz(new Map([[G, [aday(a, null)]]]));
    assert.equal(h.esle(G, { metin: "bir-metin", bayt: "bir-bayt" }), undefined);
  });

  test("SAYMA KURALI — boşta kayıt ev arayan satırları TAM karşılıyorsa üzerine yazılır", () => {
    const a = kayit("alfa", "sha-a");
    const h = new BelirsizHavuz(new Map([[G, [aday(a, "M-ALFA")]]]));
    // B = 1, K = 0 → B == K + 1
    assert.deepEqual(h.kurban(G, { metin: "YENI", bayt: "b" }, a, 0), YAZ(a));
  });

  test("SAYMA KURALI — grup BÜYÜYORSA üzerine yazılmaz: kardeşin kaydı çalınmaz", () => {
    // Portal üç satır bildiriyor, manifestte iki kayıt var; ilk satır tanınmadı.
    // B = 2, K = 2 → B < K + 1 → yeni yol. Üzerine yazılsaydı ikinci satır
    // metniyle tanıyacağı kaydı bulamaz ve zincirleme yeniden yazma başlardı.
    const a = kayit("alfa", "sha-a");
    const b = kayit("beta", "sha-b");
    const h = new BelirsizHavuz(new Map([[G, [aday(a, "M-ALFA"), aday(b, "M-BETA")]]]));
    assert.deepEqual(h.kurban(G, { metin: "M-YENI", bayt: "x" }, a, 2), YENI_YOL(false));
  });

  test("SAYMA KURALI — grupta FAZLA kayıt varsa üzerine yazılmaz: portalın düşürdüğü belge ezilmez", () => {
    // B = 2, K = 0 → B > K + 1. Fazla kayıtlar portalın artık bildirmediği ama
    // arşivde duran belgelerdir (P19 KABUL 4: kayıt silinmez). Ezmek, silmenin
    // daha sinsi biçimidir.
    const a = kayit("alfa", "sha-a");
    const b = kayit("beta", "sha-b");
    const h = new BelirsizHavuz(new Map([[G, [aday(a, "M-ALFA"), aday(b, "M-BETA")]]]));
    assert.deepEqual(h.kurban(G, { metin: "M-YENI", bayt: "x" }, a, 0), YENI_YOL(false));
  });

  test("METİNSİZ içerik sayma kuralının dışındadır — AMA YALNIZ GRUP BÜYÜRKEN", () => {
    // B = 1, K = 1 → B < K + 1. Fazlalık YOK: boşta kayıtların hepsi bir portal
    // satırının karşılığıdır, yazmak hiçbir belgeyi yok etmez. Yeni yol
    // açılsaydı o kayıt bir daha ASLA tanınamaz (metni yok, baytı her
    // indirişte değişiyor) ve her eşitleme bir kayıt daha eklerdi.
    const a = kayit("t1", "sha-1");
    const h = new BelirsizHavuz(new Map([[G, [aday(a, null)]]]));
    assert.deepEqual(h.kurban(G, { metin: null, bayt: "yeni" }, a, 1), YAZ(a));
  });

  test("FAZLA kayıtlı grupta METİNSİZ içerik de hiçbir kaydı EZMEZ", () => {
    // GERİLEMENİN BEKÇİSİ. İstisna buraya da uzatılmıştı ve ölçüldü: arşivdeki
    // [ALFA, BETA, CEM] görsel belgeden portal yalnız CEM'i bildirince birinci
    // eşitleme ALFA'nın, ikincisi BETA'nın belgesini YOK EDİYORDU — kayıt ve
    // dosya sayısı sabit kaldığı için hiçbir yüzey göstermiyor, denetim
    // "0 bulgu" diyordu. B = 2, K = 0 → B > K + 1.
    const a = kayit("t1", "sha-1");
    const b = kayit("t2", "sha-2");
    const h = new BelirsizHavuz(new Map([[G, [aday(a, null), aday(b, null)]]]));
    // Açılan yol YEDEK sayılır: bir sonraki turda yeniden kullanılır, yoksa
    // "ezme" yerine "sınırsız şişme" geçerdi.
    assert.deepEqual(h.kurban(G, { metin: null, bayt: "yeni" }, a, 0), YENI_YOL(true));
  });

  test("FAZLALIKTA yalnız KENDİ AÇTIĞIMIZ yedek kopya yeniden kullanılır", () => {
    // Şişmeyi durduran yarı budur: gerçek belgeler (ALFA, BETA) korunur,
    // tanınamayan içerik geçen turda kendi açtığımız kopyanın yoluna iner.
    const a = kayit("t1", "sha-1");
    const b = kayit("t2", "sha-2");
    const y = kopya("yedek", "sha-y");
    const h = new BelirsizHavuz(new Map([[G, [aday(a, null), aday(b, null), aday(y, null)]]]));
    assert.deepEqual(h.kurban(G, { metin: null, bayt: "yeni" }, a, 0), YAZ(y));
    // Yedek sahiplenildi: ikinci satır artık gerçek belgelere DOKUNAMAZ.
    assert.deepEqual(h.kurban(G, { metin: null, bayt: "yeni2" }, a, 0), YENI_YOL(true));
  });

  test("YEDEK KOPYA ancak METİNSİZ içerik için kullanılır: metinli satır yeni yol açar", () => {
    // Metinli içerik bir sonraki turda metniyle tanınır; şişmesi zaten birde
    // durur. Yedeği ona da açmak, tanınabilir bir belgeyi gereksiz riske atardı.
    const y = kopya("yedek", "sha-y");
    const h = new BelirsizHavuz(new Map([[G, [aday(y, "M-YEDEK")]]]));
    assert.deepEqual(h.kurban(G, { metin: "M-YENI", bayt: "x" }, y, -1), YENI_YOL(false));
  });

  test("YERELDE DEĞİŞMİŞ kaynak kurban seçilmez: çağıran yeni yol açar", () => {
    // README "Veri düzeni"nin sözü: "Yerelde değişmiş kaynak üzerine yazılmaz,
    // yeni indirme ayrı dosyaya kaydedilir." B == K + 1 olsa bile geçerlidir.
    const a = kayit("alfa", "sha-a");
    const h = new BelirsizHavuz(new Map([[G, [aday(a, "M-ALFA", false)]]]));
    assert.deepEqual(h.kurban(G, { metin: "M-YENI", bayt: "x" }, a, 0), YENI_YOL(false));
    // Metinsiz içerikte de ezilmez, ama açılan yol YEDEK sayılır (şişme durur).
    const h2 = new BelirsizHavuz(new Map([[G, [aday(a, null, false)]]]));
    assert.deepEqual(h2.kurban(G, { metin: null, bayt: "x" }, a, 0), YENI_YOL(true));
  });

  test("değişmemiş kardeş varken yerelde değişmiş kayıt ATLANIR, öteki seçilir", () => {
    const degismis = kayit("alfa", "sha-a");
    const saglam = kayit("beta", "sha-b");
    const h = new BelirsizHavuz(
      new Map([[G, [aday(degismis, null, false), aday(saglam, null, true)]]]),
    );
    // B = 2, K = 1 → B == K + 1; tercih değişmiş kayıt ama o ezilemez.
    assert.deepEqual(h.kurban(G, { metin: null, bayt: "x" }, degismis, 1), YAZ(saglam));
  });

  test("kurban seçimi: metinsiz içerik, METİNSİZ kaydı yeğler", () => {
    // Görsel satır metinli bir kaydı kurban ederse o metni bekleyen kardeş de
    // yazmak zorunda kalır ve grup her turda kendi içinde yer değiştirir.
    const metinli = kayit("alfa", "sha-a");
    const metinsiz = kayit("tarama", "sha-g");
    const h = new BelirsizHavuz(new Map([[G, [aday(metinli, "M-ALFA"), aday(metinsiz, null)]]]));
    assert.deepEqual(h.kurban(G, { metin: null, bayt: "yeni-bayt" }, metinli, 1), YAZ(metinsiz));
  });

  test("boşta kayıt YOKSA hiçbir şey ezilmez: çağıran yeni yol açar", () => {
    const a = kayit("alfa", "sha-a");
    const h = new BelirsizHavuz(new Map([[G, [aday(a, "M-ALFA")]]]));
    h.sahiplen(a);
    assert.deepEqual(h.kurban(G, { metin: null, bayt: "x" }, a, 0), YENI_YOL(false));
    assert.deepEqual(h.kurban(G, { metin: "Y", bayt: "x" }, a, 0), YENI_YOL(false));
  });

  test("sahiplen(): tazelenmeyecek satırın kaydı havuza girmez", () => {
    const a = kayit("alfa", "sha-a");
    const h = new BelirsizHavuz(new Map([[G, [aday(a, "M-ALFA")]]]));
    h.sahiplen(a);
    assert.equal(h.esle(G, { metin: "M-ALFA", bayt: "sha-a" }), undefined);
  });
});

// ── BİRİM TESTİ: ölçütün iki ucu ayrışmamalı ────────────────────────────────

describe("P20 metin ölçütü tek kaynaktan gelir", () => {
  test("baytlardanMetin, donustur'un yazdığı .md ile BİREBİR aynı dizeyi üretir", () => {
    // Ayrışırlarsa hiçbir kayıt tanınmaz ve her belirsiz satır her turda
    // boşuna yenilenir — kusur sessiz, bedel sürekli olurdu.
    const html = makeHtml("<div>Sentetik olcut metni.</div>", "Belge");
    const dogrudan = htmlToMd(html.toString("utf8")).md;
    const baytlardan = baytlardanMetin(html, ".html");
    assert.equal(baytlardan.mdStatus, "ok");
    assert.equal(baytlardan.md, dogrudan);
    assert.equal(
      createHash("sha256").update(baytlardan.md!).digest("hex"),
      createHash("sha256").update(Buffer.from(dogrudan, "utf8")).digest("hex"),
      "özet biçimi ayrıştı: manifest .md DOSYASININ baytıyla karşılaştırılıyor",
    );
  });

  test("görsel evrakta metin YOK: 'gorsel' döner, md üretilmez", () => {
    const son = baytlardanMetin(Buffer.from("PNG\r\n\n sentetik", "binary"), ".png");
    assert.equal(son.mdStatus, "gorsel");
    assert.equal(son.md, undefined);
  });

  test("bilinmeyen uzantı 'desteklenmiyor' sayılır ve md üretilmez", () => {
    const son = baytlardanMetin(Buffer.from("ham"), ".xyz");
    assert.equal(son.mdStatus, "desteklenmiyor");
    assert.equal(son.md, undefined);
  });

  test("dosya sayacı gerçek diski okur (bu dosyanın ölçüm bekçisi)", () => {
    const t = tmpKok();
    try {
      assert.ok(statSync(t.kok).isDirectory());
      assert.equal(dosyaSayisi(t.kok), 0);
    } finally {
      t.temizle();
    }
  });
});
