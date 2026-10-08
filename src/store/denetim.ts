// P06a — YEREL ARŞİV DENETİMİ. Salt-okunur.
//
// Kullanıcı sorusu: "arşivim sağlam mı?" — oturum açmadan, portala TEK istek
// atmadan, satır satır cevap. Bu modül registry kaydını, dava klasörünü,
// manifest'i, kaynak dosyayı ve türevi karşılaştırır.
//
// ── BU MODÜL HİÇBİR ŞEY YAZMAZ ──────────────────────────────────────────────
// Belge, manifest, registry, sorunlar.json — hiçbiri değişmez. Sorun kaydı
// AÇILMAZ (P16 sayacı eşitlemenin ürettiği kayıtları sayar; denetim ayrı bir
// yüzeydir). Onarım YOKTUR — o P06b'dir; bulgu metni "düzelttim" ya da
// "düzelteceğim" demez. İddia değil ÖLÇÜM: test/arsiv-denetim.test.ts denetim
// öncesi ve sonrası arşivdeki HER dosyanın sha256'sını ve dosya kümesini
// karşılaştırır.
//
// ── P15c İLE İLİŞKİ ─────────────────────────────────────────────────────────
// P15c yalnız "manifest'teki yol diskte var mı" der (satır rozeti). Bu modül
// kendi "eksik" tanımını YAZMAZ: aynı yardımcıyı çağırır
// (src/store/fsops.ts `kaynakOlcer`), yoksa kullanıcı iki farklı "eksik"
// görürdü. P06a'nın yeni getirdiği: hash uyuşmazlığı, yetim dosya, bozuk
// manifest, kırık türev, mükerrer kayıt, kök dışı yol, kayıtsız klasör,
// kaydı boşalmış dava.
//
// ── ÖLÇEK KARARI (12 Eylül 2026, bu makine, ölçülerek) ──────────────────────
// Akış hash'i (createReadStream + sha256, 1 MiB tampon) ölçüldü:
//     64 KiB  0,3 ms · 1 MiB 0,6 ms · 4 MiB 2,0 ms · 32 MiB 12,6 ms
//    128 MiB 48,5 ms
//    200 dosya × 48 KiB  →  23 ms
//   1000 dosya × 48 KiB  →  99 ms
//   5000 dosya × 48 KiB (234 MiB) → 501 ms
// Yani 10.000 dosya / 500 MB ≈ 1 sn. Bu ölçekte denetim SENKRON bir RPC olarak
// döner: P04 iş deposuna yeni `tur` yazılmaz, arka plan kuyruğu ve ilerleme
// çubuğu kurulmaz (bu ölçekte gereksiz altyapı, P04 şemasını kirletir).
// AMA tek dosya belleğe komple ALINMAZ: akış hash'i kullanılır. Senkron
// `readFileSync` küçük dosyada 3,5× hızlıydı (5000 dosyada 144 ms vs 501 ms) ve
// bilerek ELENDİ — 1 GiB'lık tek bir kayıt motoru şişirirdi, kazanılan 350 ms
// bunun karşılığı değil.
//
// ── ÜST SINIRLAR ────────────────────────────────────────────────────────────
// `DOSYA_TAVANI` 256 MiB: UyapIstemci'nin yanıt tavanı 128 MiB'dir
// (`YANIT_TAVANI`), yani bu uygulamanın indirdiği hiçbir evrak 128 MiB'ı
// geçemez. 2× pay bırakıldı ki gerçek bir evrak asla "ölçülmedi" damgası
// yemesin; tavanı aşan kayıt (manifest'i bir disk imajına bakan patolojik
// satır) SESSİZCE SAĞLAM SAYILMAZ, `olculmedi-buyuk` diye AYRI raporlanır.
// Tavan sınırındaki maliyet ölçüldü: 128 MiB 48 ms, 256 MiB ≈ 97 ms.
// `SURE_TAVANI_MS` 20 sn: web sunucusunun istek zaman aşımı 30 sn'dir
// (src/server/web.ts `requestTimeout`); 20 sn gerçekçi en kötü durumun
// (≈1 sn) 20 katıdır. Aşılırsa ELDEKİ RAPOR KORUNUR ve `tamamlandi:false`
// olur — yarım sonucu "temiz" diye göstermek bu üründeki en kötü yalandır.

import { createHash } from "node:crypto";
import {
  createReadStream,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { pipeline } from "node:stream/promises";
import { join, relative, resolve } from "node:path";
import { kapsamIcindeMi, kaynakOlcer, yarimYazimHedefi, type KaynakOlcum } from "./fsops.js";
import {
  belirsizGrupKayitlari,
  ikizKayitlar,
  olculemezSisme,
  olculemezYiginlar,
  sismisGruplar,
} from "./sisme.js";
import { onarimBilgisi, type OnarimBilgisi } from "./onarim.js";
import { MANIFEST_YEDEK_DESENI, type ManifestEvrak } from "./manifest.js";
import type { DavaKaydi } from "./registry.js";

/** Manifest dosyasının adı — tek yerde. */
const MANIFEST_ADI = "uyap-project.json";
/**
 * Orkestratörün sadeleştirme/onarım öncesi bıraktığı manifest yedeği (yetim
 * DEĞİL). Desen `src/store/manifest.ts`ten GELİR: burada ikinci bir kopya
 * tutulsaydı yedek adı değiştiği gün (P06c'de değişti: aynı milisaniyedeki
 * ikinci yedek sonek alıyor) kullanıcının güvenlik ağı "kayıtsız dosya"
 * listesine düşerdi.
 */
const MANIFEST_YEDEK = MANIFEST_YEDEK_DESENI;

export interface DenetimSinirlari {
  /** Tek dosya için hash tavanı (bayt). Aşan dosya `olculmedi-buyuk` olur. */
  dosyaTavani: number;
  /** Tüm denetimin duvar saati bütçesi (ms). Aşılırsa sonuç kısmi döner. */
  sureTavaniMs: number;
  /** Yürüyüşte görülebilecek toplam dizin girdisi. */
  girdiTavani: number;
  /** Dava klasörü içinde inilecek en fazla derinlik. */
  derinlikTavani: number;
  /** Kayıtsız dava klasörü ararken arşiv kökünden inilecek derinlik. */
  kesifDerinligi: number;
}

export const VARSAYILAN_SINIRLAR: DenetimSinirlari = {
  dosyaTavani: 256 * 1024 * 1024,
  sureTavaniMs: 20_000,
  girdiTavani: 50_000,
  derinlikTavani: 12,
  kesifDerinligi: 6,
};

export type BulguTuru =
  // kayıt ekseni
  | "manifest-yok"
  | "manifest-bozuk"
  | "manifest-erisilemiyor"
  | "kayit-bozuk"
  | "kayitlar-eksik"
  | "mukerrer-kayit"
  | "yol-cakismasi"
  // P19 — aynı grupta metni birebir aynı birden çok kayıt. `mukerrer-kayit`
  // DEĞİLDİR: orada satırlar bayt bayt aynıdır, burada baytlar FARKLI
  // (UYAP belgeyi her indirişte yeniden üretiyor) ama belge aynı belgedir.
  | "grup-sismis"
  // P19 (inceleme) — aynı grupta BAYT BAYT aynı iki kayıt, AYRI dosyalarda.
  // `grup-sismis` bunu kaçırıyordu: kayıt sayısı portalınkine eşit olduğu
  // için elek hiç bakmıyordu, oysa kopya duran belgenin KARDEŞİ arşivde yok.
  | "grup-ikiz"
  // P19 (inceleme) — gruplanamayan (numarasız ana) kayıtlarda sessiz birikme.
  // Kimlik TAHMİN EDİLMEZ, yalnız görünür kılınır; ağırlığı `bilgi`dir.
  | "grup-olculemez"
  // klasör / registry ekseni
  | "klasor-yok"
  | "klasor-erisilemiyor"
  | "kayitsiz-klasor"
  // kaynak ekseni
  | "kaynak-yok"
  | "kaynak-erisilemiyor"
  | "hash-uyusmuyor"
  | "olculmedi-buyuk"
  | "kapsam-disi"
  // türev ekseni
  | "turev-yok"
  | "turev-erisilemiyor"
  // yarım kalmış yazım
  // P06c — atomik yazımın ARTIĞI: `.<ad>.<pid>.<uuid>.tmp`. `yetim-dosya`
  // DEĞİLDİR ve onunla aynı kefeye konamaz: yetim dosya tamamlanmış bir
  // belgedir (korunmuş eski bir kaynak olabilir, ağırlığı `bilgi`), bu ise
  // TAMAMLANMAMIŞ bir yazımdır — hedef belge eski hâlinde kalmış ya da hiç
  // yazılmamış olabilir. Kesintiden sonra denetimin "bulgu yok" demesini
  // engelleyen tek satır budur.
  | "yarim-yazim"
  // P06c (inceleme) — AYNI ARTIK, KAPANMIŞ HÂLİ: hedef belge o klasörde
  // duruyor ve kaydının sha256'sıyla birebir. Kesinti gerçekten olmuştur ve
  // görünür kalır, ama artık kullanıcıdan bir karar beklemez; `yarim-yazim`
  // ile aynı türde bırakılsaydı sağlıklı arşiv kalıcı olarak "1 bulgu" okunur
  // ve satır kullanıcıya zaten yaptığı eşitlemeyi tekrar önerirdi (ölçüldü).
  | "yarim-yazim-artigi"
  // yetim
  | "yetim-dosya";

/**
 * Bulgunun EKSENİ. Kaynak hatası ile "metin çıkarılamıyor" aynı kırmızıya
 * SIKIŞTIRILMAZ (ROADMAP §4 adım 7): arayüz bu alana göre gruplar.
 */
export type BulguEkseni = "kayit" | "klasor" | "kaynak" | "turev" | "yarim" | "yetim";

/**
 * `bulgu` = kullanıcının bilmesi gereken bir tutarsızlık.
 * `bilgi` = tutarsızlık DEĞİL, sadece anlatılması gereken durum. Yetim dosya
 * "silinecek çöp" DEĞİLDİR — korunmuş eski bir kaynak olabilir; ölçülemeyen
 * büyük dosya da bir bozukluk değil, ölçümün sınırıdır.
 */
export type BulguAgirligi = "bulgu" | "bilgi";

export interface Bulgu {
  tur: BulguTuru;
  eksen: BulguEkseni;
  agirlik: BulguAgirligi;
  /**
   * P06b — bu bulgu onarılabilir mi, nasıl? Karar MOTORDA, tek yerde
   * (`src/store/onarim.ts` `ONARIM_TABLOSU`); arayüz ikinci bir tablo yazmaz,
   * yalnız gelen kararı gösterir. `eylem: null` ise düğme ÇİZİLMEZ ve `sebep`
   * satırda yazılır — onarılamayanı onarılabilir göstermek yasaktır.
   */
  onarim: OnarimBilgisi;
  /** Dava anahtarı; arşiv düzeyindeki bulguda boş dizedir. */
  caseKey: string;
  /** Kullanıcıya gösterilecek dava adı ("Birim Esas"); opak token DEĞİL. */
  dava: string;
  /** Dava klasörüne (arşiv düzeyinde: arşiv köküne) göreli yol. Mutlak yol yok. */
  yol: string;
  /** Türkçe, tek cümlelik açıklama. Opak portal tokenı taşımaz. */
  aciklama: string;
  beklenen?: string;
  olculen?: string;
  errno?: string;
  boyut?: number;
  adet?: number;
}

export type DavaDurumu = "denetlendi" | "atlandi-mesgul" | "kismi" | "denetlenemedi";

export interface DenetimDava {
  caseKey: string;
  dava: string;
  durum: DavaDurumu;
  /** Manifest'te incelenen kayıt sayısı. */
  kayit: number;
  /** Kaynağı yerinde VE özeti tutan kayıt sayısı. */
  saglam: number;
  bulgu: number;
  bilgi: number;
  /** Neden kısmi/denetlenemedi — Türkçe tek cümle. */
  not?: string;
}

export interface DenetimSayilari {
  dava: number;
  denetlenen: number;
  kayit: number;
  saglam: number;
  olculenBayt: number;
  dosya: number;
  turev: number;
  yedek: number;
  yetim: number;
  /** P06c — yarım kalmış atomik yazımın artığı (`.tmp`). */
  yarim: number;
  atlanan: number;
  bulgu: number;
  bilgi: number;
}

export interface DenetimSonucu {
  at: string;
  sureMs: number;
  /** Kapsamın TAMAMI ölçülebildi mi? Kısmi sonuç asla "temiz" gösterilmez. */
  tamamlandi: boolean;
  kismiSebep?: string;
  kapsam: { caseKey: string | null; tumArsiv: boolean };
  sinirlar: DenetimSinirlari;
  sayilar: DenetimSayilari;
  davalar: DenetimDava[];
  bulgular: Bulgu[];
}

export interface DenetimGirdi {
  /** Arşiv kökü. Kök dışına çıkan hiçbir yol okunmaz. */
  kok: string;
  /** Registry kayıtları (okunmuş hâlleri); bu modül registry AÇMAZ. */
  davalar: readonly DavaKaydi[];
  /** Verilirse yalnız o dava denetlenir; verilmezse tüm arşiv. */
  caseKey?: string | null;
  /**
   * "Bu dava için şu anda açık iş var mı?" Eşitleme sürerken evrak dosyaları
   * yazılıyor olabilir; o davayı denetlemek uydurma `kaynak-yok` /
   * `hash-uyusmuyor` üretirdi. Meşgul dava ATLANIR ve rapor kısmi olur.
   */
  mesgul?: (caseKey: string) => boolean;
  /** Kullanıcı iptali / dış zaman aşımı kancası. */
  iptal?: () => boolean;
  sinirlar?: Partial<DenetimSinirlari>;
  /** Test için saat enjeksiyonu. */
  simdi?: () => number;
}

/** Manifest okumasının DÖRT ayrı sonucu: yok / erişilemedi / bozuk / geçerli. */
type ManifestOkuma =
  | { tur: "yok" }
  | { tur: "erisilemiyor"; errno?: string }
  | { tur: "kapsamDisi" }
  | { tur: "bozuk"; sebep: string }
  | {
      tur: "gecerli";
      evraklar: ManifestEvrak[];
      /** P19 — portalın grup başına bildirdiği satır sayısı; yoksa undefined. */
      grupSayilari?: Record<string, number>;
    };

/** macOS'ta büyük/küçük harf ve Unicode normalizasyonu yol eşlemesini bozar. */
function yolAnahtari(p: string): string {
  return p.normalize("NFC").toLowerCase();
}

const HEX64 = /^[0-9a-f]{64}$/;

async function akisHash(yol: string): Promise<string> {
  const h = createHash("sha256");
  await pipeline(createReadStream(yol, { highWaterMark: 1 << 20 }), h);
  return h.digest("hex");
}

function errnoAl(e: unknown): string {
  return (e as NodeJS.ErrnoException).code ?? "EUNKNOWN";
}

/**
 * Manifest'i SINIFLAYARAK okur. `ManifestDepo.oku()` bilerek gevşektir ve üç
 * ayrı başarısızlığı (dosya yok / okunamadı / JSON bozuk) tek bir `null`a
 * indirger; denetimin görevi tam olarak bu üçünü AYIRMAKTIR.
 */
function manifestOku(klasor: string, olc: (h: string) => KaynakOlcum): ManifestOkuma {
  const yol = join(klasor, MANIFEST_ADI);
  const olcum = olc(yol);
  if (olcum.durum === "kapsamDisi") return { tur: "kapsamDisi" };
  if (olcum.durum === "yok") return { tur: "yok" };
  if (olcum.durum === "erisilemiyor")
    return olcum.errno !== undefined
      ? { tur: "erisilemiyor", errno: olcum.errno }
      : { tur: "erisilemiyor" };
  if (olcum.tur !== "dosya")
    return { tur: "bozuk", sebep: "kayıtlı yerde dosya değil bir klasör duruyor" };
  let ham: string;
  try {
    ham = readFileSync(yol, "utf8");
  } catch (e) {
    return { tur: "erisilemiyor", errno: errnoAl(e) };
  }
  let coz: unknown;
  try {
    coz = JSON.parse(ham);
  } catch {
    return { tur: "bozuk", sebep: "JSON olarak çözümlenemedi" };
  }
  const v = coz as { evraklar?: unknown; dosyaId?: unknown; grupSayilari?: unknown } | null;
  if (!v || typeof v !== "object" || Array.isArray(v))
    return { tur: "bozuk", sebep: "beklenen JSON nesnesi değil" };
  if (typeof v.dosyaId !== "string")
    return { tur: "bozuk", sebep: "dosya kimliği alanı yok" };
  if (!Array.isArray(v.evraklar))
    return { tur: "bozuk", sebep: "evrak listesi yok ya da dizi değil" };
  // `grupSayilari` DOĞRULANIR, güvenilmez: elle düzenlenmiş ya da eski bir
  // manifestte sayı yerine başka bir şey durabilir. Geçersiz değer taşıyan
  // anahtar hiç okunmamış sayılır — o grup "portal sayısı bilinmiyor" dalına
  // düşer ve otomatik sadeleştirilmez.
  const sayilar: Record<string, number> = {};
  const ham2 = v.grupSayilari;
  if (ham2 && typeof ham2 === "object" && !Array.isArray(ham2)) {
    for (const [k, deger] of Object.entries(ham2 as Record<string, unknown>)) {
      if (typeof deger === "number" && Number.isInteger(deger) && deger >= 0) sayilar[k] = deger;
    }
  }
  return {
    tur: "gecerli",
    evraklar: v.evraklar as ManifestEvrak[],
    ...(Object.keys(sayilar).length > 0 ? { grupSayilari: sayilar } : {}),
  };
}

/**
 * Mükerrer kayıt ölçütü `src/store/tekrar.ts` `ayniKaynakTekillestir`den ÖDÜNÇ
 * ALINDI: `evrakId` ve `indirmeDamgasi` DIŞINDA bütün alanlar eşitse aynı
 * belgedir. Ödünç alınan ölçüttür, DAVRANIŞ DEĞİL — denetim birleştirmez,
 * yalnız bildirir. Adı aynı ama içeriği farklı iki belge (farklı `sha256`,
 * farklı `tur`…) bu anahtarda AYRI düşer, yani "aynı adlı farklı belgeler"
 * asla mükerrer sayılmaz.
 */
function tekrarAnahtari(e: ManifestEvrak): string {
  return JSON.stringify(
    Object.entries(e as unknown as Record<string, unknown>)
      .filter(([k]) => k !== "evrakId" && k !== "indirmeDamgasi")
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

export async function arsiviDenetle(girdi: DenetimGirdi): Promise<DenetimSonucu> {
  const sinirlar: DenetimSinirlari = { ...VARSAYILAN_SINIRLAR, ...girdi.sinirlar };
  const simdi = girdi.simdi ?? (() => Date.now());
  const baslangic = simdi();
  const mesgul = girdi.mesgul ?? (() => false);
  const bulgular: Bulgu[] = [];
  const davaSatirlari: DenetimDava[] = [];
  const sayilar: DenetimSayilari = {
    dava: 0,
    denetlenen: 0,
    kayit: 0,
    saglam: 0,
    olculenBayt: 0,
    dosya: 0,
    turev: 0,
    yedek: 0,
    yetim: 0,
    yarim: 0,
    atlanan: 0,
    bulgu: 0,
    bilgi: 0,
  };
  let girdiSayaci = 0;
  const kismiSebepleri: string[] = [];
  const kismiEkle = (s: string) => {
    if (!kismiSebepleri.includes(s)) kismiSebepleri.push(s);
  };

  const butceDoldu = (): boolean => {
    if (girdi.iptal?.() === true) {
      kismiEkle("Denetim durduruldu.");
      return true;
    }
    if (simdi() - baslangic > sinirlar.sureTavaniMs) {
      kismiEkle(
        `Denetim ${Math.round(sinirlar.sureTavaniMs / 1000)} saniyelik süre bütçesini doldurdu.`,
      );
      return true;
    }
    if (girdiSayaci > sinirlar.girdiTavani) {
      kismiEkle(
        `Arşivde ${sinirlar.girdiTavani} dosya/klasör girdisi tarandı; tarama burada durdu.`,
      );
      return true;
    }
    return false;
  };

  // Kök ölçer TEK KEZ kurulur: kök ve her dizin bir kez çözülür (fsops'taki
  // önbelleğin gerekçesi budur), tur bitince atılır — rozet bayatlamaz.
  const kokOlc = kaynakOlcer(girdi.kok);
  const tumArsiv = girdi.caseKey === undefined || girdi.caseKey === null || girdi.caseKey === "";
  const hedefler = girdi.davalar.filter(
    (d) => d.klonYolu !== undefined && (tumArsiv || d.caseKey === girdi.caseKey),
  );
  sayilar.dava = hedefler.length;

  for (const kayit of hedefler) {
    const klasor = kayit.klonYolu!;
    const dava = `${kayit.birimAdi} ${kayit.dosyaNo}`.trim();
    const satir: DenetimDava = {
      caseKey: kayit.caseKey,
      dava,
      durum: "denetlendi",
      kayit: 0,
      saglam: 0,
      bulgu: 0,
      bilgi: 0,
    };
    davaSatirlari.push(satir);
    const ekle = (b: Omit<Bulgu, "caseKey" | "dava" | "onarim">) => {
      bulgular.push({ ...b, caseKey: kayit.caseKey, dava, onarim: onarimBilgisi(b.tur) });
      if (b.agirlik === "bulgu") {
        satir.bulgu++;
        sayilar.bulgu++;
      } else {
        satir.bilgi++;
        sayilar.bilgi++;
      }
    };

    // EŞİTLEME SÜRERKEN TUTARSIZ "TEMİZ" RAPOR VERİLMEZ. Karar ölçülerek
    // verildi: orkestratör evrak dosyasını indirir indirmez diske yazıp
    // manifest'i EVRAK BAŞINA güncelliyor (src/jobs/orchestrator.ts), yani
    // eşitleme sürerken manifest ile disk arasında geçici tutarsızlık NORMALDİR
    // — o anda alınan hash uyuşmazlığı bir bozukluk değil, yarı yazılmış bir
    // dosyadır. Bütün denetimi reddetmek de yanlış olurdu (kullanıcı 20 davalık
    // arşivinin 19'u hakkında hiçbir şey öğrenemezdi). Bu yüzden: meşgul dava
    // ATLANIR, rapor kısmi olur ve o dava "sağlam" SAYILMAZ.
    if (mesgul(kayit.caseKey)) {
      satir.durum = "atlandi-mesgul";
      satir.not = "Bu dosya için eşitleme sürüyor; denetim sonucu yanıltıcı olurdu.";
      kismiEkle("Eşitlemesi süren dosyalar denetlenmedi.");
      continue;
    }
    if (butceDoldu()) {
      satir.durum = "denetlenemedi";
      satir.not = "Denetim bütçesi doldu; bu dosyaya sıra gelmedi.";
      continue;
    }

    // Kapsam ve erişilebilirlik: kök dışına çıkan klasör HİÇ açılmaz.
    const klasorOlcum = kokOlc(klasor);
    if (klasorOlcum.durum === "kapsamDisi") {
      satir.durum = "denetlenemedi";
      satir.not = "Kayıtlı klasör arşiv kökünün dışını gösteriyor.";
      ekle({
        tur: "kapsam-disi",
        eksen: "klasor",
        agirlik: "bulgu",
        yol: "(dava klasörü)",
        aciklama:
          "Kayıtlı dava klasörü arşiv kökünün dışına çıkıyor; içeriği okunmadı ve rapora alınmadı.",
      });
      continue;
    }
    if (klasorOlcum.durum === "erisilemiyor") {
      satir.durum = "denetlenemedi";
      satir.not = "Dava klasörüne erişilemedi.";
      ekle({
        tur: "klasor-erisilemiyor",
        eksen: "klasor",
        agirlik: "bulgu",
        yol: "(dava klasörü)",
        aciklama:
          "Dava klasörü okunamadı (izin ya da bağlı olmayan bir disk olabilir); silinmiş olduğu anlamına gelmez.",
        ...(klasorOlcum.errno !== undefined ? { errno: klasorOlcum.errno } : {}),
      });
      continue;
    }
    if (klasorOlcum.durum === "yok" || klasorOlcum.tur !== "dizin") {
      satir.durum = "denetlenemedi";
      satir.not = "Kayıtlı dava klasörü arşivde yok.";
      ekle({
        tur: "klasor-yok",
        eksen: "klasor",
        agirlik: "bulgu",
        yol: "(dava klasörü)",
        aciklama:
          klasorOlcum.durum === "yok"
            ? "Bu dosya kayıtlı ama klasörü arşivde yok; taşınmış ya da silinmiş olabilir."
            : "Kayıtlı dava klasörünün yerinde bir klasör değil, başka bir şey duruyor.",
      });
      continue;
    }

    // Bundan sonraki bütün ölçümlerin kökü DAVA KLASÖRÜDÜR: manifest yolları
    // dava klasörüne görelidir, dolayısıyla klasörden dışarı çıkan bir kayıt
    // (arşiv içinde kalsa bile) kapsam dışıdır.
    const olc = kaynakOlcer(klasor);
    const okuma = manifestOku(klasor, olc);
    if (okuma.tur !== "gecerli") {
      satir.durum = "denetlenemedi";
      if (okuma.tur === "yok") {
        satir.not = "Dava kaydı (manifest) arşivde yok.";
        ekle({
          tur: "manifest-yok",
          eksen: "kayit",
          agirlik: "bulgu",
          yol: MANIFEST_ADI,
          aciklama:
            "Bu dosyanın kaydı arşivde yok; klasördeki belgelerin hangi evraka ait olduğu bilinemiyor.",
        });
      } else if (okuma.tur === "erisilemiyor") {
        satir.not = "Dava kaydı okunamadı.";
        ekle({
          tur: "manifest-erisilemiyor",
          eksen: "kayit",
          agirlik: "bulgu",
          yol: MANIFEST_ADI,
          aciklama:
            "Dosya kaydı okunamadı (izin ya da bağlı olmayan bir disk olabilir); silinmiş olduğu anlamına gelmez.",
          ...(okuma.errno !== undefined ? { errno: okuma.errno } : {}),
        });
      } else if (okuma.tur === "kapsamDisi") {
        satir.not = "Dava kaydı arşiv kökünün dışını gösteriyor.";
        ekle({
          tur: "kapsam-disi",
          eksen: "kayit",
          agirlik: "bulgu",
          yol: MANIFEST_ADI,
          aciklama: "Dosya kaydı dava klasörünün dışına çıkıyor; okunmadı.",
        });
      } else {
        satir.not = "Dava kaydı bozuk.";
        ekle({
          tur: "manifest-bozuk",
          eksen: "kayit",
          agirlik: "bulgu",
          yol: MANIFEST_ADI,
          aciklama: `Dosya kaydı bozuk (${okuma.sebep}); bu dosyanın evrakları denetlenemedi.`,
        });
      }
      continue;
    }

    const kayitlar = okuma.evraklar;
    tekrarlariBildir(kayitlar, ekle);

    // ── satır satır: kaynak + türev ─────────────────────────────────────────
    const bilinen = new Set<string>();
    /**
     * P06c (inceleme) — BU TARAMADA ÖZETİYLE BİREBİR ÖLÇÜLEN kaynak yolları.
     *
     * `bilinen`den AYRIDIR: orada "manifest bu yolu anıyor" yazar, burada
     * "dosya yerinde ve sha256'sı kaydıyla tutuyor" yazar. Yarım kalmış
     * yazımın artığı bu kümeye bakarak sınıflanır — hedef belge sonradan
     * sağlam geldiyse artık bir arıza değildir.
     */
    const saglamYollar = new Set<string>();
    /** Bu davada bulunan kayıtsız KAYNAK sayısı (türev ve yedek sayılmaz). */
    let yetimSayisi = 0;
    let kesildi = false;
    for (const e of kayitlar) {
      if (butceDoldu()) {
        kesildi = true;
        break;
      }
      satir.kayit++;
      sayilar.kayit++;
      const rel = typeof e?.path === "string" ? e.path : "";
      if (rel === "") {
        ekle({
          tur: "kayit-bozuk",
          eksen: "kayit",
          agirlik: "bulgu",
          yol: "(yolsuz kayıt)",
          aciklama:
            "Manifest satırında dosya yolu yok; bu kaydın kaynağı ölçülemedi ve sağlam sayılmadı.",
        });
        continue;
      }
      const mutlak = resolve(klasor, rel);
      bilinen.add(yolAnahtari(mutlak));
      const olcum = olc(mutlak);
      if (olcum.durum === "kapsamDisi") {
        ekle({
          tur: "kapsam-disi",
          eksen: "kaynak",
          agirlik: "bulgu",
          yol: rel,
          aciklama:
            "Kayıtlı yol dava klasörünün dışına çıkıyor; dosya hiç açılmadı ve içeriği rapora alınmadı.",
        });
      } else if (olcum.durum === "yok") {
        ekle({
          tur: "kaynak-yok",
          eksen: "kaynak",
          agirlik: "bulgu",
          yol: rel,
          aciklama: "Kaynak belge arşivde yok; kayıtlı yolda hiçbir şey duruyor değil.",
        });
      } else if (olcum.durum === "erisilemiyor") {
        ekle({
          tur: "kaynak-erisilemiyor",
          eksen: "kaynak",
          agirlik: "bulgu",
          yol: rel,
          aciklama:
            "Kaynak belge okunamadı (izin ya da bağlı olmayan bir disk olabilir); silinmiş olduğu anlamına gelmez.",
          ...(olcum.errno !== undefined ? { errno: olcum.errno } : {}),
        });
      } else if (olcum.tur !== "dosya") {
        ekle({
          tur: "kaynak-yok",
          eksen: "kaynak",
          agirlik: "bulgu",
          yol: rel,
          aciklama: "Kayıtlı yolda belge değil bir klasör duruyor.",
        });
      } else {
        await kaynagiOlc(e, rel, mutlak);
      }
      turevOlc(e);
    }

    async function kaynagiOlc(
      e: ManifestEvrak,
      rel: string,
      mutlak: string,
    ): Promise<void> {
      const beklenen = typeof e?.sha256 === "string" ? e.sha256.toLowerCase() : "";
      if (!HEX64.test(beklenen)) {
        ekle({
          tur: "kayit-bozuk",
          eksen: "kayit",
          agirlik: "bulgu",
          yol: rel,
          aciklama:
            "Belge yerinde ama manifest'te geçerli bir içerik özeti yok; değişip değişmediği ölçülemedi.",
        });
        return;
      }
      let boyut: number;
      try {
        boyut = statSync(mutlak).size;
      } catch (err) {
        ekle({
          tur: "kaynak-erisilemiyor",
          eksen: "kaynak",
          agirlik: "bulgu",
          yol: rel,
          aciklama: "Kaynak belgenin boyutu okunamadı; içerik özeti hesaplanamadı.",
          errno: errnoAl(err),
        });
        return;
      }
      if (boyut > sinirlar.dosyaTavani) {
        ekle({
          tur: "olculmedi-buyuk",
          eksen: "kaynak",
          agirlik: "bilgi",
          yol: rel,
          boyut,
          aciklama: `Bu belge denetimin dosya sınırından (${Math.round(sinirlar.dosyaTavani / (1024 * 1024))} MB) büyük; içerik özeti hesaplanmadı ve sağlam sayılmadı.`,
        });
        return;
      }
      // Kapsam denetimi HASH ALMADAN ÖNCE, İKİNCİ KEZ: ölçüm ile okuma
      // arasında yol symlink'e çevrilmiş olabilir. Arşivden dışarı bakan bir
      // bağlantı takip edilmez ve içeriği rapora girmez.
      if (!kapsamIcindeMi(klasor, mutlak)) {
        ekle({
          tur: "kapsam-disi",
          eksen: "kaynak",
          agirlik: "bulgu",
          yol: rel,
          aciklama:
            "Kayıtlı yol okuma anında dava klasörünün dışını gösteriyordu; dosya okunmadı.",
        });
        return;
      }
      let olculen: string;
      try {
        olculen = await akisHash(mutlak);
      } catch (err) {
        ekle({
          tur: "kaynak-erisilemiyor",
          eksen: "kaynak",
          agirlik: "bulgu",
          yol: rel,
          aciklama:
            "Kaynak belge okunamadı (izin ya da bağlı olmayan bir disk olabilir); silinmiş olduğu anlamına gelmez.",
          errno: errnoAl(err),
        });
        return;
      }
      sayilar.olculenBayt += boyut;
      if (olculen !== beklenen) {
        ekle({
          tur: "hash-uyusmuyor",
          eksen: "kaynak",
          agirlik: "bulgu",
          yol: rel,
          beklenen,
          olculen,
          boyut,
          aciklama:
            "Kaynak belge yerinde ama içeriği kayıtlı özetle uyuşmuyor; indirildiğinden bu yana değişmiş ya da bozulmuş.",
        });
        return;
      }
      satir.saglam++;
      sayilar.saglam++;
      saglamYollar.add(yolAnahtari(mutlak));
    }

    function turevOlc(e: ManifestEvrak): void {
      const md = typeof e?.mdPath === "string" ? e.mdPath : "";
      if (md === "") return;
      const mdMutlak = resolve(klasor, md);
      bilinen.add(yolAnahtari(mdMutlak));
      // Türev YALNIZ "ok" diyen kayıtta beklenir: `gorsel`, `arac-yok`,
      // `desteklenmiyor`, `bekliyor` kayıtlarında metin zaten üretilmemiştir,
      // yoksa "kırık türev" diye sahte bulgu doğardı.
      if (e?.mdStatus !== "ok") return;
      const olcum = olc(mdMutlak);
      if (olcum.durum === "kapsamDisi") {
        ekle({
          tur: "kapsam-disi",
          eksen: "turev",
          agirlik: "bulgu",
          yol: md,
          aciklama: "Metin türevinin yolu dava klasörünün dışına çıkıyor; okunmadı.",
        });
        return;
      }
      if (olcum.durum === "erisilemiyor") {
        ekle({
          tur: "turev-erisilemiyor",
          eksen: "turev",
          agirlik: "bulgu",
          yol: md,
          aciklama:
            "Bu evrakın hazır metni okunamadı (izin ya da bağlı olmayan bir disk olabilir).",
          ...(olcum.errno !== undefined ? { errno: olcum.errno } : {}),
        });
        return;
      }
      if (olcum.durum === "yok" || olcum.tur !== "dosya") {
        ekle({
          tur: "turev-yok",
          eksen: "turev",
          agirlik: "bulgu",
          yol: md,
          aciklama:
            "Kayıt hazır metin olduğunu söylüyor ama metin dosyası arşivde yok; kaynak belge etkilenmedi.",
        });
      }
    }

    // ── P19 — ŞİŞMİŞ GRUP ───────────────────────────────────────────────────
    // P06a bu arşiv için 0 bulgu diyordu: her dosya tek tek sağlamdı, satırlar
    // bayt bayt aynı değildi, yol çakışması yoktu — ama manifest 116 satır /
    // 113 gerçek belge ile duruyordu. Eksik ölçüt buydu: aynı grupta METNİ
    // BİREBİR AYNI birden çok kayıt.
    //
    // MALİYET SINIRLI: metin özeti YALNIZ 2+ kayıtlı grupların üyeleri için
    // alınır. Tekil kayıtlarda hiçbir ek okuma yapılmaz, yani sağlıklı bir
    // arşivde bu adımın maliyeti sıfırdır.
    if (!kesildi) {
      const ozetler = new Map<ManifestEvrak, string | null>();
      // Metin özeti YALNIZ zaten şüpheli kayıtlar için alınır: 2+ kayıtlı
      // grubun üyeleri ve (tür/tarih/gönderen/tip) altında yığılmış
      // gruplanamayan kayıtlar. Sağlıklı arşivde ikisi de boştur, maliyet
      // sıfır kalır.
      const olculemez = olculemezYiginlar(kayitlar);
      const adaylar = [...belirsizGrupKayitlari(kayitlar), ...[...olculemez.values()].flat()];
      for (const e of adaylar) {
        if (butceDoldu()) {
          kesildi = true;
          break;
        }
        if (!ozetler.has(e)) ozetler.set(e, await metinOzeti(e));
      }
      if (!kesildi) {
        for (const g of sismisGruplar(kayitlar, okuma.grupSayilari, ozetler)) {
          ekle({
            tur: "grup-sismis",
            eksen: "kayit",
            agirlik: "bulgu",
            yol: g.ornek.path,
            adet: g.manifest,
            aciklama:
              `Aynı evrak numarası, türü ve tarihi altında ${g.manifest} kayıt duruyor ve ` +
              `bunların ${g.yinelenen} tanesinin metni birebir aynı: aynı belge birden çok kez ` +
              "kaydedilmiş. Baytları farklı olduğu için mükerrer kayıt sayılmıyor — UYAP bu " +
              "belgeyi her indirişte yeniden üretiyor. " +
              (g.portal === null
                ? "Portalın bu grup için kaç satır bildirdiği bu arşivde kayıtlı değil, o yüzden " +
                  "kaçının fazla olduğu ölçülemiyor: bir kez eşitleyin (bu sürüm artık kayıt " +
                  "eklemez), sonra sadeleştirme fazlalığı tam sayısıyla düşürebilir."
                : `Portal bu grup için ${g.portal} satır bildiriyor; ${g.manifest - g.portal} ` +
                  "kayıt fazla. Yalnız bu grup için: tensip sadelestir --dava \"…\" --yol " +
                  "\"<yukarıdaki yol>\" --onayla (yol verilmezse davadaki BÜTÜN şişmiş " +
                  "gruplar sadeleşir; önce onaysız çalıştırıp neyin düşeceğini görün, " +
                  "belge dosyalarına dokunulmaz)."),
          });
        }

        // ── AYNI GRUPTA BAYT BAYT AYNI İKİ KAYIT ────────────────────────────
        // Yukarıdaki elek yalnız `manifest > portal` iken bakar. İncelemede
        // ölçülen hasar orada GÖRÜNMÜYORDU: grup büyürken satırlar sıraya göre
        // eşlenince portalın yeni belgesi hiç inmiyor, yerine kardeşinin
        // ikinci kopyası kaydediliyordu; kayıt sayısı portalınkine EŞİT
        // kaldığı için denetim "sağlam" diyordu. Ölçüt sha256'dır — soru
        // "aynı belge mi" değil, "AYNI İNDİRMENİN iki kopyası mı".
        for (const g of ikizKayitlar(kayitlar, okuma.grupSayilari)) {
          const adet = g.kopyalar.length;
          ekle({
            tur: "grup-ikiz",
            eksen: "kayit",
            agirlik: "bulgu",
            yol: g.kopyalar[0]!.path,
            adet,
            aciklama:
              `Aynı evrak numarası, türü ve tarihi altındaki ${adet} kayıt BİREBİR AYNI baytları ` +
              "taşıyor ama ayrı dosyalarda duruyor: aynı indirme iki kez kaydedilmiş. " +
              "Mükerrer kayıt değildir (orada tek dosyayı gösteren iki satır olur) ve şişme de " +
              "değildir — UYAP belgeyi her indirişte yeniden ürettiği için iki AYRI belgenin " +
              "baytı böyle denk gelmez. " +
              (g.portal !== null && g.portal >= adet
                ? `Portal bu grup için ${g.portal} satır bildiriyor; kopyalar bir satırı ` +
                  "doldurduğuna göre grubun BAŞKA bir belgesi arşivde eksik olabilir. Bu sürümle " +
                  "yeniden eşitleyin: belirsiz grubun bütün satırları yeniden indirilir."
                : "Portalın bu grup için kaç satır bildirdiği bu arşivde kayıtlı değil; bir kez " +
                  "eşitleyin, sayı yazılsın."),
          });
        }

        // ── GRUPLANAMAYAN KAYITLARDA SESSİZ BİRİKME ─────────────────────────
        // ROADMAP T13: numarasız ana evrak gruplanmaz, çünkü orada "kaç tane
        // olmalı" ölçülemez. Bedeli ölçüldü — böyle bir satır her eşitlemede
        // yeniden inip yeni kayıt oluyor ve yukarıdaki eleklerin HİÇBİRİ bunu
        // göremiyor. Kimlik burada da TAHMİN EDİLMEZ; ağırlık `bilgi`dir ve
        // sadeleştirme bu kayıtlara ASLA dokunmaz.
        for (const y of olculemezSisme(kayitlar, ozetler)) {
          ekle({
            tur: "grup-olculemez",
            eksen: "kayit",
            agirlik: "bilgi",
            yol: y.ornek.path,
            adet: y.yinelenen,
            aciklama:
              `Evrak numarası olmayan ${y.toplam} kayıt aynı tür, tarih ve gönderen altında ` +
              `duruyor ve bunların ${y.yinelenen} tanesinin metni birebir aynı. ARIZA OLMAYABİLİR, ` +
              "ama numarasız evrakta portalın kaç satır bildirdiği ölçülemediği için eşitleme " +
              "böyle bir satırı her turda yeniden indirip yeni kayıt olarak ekler. Sadeleştirme " +
              "bunlara DOKUNMAZ: iki farklı belgeyi karıştırma riski alınmıyor. Kayıt sayısı " +
              "turdan tura artıyorsa fazlalıkları el ile ayıklayın.",
          });
        }
      }
    }

    /**
     * Bir kaydın METİN özeti. `null` = ölçülemedi; o kayıt hiçbir aynılık
     * kümesine giremez. Görsel (taranmış) evrakta metin katmanı yoktur ve
     * ORASI BİLEREK ÖLÇÜLMEZ: ölçülemeyen şey fazlalık ilan edilmez.
     */
    async function metinOzeti(e: ManifestEvrak): Promise<string | null> {
      const md = typeof e?.mdPath === "string" ? e.mdPath : "";
      if (md === "" || e?.mdStatus !== "ok") return null;
      const mutlak = resolve(klasor, md);
      const olcum = olc(mutlak);
      if (olcum.durum !== "var" || olcum.tur !== "dosya") return null;
      if (!kapsamIcindeMi(klasor, mutlak)) return null;
      try {
        if (statSync(mutlak).size > sinirlar.dosyaTavani) return null;
        return await akisHash(mutlak);
      } catch {
        return null;
      }
    }

    if (kesildi) {
      satir.durum = "kismi";
      satir.not = "Denetim bütçesi doldu; bu dosyanın kayıtları tamamlanmadan kesildi.";
      continue;
    }

    // ── yetim dosya taraması ────────────────────────────────────────────────
    const yuruyusTam = yuru(klasor, klasor, 0);
    if (!yuruyusTam) {
      satir.durum = "kismi";
      satir.not = satir.not ?? "Klasör taraması tamamlanamadı.";
    }

    // ── kaydı boşalmış dava: `kayitsiz-klasor`un AYNASI ─────────────────────
    // Klasörü registry'de olmayan bir dava KIRMIZI bulgudur ("belgeleri
    // arşivde ama ekranda görünmüyor"). Klasörü kayıtlı ama manifest'i HİÇ
    // evrak bildirmeyen bir dava kullanıcı için AYNI sonucu doğurur: sol
    // listede "0 evrak" görünür, belgeler diskte durur. Tek tek yetim satırı
    // `bilgi`dir (korunmuş eski bir kaynak olabilir), ama HİÇ kaydı olmayan
    // bir davanın klasöründe kaynak durması bir tutarsızlıktır — bunu `bilgi`
    // bırakmak özetin "Bulgu yok" demesine yol açardı. Kayıt varken duran
    // kayıtsız kaynak bu bulguyu DOĞURMAZ; orada yetim gerçekten çöp değildir.
    if (satir.kayit === 0 && yetimSayisi > 0) {
      ekle({
        tur: "kayitlar-eksik",
        eksen: "kayit",
        agirlik: "bulgu",
        // `adet` KOYULMAZ: o rozet "N kayıt" yazar (mükerrer kayıt için
        // doğru), burada sayı kayıt değil kayıtsız DOSYA sayısıdır.
        yol: MANIFEST_ADI,
        aciklama: `Bu dosyanın kaydında hiç evrak yok ama klasöründe kayıtsız ${yetimSayisi} belge duruyor; belgeler arşivde ama uygulamanın listesinde görünmüyor.`,
      });
    }

    /** Klasörü gezer; tamamlandıysa true. Symlink TAKİP ETMEZ. */
    function yuru(dizin: string, kokKlasor: string, derinlik: number): boolean {
      if (butceDoldu()) return false;
      let girdiler;
      try {
        girdiler = readdirSync(dizin, { withFileTypes: true });
      } catch (err) {
        ekle({
          tur: "klasor-erisilemiyor",
          eksen: "klasor",
          agirlik: "bulgu",
          yol: relative(kokKlasor, dizin) || ".",
          aciklama: "Bu klasör okunamadı; içindeki dosyalar denetlenmedi.",
          errno: errnoAl(err),
        });
        return true;
      }
      let tam = true;
      for (const g of girdiler) {
        girdiSayaci++;
        if (butceDoldu()) return false;
        // Gizli dosyalar (.DS_Store gibi) taranmaz: evrak değildir ve "yetim"
        // listesini gürültüyle doldururlardı. TEK İSTİSNA atomik yazımın
        // artığıdır (P06c) — o bir çöp değil, YARIDA KALMIŞ BİR YAZIMIN
        // kanıtıdır ve sessizce atlanması denetimin kesinti sonrası "bulgu
        // yok" demesine yol açıyordu (ölçüldü).
        if (g.name.startsWith(".")) {
          const hedefAd = g.isFile() ? yarimYazimHedefi(g.name) : null;
          if (hedefAd === null) {
            sayilar.atlanan++;
            continue;
          }
          sayilar.yarim++;
          // HEDEF SONRADAN SAĞLAM GELDİ Mİ? İncelemede ölçüldü: kullanıcı
          // "Devam et"e basıp işi tamamladıktan sonra hedef belge yerinde ve
          // özetiyle birebirdi, ama satır hâlâ `bulgu` olarak duruyor ve
          // "yeniden eşitleyin" diyordu — kullanıcı o eşitlemeyi zaten
          // yapmıştı. Düğme de yok (bilerek), yani bulgu uygulama içinden
          // ASLA kapanamıyordu ve sağlıklı arşiv kalıcı olarak "1 bulgu"
          // okunuyordu. Ölçüt aynı taramada zaten elimizde: hedef, kaydının
          // sha256'sıyla birebir doğrulandıysa kesinti kapanmıştır.
          //
          // KAPSAM DAR TUTULDU: yalnız sha256'sı ÖLÇÜLMÜŞ kayıtlar bu kümede
          // olur. `.md` türevinin manifest'te özeti yoktur, dosya tavanını
          // aşan belge de ölçülmez (`olculmedi-buyuk`); ikisinde de "hedef
          // sağlam" cümlesi kurulamaz ve satır `bulgu` kalır. Doğrulanmamış
          // bir şeye "sağlam" demek, bu paketin kapattığı kusurun aynısı olurdu.
          const hedefSaglam = saglamYollar.has(yolAnahtari(join(dizin, hedefAd)));
          ekle({
            tur: hedefSaglam ? "yarim-yazim-artigi" : "yarim-yazim",
            eksen: "yarim",
            agirlik: hedefSaglam ? "bilgi" : "bulgu",
            yol: relative(kokKlasor, join(dizin, g.name)),
            aciklama: hedefSaglam
              ? `Bir yazım kesilmiş ama hedefi sonradan tamamlanmış: "${hedefAd}" arşivde ` +
                "duruyor ve kayıtlı içerik özetiyle birebir. Bu dosya o yazım sırasında açılan " +
                "geçici dosyadır, belge DEĞİLDİR ve artık gereksizdir — yeniden eşitlemeye " +
                "gerek yok, isterseniz elle silebilirsiniz. Denetim hiçbir şeyi silmez."
              : `Bir yazım tamamlanmadan kesilmiş: bu dosya "${hedefAd}" yazılırken açılan geçici ` +
                "dosyadır, belge DEĞİLDİR ve hiçbir kayıt onu göstermez. Hedef dosya eski hâlinde " +
                "kalmış ya da hiç yazılmamış olabilir; ilgili dosyayı yeniden eşitleyin. Denetim " +
                "hiçbir şeyi silmez.",
          });
          continue;
        }
        const tamYol = join(dizin, g.name);
        const rel = relative(kokKlasor, tamYol);
        if (g.isSymbolicLink()) {
          // Bağlantı ÇÖZÜLÜR ama TAKİP EDİLMEZ: kök dışına bakan bağlantının
          // içeriği rapora sızmaz, kök içindeki bağlantıya da inilmez (döngü).
          const o = olc(tamYol);
          if (o.durum === "kapsamDisi") {
            ekle({
              tur: "kapsam-disi",
              eksen: "yetim",
              agirlik: "bulgu",
              yol: rel,
              aciklama:
                "Bu bağlantı arşivin dışını gösteriyor; hedefi okunmadı ve içeriği rapora alınmadı.",
            });
            continue;
          }
          if (o.durum === "var" && o.tur === "dosya") yetimBak(rel, tamYol);
          continue;
        }
        if (g.isDirectory()) {
          if (derinlik + 1 > sinirlar.derinlikTavani) {
            kismiEkle("Bazı klasörler derinlik sınırının altında kaldı.");
            tam = false;
            continue;
          }
          if (!yuru(tamYol, kokKlasor, derinlik + 1)) tam = false;
          continue;
        }
        if (!g.isFile()) continue;
        yetimBak(rel, tamYol);
      }
      return tam;
    }

    function yetimBak(rel: string, tamYol: string): void {
      sayilar.dosya++;
      if (rel === MANIFEST_ADI) return;
      // İndirme/sadeleştirme yedeği YETİM DEĞİLDİR: orkestratör manifest'i
      // sadeleştirmeden önce bilerek kopyalar.
      if (MANIFEST_YEDEK.test(rel)) {
        sayilar.yedek++;
        return;
      }
      // Metin türevi YETİM DEĞİLDİR: manifest'ten düşmüş bir .md kullanıcının
      // belgeye kalan erişimi olabilir; ayrı sınıftır, çöp değildir.
      if (rel.toLowerCase().endsWith(".md")) {
        sayilar.turev++;
        return;
      }
      if (bilinen.has(yolAnahtari(tamYol))) return;
      sayilar.yetim++;
      yetimSayisi++;
      ekle({
        tur: "yetim-dosya",
        eksen: "yetim",
        agirlik: "bilgi",
        yol: rel,
        aciklama:
          "Bu dosya arşivde duruyor ama manifest'te kaydı yok. ÇÖP DEĞİLDİR — korunmuş eski bir kaynak olabilir; denetim hiçbir şeye dokunmaz.",
      });
    }

    // İş DENETİM SIRASINDA başlamış olabilir: sonucu geçerli saymadan önce
    // yeniden ölçülür (ROADMAP §4: "değiştiği doğrulanıp sonuç geçersiz sayılır").
    if (mesgul(kayit.caseKey)) {
      satir.durum = "atlandi-mesgul";
      satir.not =
        "Denetim sırasında bu dosya için eşitleme başladı; sonucu güvenilir değil.";
      kismiEkle("Denetim sırasında başlayan eşitleme bir dosyanın sonucunu geçersiz kıldı.");
      continue;
    }
    if (satir.durum === "denetlendi") sayilar.denetlenen++;
  }

  // ── arşivde kayıtsız dava klasörü var mı? ─────────────────────────────────
  // Yalnız tüm arşiv denetiminde. "Registry'de kayıtlı ama klasörü yok"
  // (`klasor-yok`) ile "klasör var ama registry'de yok" AYRI bulgulardır:
  // ikincisinde belgeler diskte durur ama uygulama onları hiç göstermez.
  if (tumArsiv && !butceDoldu()) kayitsizKlasorleriBul();

  function kayitsizKlasorleriBul(): void {
    const kayitli = new Set<string>();
    for (const d of girdi.davalar) {
      if (d.klonYolu === undefined) continue;
      kayitli.add(yolAnahtari(resolve(d.klonYolu)));
      try {
        kayitli.add(yolAnahtari(realpathSync(d.klonYolu)));
      } catch {
        /* çözülemeyen kayıt zaten klasor-yok/erisilemiyor olarak bildirildi */
      }
    }
    const kesfet = (dizin: string, derinlik: number): void => {
      if (derinlik > sinirlar.kesifDerinligi || butceDoldu()) return;
      let girdiler;
      try {
        girdiler = readdirSync(dizin, { withFileTypes: true });
      } catch {
        return;
      }
      girdiSayaci += girdiler.length;
      if (girdiler.some((g) => g.name === MANIFEST_ADI && g.isFile())) {
        if (!kayitli.has(yolAnahtari(resolve(dizin)))) {
          bulgular.push({
            tur: "kayitsiz-klasor",
            eksen: "klasor",
            agirlik: "bulgu",
            onarim: onarimBilgisi("kayitsiz-klasor"),
            caseKey: "",
            dava: "(kayıtsız klasör)",
            yol: relative(girdi.kok, dizin) || ".",
            aciklama:
              "Bu klasörde bir dava kaydı duruyor ama dosya uygulamanın listesinde yok; belgeleri arşivde ama ekranda görünmüyor.",
          });
          sayilar.bulgu++;
        }
        return;
      }
      for (const g of girdiler) {
        if (!g.isDirectory() || g.isSymbolicLink() || g.name.startsWith(".")) continue;
        if (g.name === "_kaynak" || g.name === "evraklar") continue;
        kesfet(join(dizin, g.name), derinlik + 1);
      }
    };
    const kokOlcum = kaynakOlcer(girdi.kok)(girdi.kok);
    if (kokOlcum.durum === "var" && kokOlcum.tur === "dizin") kesfet(girdi.kok, 0);
  }

  const eksik = davaSatirlari.some((d) => d.durum !== "denetlendi");
  if (eksik) kismiEkle("Kapsamdaki bütün dosyalar denetlenemedi.");
  const tamamlandi = kismiSebepleri.length === 0;
  return {
    at: new Date().toISOString(),
    sureMs: Math.max(0, simdi() - baslangic),
    tamamlandi,
    ...(tamamlandi ? {} : { kismiSebep: kismiSebepleri.join(" ") }),
    kapsam: { caseKey: tumArsiv ? null : (girdi.caseKey ?? null), tumArsiv },
    sinirlar,
    sayilar,
    davalar: davaSatirlari,
    bulgular,
  };
}

/** Mükerrer kayıt ve yol çakışması — ikisi de RAPORLANIR, hiçbiri birleştirilmez. */
function tekrarlariBildir(
  kayitlar: readonly ManifestEvrak[],
  ekle: (b: Omit<Bulgu, "caseKey" | "dava" | "onarim">) => void,
): void {
  const gruplar = new Map<string, ManifestEvrak[]>();
  for (const e of kayitlar) {
    if (!e || typeof e !== "object") continue;
    const a = tekrarAnahtari(e);
    const g = gruplar.get(a) ?? [];
    g.push(e);
    gruplar.set(a, g);
  }
  const mukerrerYollar = new Set<string>();
  for (const grup of gruplar.values()) {
    if (grup.length < 2) continue;
    const yol = typeof grup[0]?.path === "string" ? grup[0]!.path : "(yolsuz kayıt)";
    mukerrerYollar.add(yolAnahtari(yol));
    // AGIRLIK "bilgi", "bulgu" DEĞİL — incelemede ölçüldü: bu durum ÜRÜNÜN
    // KENDİ KURALIYLA oluşuyor. `tekrar.ts` (ayniKaynakTekillestir) portal iki
    // kimliği de hâlâ döndürüyorsa kaydı bilerek DARALTMIYOR; yani sağlıklı,
    // tekilleştirmeden geçmiş bir manifest bu satırı üretir. Kırmızı bulgu
    // sayılsaydı denetim kullanıcıya kendi doğru davranışını arıza diye
    // gösterir, sekme sayacını da boş yere yakardı. GERÇEK çelişki bu değil,
    // aşağıdaki `yol-cakismasi`dır ve o "bulgu" olarak kalır.
    ekle({
      tur: "mukerrer-kayit",
      eksen: "kayit",
      agirlik: "bilgi",
      yol,
      adet: grup.length,
      aciklama: `Aynı belge manifest'te ${grup.length} ayrı kayıtla duruyor: portal kimlikleri farklı, geri kalan bütün alanlar aynı. ARIZA DEĞİLDİR — portal iki kimliği de döndürdüğü sürece ikisi de saklanır. Denetim BİRLEŞTİRMEZ, yalnız bildirir.`,
    });
  }
  // Aynı dosyayı gösteren ama içeriği/alanları FARKLI iki kayıt: yukarıdaki
  // mükerrerlikten başka bir şeydir ve karıştırılmamalıdır — biri fazladan
  // kayıt, bu ise çelişen kayıt.
  const yolGruplari = new Map<string, ManifestEvrak[]>();
  for (const e of kayitlar) {
    const p = typeof e?.path === "string" && e.path !== "" ? e.path : null;
    if (p === null) continue;
    const a = yolAnahtari(p);
    const g = yolGruplari.get(a) ?? [];
    g.push(e);
    yolGruplari.set(a, g);
  }
  for (const [anahtar, grup] of yolGruplari) {
    if (grup.length < 2 || mukerrerYollar.has(anahtar)) continue;
    ekle({
      tur: "yol-cakismasi",
      eksen: "kayit",
      agirlik: "bulgu",
      yol: grup[0]!.path,
      adet: grup.length,
      aciklama: `${grup.length} ayrı kayıt aynı dosyayı gösteriyor ama kayıtların içeriği farklı; en az biri yanlış dosyaya bakıyor.`,
    });
  }
}
