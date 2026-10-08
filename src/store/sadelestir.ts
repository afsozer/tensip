// P19b — BİRİKMİŞ ŞİŞKİNLİĞİ TEMİZLE. Kullanıcı onayıyla, yedekle, geri
// dönülebilir.
//
// P19a eşitlemenin şişmesini DURDURUR; eldeki fazlalığı temizlemez.
// Kullanıcının dosyası 116 satır / 113 gerçek belge ile kaldı. Bu modül o
// fazlalığı ÖNERİR ve ancak açık onayla uygular.
//
// ── ÜÇ MUTLAK KURAL ────────────────────────────────────────────────────────
// 1. ONAYSIZ ÇALIŞMAZ. `onay` verilmeden çağrıldığında tek bayt değişmez;
//    yalnız plan döner. Sessizce "toparlayan" bir temizlik, kullanıcının
//    göremediği bir veri kaybı riskidir.
// 2. BELGE DOSYASINA DOKUNULMAZ. Yalnız MANİFEST SATIRI düşer; `_kaynak`
//    altındaki dosya olduğu yerde kalır ve denetimde "kayıtsız dosya"
//    (bilgi, arıza değil) olarak görünür. Böylece "hiçbir gerçek belge
//    kaybolmaz" ölçülebilir bir cümle olur: temizlikten önce ve sonra
//    arşivdeki dosya sayısı ve parmak izi AYNIDIR.
// 3. YEDEKSİZ YAZILMAZ. Manifest önce `uyap-project.yedek-<zaman>.json`
//    olarak kopyalanır (orkestratörün tekilleştirme yedeğiyle AYNI kalıp;
//    denetim bu adı yetim saymaz — `MANIFEST_YEDEK` deseni).
//
// Metni olmayan (`gorsel`) belgede otomatik temizlik YAPILMAZ: orada aynılık
// ölçülemez (bkz. src/store/sisme.ts).
//
// ── 4. KURAL (P06b incelemesi, 13 Eylül) — KAPSAM ÇAĞIRANIN SÖZÜDÜR ────────
// Denetim satırındaki "Fazlalığı sadeleştir" düğmesi TEK satırın sözünü
// verir; bu modül `yol` verildiğinde YALNIZ o yolun grubunu sadeleştirir.
// Ölçülmüştü: filtre yokken iki şişmiş gruplu bir davada tek satırın onayı
// 6 kaydı 2'ye indiriyor, kullanıcının seçmediği grubun kayıtları da
// düşüyordu (kabul ölçütü 2'nin ihlali). Evraklar ekranının dava geneli
// düğmesi `yol` GÖNDERMEZ ve davranışı değişmedi.

import { statSync } from "node:fs";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { join, resolve } from "node:path";
import { kapsamIcindeMi, kapsamKontrol, kaynakOlcer } from "./fsops.js";
import {
  MANIFEST_ADI,
  ManifestDepo,
  manifestiYedekle,
  yolaGoreTekKayit,
  type ManifestEvrak,
} from "./manifest.js";
import { kayitAnahtari } from "./eslestir.js";
import { belirsizGrupKayitlari, sismisGruplar } from "./sisme.js";

/**
 * Sadeleştirmenin KAPSAMI.
 *
 * `yol` verilmezse dava genelidir (Evraklar ekranındaki düğme). Verilirse
 * YALNIZ o yolun ait olduğu grup sadeleşir: denetim satırındaki düğme tek
 * satırın sözünü verir ve o sözü tutmak zorundadır (P06b kabul ölçütü 2).
 */
export interface SadelestirmeSecenekleri {
  /** Dava klasörüne göreli kaynak ya da türev yolu; grup bundan çözülür. */
  yol?: string;
}

/** Tek bir şişmiş grubun planı. Yollar dava klasörüne GÖRELİDİR. */
export interface SadelestirmeGrubu {
  /** Manifestte bu grupta duran kayıt sayısı. */
  manifest: number;
  /** Portalın son listelemede bildirdiği satır; bilinmiyorsa null. */
  portal: number | null;
  /** Metni birebir aynı kayıt sayısı. */
  yinelenen: number;
  /** Grubu temsil eden kaydın yolu (kalacak kayıtlardan biri). */
  ornek: string;
  /** Manifestten düşecek kayıtların yolları. Dosyaları SİLİNMEZ. */
  dusen: string[];
  /** Portal sayısı bilinmediği için dokunulmadıysa sebep. */
  not?: string;
}

export interface SadelestirmePlani {
  /** Plan çıkarıldığı andaki kayıt sayısı. */
  once: number;
  /** Plan uygulanırsa kalacak kayıt sayısı. */
  sonra: number;
  gruplar: SadelestirmeGrubu[];
  /** Uygulandı mı? Onaysız çağrıda `false` ve arşiv değişmemiştir. */
  uygulandi: boolean;
  /** Uygulandıysa manifest yedeğinin dosya adı. */
  yedek?: string;
  /**
   * Metni ölçülemediği için hiçbir kümeye alınmayan kayıt sayısı (görsel
   * evrak, türevi üretilmemiş ya da okunamayan kayıt). Kullanıcı "neden hepsi
   * gitmedi" diye sormasın diye sayı görünür.
   */
  olculemeyen: number;
  /**
   * Portal sayısı bilinmediği için dokunulmayan grup sayısı. Sıfırdan
   * büyükse kullanıcıya "bir kez eşitleyin" denir; eşitleme artık kayıt
   * eklemiyor (P19a).
   */
  olcusuzGrup: number;
  /**
   * Tek grup istendi ve o grup ölçülemedi/şişkin değil: NEDEN hiçbir şey
   * yapılmadığı. Boş plan ile "yapacak iş yok" cümlesi karışmasın diye ayrı
   * alandır; dolu olduğunda plan HER ZAMAN boştur.
   */
  not?: string;
  /** Yalnız bu grup hedeflendiyse hedefin yolu; dava geneli çağrıda yok. */
  hedefYol?: string;
}

/**
 * Fazlalık planını çıkarır; `onay` true ise uygular.
 *
 * Uygulama sırası bilerek şudur: önce yedek (COPYFILE_EXCL ile — var olan bir
 * yedeğin üstüne YAZILMAZ), sonra manifest. Süreç arada ölürse diskte ya eski
 * manifest ya eski manifest + yedeği bulunur; asla yedeksiz yeni manifest
 * bulunmaz.
 */
export async function sadelestir(
  kok: string,
  klasor: string,
  onay: boolean,
  secenekler: SadelestirmeSecenekleri = {},
): Promise<SadelestirmePlani> {
  kapsamKontrol(kok, klasor);
  const manifestYolu = join(klasor, MANIFEST_ADI);
  const depo = new ManifestDepo(manifestYolu);
  const manifest = depo.oku();
  if (manifest === null) {
    throw new Error("Dosya kaydı (manifest) okunamadı; sadeleştirme yapılmadı.");
  }
  const kayitlar = manifest.evraklar;
  const hedefYol = typeof secenekler.yol === "string" ? secenekler.yol : "";
  // ── TEK SATIR İSTENDİYSE KAPSAM O GRUPTUR ─────────────────────────────────
  // Denetim satırındaki düğme YALNIZ o satırı onarır (P06b kabul ölçütü 2).
  // Hedef kayıt tekil olarak bulunamıyorsa dava geneline GENİŞLEMEZ: boş plan
  // döner ve sebebi yazılır. Genişlemek, kullanıcının seçmediği grupların
  // kayıtlarını düşürmek olurdu (ÖLÇÜLDÜ, 13 Eylül: iki şişmiş gruplu davada
  // tek satırın onayı 6 kaydı 2'ye indiriyordu).
  let hedefGrup: string | null = null;
  if (hedefYol !== "") {
    const kayit = yolaGoreTekKayit(kayitlar, hedefYol);
    hedefGrup = kayit === null ? null : kayitAnahtari(kayit).grup;
    if (hedefGrup === null) {
      return {
        once: kayitlar.length,
        sonra: kayitlar.length,
        gruplar: [],
        uygulandi: false,
        olculemeyen: 0,
        olcusuzGrup: 0,
        hedefYol,
        not:
          kayit === null
            ? "Bu yolu gösteren tek bir kayıt bulunamadı; rapor alındıktan sonra kayıt değişmiş olabilir. Hiçbir satır düşürülmedi."
            : "Bu kaydın evrak numarası yok, yani hangi grubun kaç satır olması gerektiği ölçülemiyor. Hiçbir satır düşürülmedi.",
      };
    }
  }
  const olc = kaynakOlcer(klasor);
  const ozetler = new Map<ManifestEvrak, string | null>();
  let olculemeyen = 0;
  for (const e of belirsizGrupKayitlari(kayitlar)) {
    // Hedef grup dışındaki kayıtların metni OKUNMAZ: tek satırlık onarım
    // davanın tamamını taramaz (ve tek bayt da değiştirmez).
    if (hedefGrup !== null && kayitAnahtari(e).grup !== hedefGrup) continue;
    const ozet = await metinOzeti(klasor, e, olc);
    ozetler.set(e, ozet);
    if (ozet === null) olculemeyen++;
  }
  const gruplar = sismisGruplar(kayitlar, manifest.grupSayilari, ozetler).filter(
    (g) => hedefGrup === null || g.grup === hedefGrup,
  );
  const dusecek = new Set<ManifestEvrak>();
  for (const g of gruplar) for (const k of g.dusurulebilir) dusecek.add(k);
  const plan: SadelestirmePlani = {
    once: kayitlar.length,
    sonra: kayitlar.length - dusecek.size,
    gruplar: gruplar.map((g) => ({
      manifest: g.manifest,
      portal: g.portal,
      yinelenen: g.yinelenen,
      ornek: g.ornek.path,
      dusen: g.dusurulebilir.map((k) => k.path),
      ...(g.portal === null
        ? {
            not:
              "Portalın bu grup için kaç satır bildirdiği bu arşivde kayıtlı değil; " +
              "kaçının fazla olduğu ölçülemediği için hiçbir kayıt düşürülmedi. " +
              "Bir kez eşitleyin (bu sürüm artık kayıt eklemez), sonra tekrar deneyin.",
          }
        : {}),
    })),
    uygulandi: false,
    olculemeyen,
    olcusuzGrup: gruplar.filter((g) => g.portal === null).length,
    ...(hedefYol !== "" ? { hedefYol } : {}),
    ...(hedefGrup !== null && gruplar.length === 0
      ? {
          not:
            "Bu satırın grubunda şu anda düşürülebilecek fazla kayıt ölçülmedi; " +
            "rapor alındıktan sonra kayıtlar değişmiş olabilir. Hiçbir satır düşürülmedi.",
        }
      : {}),
  };
  if (!onay || dusecek.size === 0) return plan;

  // Yedek kalıbı TEK yerde (src/store/manifest.ts): onarım ve orkestratör de
  // aynı adı kullanır, denetim bu deseni yetim saymaz. Kapsam denetimi
  // TEMSİLİ bir ad üzerinden değil, gerçekten yazılacak klasörün manifest
  // yolu üzerinden yapılır (P06c: yedek adı artık sonek alabiliyor, uydurma
  // ad hem yanıltıcıydı hem de "ad tek yerde" kuralını deliyordu).
  kapsamKontrol(kok, join(klasor, MANIFEST_ADI));
  const yedekAdi = manifestiYedekle(klasor);

  manifest.evraklar = kayitlar.filter((e) => !dusecek.has(e));
  depo.yaz(manifest);
  plan.uygulandi = true;
  plan.yedek = yedekAdi;
  return plan;
}

/** Metin türevinin akış özeti; ölçülemiyorsa null (bkz. src/store/sisme.ts). */
async function metinOzeti(
  klasor: string,
  e: ManifestEvrak,
  olc: ReturnType<typeof kaynakOlcer>,
): Promise<string | null> {
  const md = typeof e?.mdPath === "string" ? e.mdPath : "";
  if (md === "" || e?.mdStatus !== "ok") return null;
  const mutlak = resolve(klasor, md);
  const olcum = olc(mutlak);
  if (olcum.durum !== "var" || olcum.tur !== "dosya") return null;
  if (!kapsamIcindeMi(klasor, mutlak)) return null;
  try {
    if (statSync(mutlak).size > 256 * 1024 * 1024) return null;
    const ozet = createHash("sha256");
    await pipeline(createReadStream(mutlak, { highWaterMark: 1024 * 1024 }), ozet);
    return ozet.digest("hex");
  } catch {
    return null;
  }
}
