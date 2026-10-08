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
const BIRIM = "Bagimsiz Kontrol Asliye Ceza Mahkemesi";
const BIRIM_ID = "9030";
const ESAS = "2026/530";
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
    dosyaId: opakToken("wk-dosya"),
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


// ── ORKESTRATORUN BAGIMSIZ KONTROLU ─────────────────────────────────────────
// Onarim turu incelenmedi. Ucu de VERI YOK ETME cinsinden olan engelleyici
// bulgularin gercekten kapandigini kendi senaryolarimla olcuyorum.
// Olcut SAYI DEGIL ICERIK: kusurun tam sekli "sayi dogru, belge yanlis"ti.
describe("BAGIMSIZ KONTROL — P20 veri kaybi", () => {
  test("K1 — uye degisimi: portalin yeni belgesi arsive GIRER", async () => {
    const s = await sahneKur([{ ad: "alfa", metin: "ALFA metni" }, { ad: "beta", metin: "BETA metni" }]);
    try {
      s.portal([{ ad: "alfa", metin: "ALFA metni" }, { ad: "gama", metin: "GAMA metni" }]);
      await s.esitle();
      assert.ok(s.metinVar("ALFA"), "ALFA kayboldu");
      assert.ok(s.metinVar("GAMA"), "portalin YENI belgesi inmedi");
      assert.equal(s.kayitSayisi(), 2, "kayit sismesi");
    } finally { await s.kapat(); }
  });

  test("K2 — hicbir sey degismiyor: uc turda kayit, DOSYA ve icerik sabit", async () => {
    const s = await sahneKur([{ ad: "alfa", metin: "ALFA metni" }, { ad: "beta", metin: "BETA metni" }]);
    try {
      const olcum: string[] = [];
      for (let t = 0; t < 3; t++) {
        const r = await s.esitle();
        olcum.push(`${s.kayitSayisi()}/${s.dosyaSayisi()}/y${r.yeniEvrak}/n${r.yenilenenEvrak}`);
      }
      assert.equal(new Set(olcum).size, 1, `tur turu degisti: ${JSON.stringify(olcum)}`);
      assert.match(olcum[0]!, /\/y0\/n0$/, `bos turda sayac konusuyor: ${olcum[0]}`);
      assert.ok(s.metinVar("ALFA") && s.metinVar("BETA"), "belge kayboldu");
    } finally { await s.kapat(); }
  });

  test("K3 — GORSEL grup kuculunce hicbir belge YOK EDILMEZ", async () => {
    const s = await sahneKur([
      { ad: "tara1", metin: null, damga: true },
      { ad: "tara2", metin: null, damga: true },
      { ad: "tara3", metin: null, damga: true },
    ]);
    try {
      const once = s.hamEtiketler();
      s.portal([{ ad: "tara3", metin: null, damga: true }]);
      for (let t = 0; t < 3; t++) await s.esitle();
      const sonra = s.hamEtiketler();
      for (const e of once)
        assert.ok(sonra.includes(e), `belge YOK EDILDI: ${e} — once ${JSON.stringify(once)} sonra ${JSON.stringify(sonra)}`);
    } finally { await s.kapat(); }
  });

  test("K4 — kullanicinin ELLE ekledigi not ezilmez", async () => {
    const s = await sahneKur([{ ad: "alfa", metin: "ALFA metni" }, { ad: "beta", metin: "BETA metni" }]);
    try {
      const yol = s.hamYol("BETA");
      const NOT = "<!-- AVUKAT NOTU -->";
      writeFileSync(yol, readFileSync(yol, "utf8") + NOT);
      s.portal([{ ad: "alfa", metin: "ALFA metni" }, { ad: "gama", metin: "GAMA metni" }]);
      await s.esitle();
      const notDuruyor = s.hamEtiketler().some((_, i) => false) ||
        readdirSync(join(yol, ".."), { withFileTypes: true })
          .filter((g) => g.isFile())
          .some((g) => readFileSync(join(yol, "..", g.name), "utf8").includes(NOT));
      assert.ok(notDuruyor, "kullanicinin notu EZILDI");
      assert.ok(s.metinVar("GAMA"), "portalin yeni belgesi inmedi");
    } finally { await s.kapat(); }
  });
});
