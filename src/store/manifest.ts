// uyap-project.json — dava manifest'i.
// Şema: evrakId (opak token), stableKey, path, sha256,
// category, tur, tip, gonderen, tarih, birimEvrakNo, mdStatus, mdPath.
// Bizim ilaveler: boyut, yukleme, mdHata.

import { copyFileSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { kapsamIcindeMi, randHex, yazJsonAtomik } from "./fsops.js";
import { LEGACY_BIRLESIK, type MdDurum } from "./hazirlik.js";
import type { AcikEsitleme, IndirmeDamgasi, SonEsitleme } from "./esitleme.js";

export interface ManifestEvrak {
  evrakId: string;
  stableKey: string;
  path: string; // _kaynak/evraklar/... (dava klasörüne göre)
  sha256: string;
  isEkEvrak: boolean;
  category: string; // "02-Dilekceler"
  yon: "Gelen" | "Giden" | "Dosya";
  tur: string;
  tip?: string;
  gonderen: string;
  tarih: string;
  birimEvrakNo?: string;
  anaEvrakId?: string;
  anaStableKey?: string;
  dosyaKey: string;
  // YAZILAN küme MdDurum'dur (ok | gorsel | desteklenmiyor | arac-yok | hata |
  // bekliyor) ve yalnız src/convert/run.ts yazar. `unsupported` ESKİ birleşik
  // değerdir: diskte duran kayıtlarda hâlâ bulunur, OKUNUR, ama bu sürümle bir
  // daha YAZILMAZ. Gösterilecek değer okuma anında hazirlikCoz() ile türetilir.
  mdStatus: MdDurum | typeof LEGACY_BIRLESIK;
  mdPath?: string;
  mdHata?: string;
  boyut?: number;
  // P15b — "hangi eşitlemede indi?". YALNIZ gerçekten portalden inen evraka
  // yazılır (orchestrator: `yeniIndirildi`); hash doğrulamasıyla korunan evrak
  // damga ALMAZ, eskisini aynen taşır. Eski kayıtlarda yoktur ve toplu göç
  // YAPILMAZ — damgasız evrak rozetsiz görünür, "eski" diye işaretlenmez.
  // Türetme ve gerekçeler: src/store/esitleme.ts.
  indirmeDamgasi?: IndirmeDamgasi;
  /**
   * P20 (inceleme) — bu kaydın belgesi, BELİRSİZ GRUPTA TANINAMAYAN içerik
   * için AÇILMIŞ yedek kopya mı? Yalnız orkestratör yazar (`evrakIndir`),
   * yalnız `src/store/tazeleme.ts` `kurban` okur.
   *
   * NEDEN VAR: metni ölçülemeyen (taranmış) evrak yeniden indirildiğinde bir
   * daha tanınamaz — metni yok, baytı her indirişte değişiyor. Grupta portalın
   * artık bildirmediği FAZLA kayıt varken bu satır hiçbir gerçek belgeyi
   * ezemez; yeni bir yol açar. O yol işaretlenmezse bir sonraki eşitleme yine
   * yeni yol açar ve arşiv sınırsız şişer (ölçüldü). İşaretli kayıt, aynı
   * mekanizmanın kendi yazdığı kopyadır: onu yeniden kullanmak hiçbir belgeyi
   * yok etmez ve şişmeyi BİRDE durdurur.
   *
   * Eski manifestlerde YOKTUR ve toplu göç YAPILMAZ: alansız kayıt "gerçek
   * belge" sayılır, yani korunur. Yanlış tarafa düşmek kaybettirmez.
   */
  belirsizKopya?: boolean;
}

export interface Manifest {
  dosyaId: string;
  mahkeme: string;
  birimId: string;
  esasNo: string;
  caseType?: string;
  indirenAvukat?: string;
  isIcra: boolean;
  clonedAt: string;
  lastSyncedAt?: string;
  // ÖLÜ ALAN: depo genelinde ölçüldü — hiçbir yerde yazılmıyor ve okunmuyor.
  // Tipten çıkarılmadı (eski dosyalarda kalan değer okunup yok sayılır).
  // P15b'nin sayacı bu değil, `sonEsitleme.yeni`dir.
  yeniEvrakSayisi?: number;
  // P15b — son TAMAMLANAN eşitlemenin işaretçisi. Yalnız orkestratörün commit
  // noktasında (`lastSyncedAt` ile aynı yazımda) yazılır; duraklatılan/iptal
  // edilen denemede yazılmaz, bu yüzden kısmi indirme rozet tetiklemez.
  sonEsitleme?: SonEsitleme;
  // P15b — damga atmış ama commit etmemiş deneme. Sıradaki deneme bu kimliği
  // DEVRALIR (bkz. esitleme.ts KARAR 3); commit anında silinir.
  acikEsitleme?: AcikEsitleme;
  /**
   * P19 — PORTALIN BU GRUP İÇİN KAÇ SATIR BİLDİRDİĞİ. Anahtar
   * `src/store/eslestir.ts` `kayitAnahtari().grup`; değer son listelemede
   * sayılan portal satırı.
   *
   * NEDEN GEREKLİ: "aynı grupta metni aynı iki kayıt" tek başına fazlalık
   * KANITI DEĞİLDİR — portal aynı şablonu iki ayrı satır olarak bildiriyor
   * olabilir (gerçek arşivde ölçüldü: 5981 grubunda portal 2 satır bildiriyor,
   * manifestte 5 kayıt birikmişti). Bu sayı olmadan sadeleştirme fazladan
   * kayıt düşürür, sonraki eşitleme onu geri indirir ve kullanıcı
   * "temizledim, geri geldi" der.
   *
   * Eski manifestlerde YOKTUR ve toplu göç YAPILMAZ: sayısı bilinmeyen grup
   * denetimde bildirilir ama otomatik olarak SADELEŞTİRİLMEZ.
   */
  grupSayilari?: Record<string, number>;
  evraklar: ManifestEvrak[];
}

export interface ManifestOkunan extends Manifest {
  surum: 1;
}

export class ManifestDepo {
  private dosya: string;
  constructor(dosya: string) {
    this.dosya = dosya;
  }
  // oku() BİLEREK gevşektir: mdStatus doğrulanmaz ve normalize EDİLMEZ.
  // Normalize etseydi orkestratörün bir sonraki manifest yazımı (orchestrator
  // :727) türetilmiş değeri kalıcılaştırırdı — yani yasaklanan toplu göç arka
  // kapıdan girerdi. Tanınmayan değer okuma yolunda "bilinmiyor" gösterilir.
  oku(): ManifestOkunan | null {
    try {
      const ham = JSON.parse(readFileSync(this.dosya, "utf8"));
      if (ham && Array.isArray(ham.evraklar) && typeof ham.dosyaId === "string") {
        return { surum: 1, ...ham } as ManifestOkunan;
      }
    } catch {
      /* yok */
    }
    return null;
  }
  yaz(m: Manifest): void {
    yazJsonAtomik(this.dosya, { surum: 1, ...m }, 0o600);
  }
  sil(): void {
    try {
      // silme — kullanıcının verisini asla silmiyoruz; üzerine yazma işi
      // orkestratöre ait
    } catch {
      /* */
    }
  }
}

/** Dava manifest'inin dosya adı — tek yerde. */
export const MANIFEST_ADI = "uyap-project.json";

/**
 * Manifest'i yazmadan ÖNCE kurtarılabilir bir kopya bırakır ve yedeğin adını
 * döndürür.
 *
 * P19b'de sadeleştirme için yazıldı, P06b'de onarım da aynı yedeği alıyor —
 * ad kalıbı TEK yerde durmalı, çünkü denetim bu deseni tanıyıp yedeği "yetim
 * dosya" saymıyor. Desen aşağıdaki `MANIFEST_YEDEK_DESENI`dir ve denetim onu
 * BURADAN alır (P06c: eskiden `denetim.ts` kendi kopyasını taşıyordu). İki
 * ayrı kalıp yazılsaydı biri yetim listesine düşer ve kullanıcı kendi
 * güvenlik ağını "çöp" sanırdı.
 *
 * `COPYFILE_EXCL`: var olan bir yedeğin üstüne YAZILMAZ. Yazım sırası da
 * bilerek şudur — önce yedek, sonra manifest; süreç arada ölürse diskte ya
 * eski manifest ya eski manifest + yedeği bulunur, asla yedeksiz yeni
 * manifest bulunmaz.
 *
 * P06c — AYNI MİLİSANİYEDE İKİNCİ YEDEK ARTIK DÜŞMÜYOR. Ad yalnız
 * `Date.now()` iken `COPYFILE_EXCL` aynı milisaniyedeki ikinci yedeği
 * `EEXIST` ile fırlatıyordu; P19b'de tek çağıran vardı, bugün dört
 * (orkestratör iki yerde, sadeleştirme, seçili onarım) ve onarım döngüsü
 * milisaniyenin altında iş yapıyor. Çakışmada ad SIRA NUMARASI alır
 * (`…-1`, `…-2`): hangi yedeğin sonra alındığı belirli kalsın diye rastgele
 * sonek İKİNCİ tercihtir, yalnız sıra tükenirse kullanılır. Üzerine yazma
 * dalı EKLENMEDİ — bir yedeği ezmek, yedeğin varlık sebebini yok eder.
 */
export function manifestiYedekle(klasor: string): string {
  const kaynak = join(klasor, MANIFEST_ADI);
  const damga = Date.now();
  for (let n = 0; n <= 99; n++) {
    const ad = n === 0 ? `uyap-project.yedek-${damga}.json` : `uyap-project.yedek-${damga}-${n}.json`;
    try {
      copyFileSync(kaynak, join(klasor, ad), constants.COPYFILE_EXCL);
      return ad;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  const ad = `uyap-project.yedek-${damga}-${randHex(4)}.json`;
  copyFileSync(kaynak, join(klasor, ad), constants.COPYFILE_EXCL);
  return ad;
}

/**
 * Manifest yedeğinin ad deseni — TEK yerde. Denetim bu deseni tanıyıp yedeği
 * "yetim dosya" saymaz (`src/store/denetim.ts`); iki ayrı kalıp yazılsaydı
 * biri yetim listesine düşer ve kullanıcı kendi güvenlik ağını "çöp" sanırdı.
 * Sonek isteğe bağlıdır: aynı milisaniyedeki ikinci yedek sıra numarası
 * (`-1`) ya da rastgele onaltılık sonek taşır.
 */
export const MANIFEST_YEDEK_DESENI = /^uyap-project\.yedek-\d+(?:-[0-9a-f]{1,8})?\.json$/;

/**
 * P20 (inceleme) — bir manifest kaydının HAM dosyası hâlâ manifestin bildirdiği
 * belge mi? README'nin sözünün ("Yerelde değişmiş kaynak üzerine yazılmaz,
 * yeni indirme ayrı dosyaya kaydedilir") ölçümü budur.
 *
 * ÖLÇÜLDÜ (izole motor + sahte portal): bu kontrol yokken, arşivdeki bir
 * belgeye elle not düşülmüş dosya belirsiz grupta üye değişiminde SESSİZCE
 * eziliyordu — not yok oluyor, sayaç "1 yenilenen" diyor, denetim "0 bulgu"
 * diyordu.
 *
 * P06b — SEÇİLİ ONARIM DA AYNI ÖLÇÜTÜ KULLANIR ve bu yüzden burada durur:
 * "üzerine yazabilir miyim" sorusunun iki farklı yanıtı olamaz. Onarım
 * `false` gördüğünde dosyayı ezmez, yeni bir kopya açar.
 *
 * Dönüşler:
 *   • dosya YOK → true. O yola yazmak ONARIMDIR; yok edilecek belge yoktur
 *     (P15c "kaynağı kayıp satır" rozeti tam da bunu gösteriyor).
 *   • sha256 tutuyor → true. Kayıt neyi bildiriyorsa diskte o duruyor.
 *   • sha256 tutmuyor / ölçülemiyor / dosya değil / kapsam dışı → false.
 *     ÖLÇÜLEMEYEN ŞEY YOK EDİLMEZ: çağıran yeni yol açar, bedeli bir dosyadır.
 */
export function hamDosyaKaydiTutuyorMu(klasor: string, k: ManifestEvrak): boolean {
  const tam = join(klasor, k.path);
  if (!kapsamIcindeMi(klasor, tam)) return false;
  if (!existsSync(tam)) return true;
  try {
    const bilgi = statSync(tam);
    // 512 MB üstü kaynağı özetlemek eşitlemeyi kilitler; ölçemiyorsak ezmeyiz.
    if (!bilgi.isFile() || bilgi.size > 512 * 1024 * 1024) return false;
    return createHash("sha256").update(readFileSync(tam)).digest("hex") === k.sha256;
  } catch {
    return false;
  }
}

/**
 * YOL → KAYIT. Ürünün TEK "bu yol hangi kaydı gösteriyor" kuralı.
 *
 * ── NEDEN İKİ ALANA BAKAR ───────────────────────────────────────────────────
 * Bir kaydın İKİ yolu vardır: kaynak belge (`path`, `_kaynak/…`) ve hazır
 * metin türevi (`mdPath`, `evraklar/…`). Denetim raporu türev bulgusunda
 * KULLANICIYA GÖRÜNEN yolu yazar, yani `mdPath`i; onarım ise kaydı bulmak
 * zorundadır. İki taraf iki farklı alana bakınca "Metni yeniden üret" düğmesi
 * ÖLÇÜLDÜ (13 Eylül, izole motor + sentetik arşiv): her tıkta
 * `kayit-belirsiz` düşüyor, üstelik suçu "rapor bayatlamış" diye yanlış yere
 * atıyordu. Kural tek yerde olsun diye eşleme buraya alındı: raporun yazdığı
 * yol — kaynak ya da türev — kaydı bulur. Aynı kural CLI'ın `--yol`u için de
 * geçerlidir, yoksa kullanıcının rapordan kopyaladığı yol çalışmazdı.
 *
 * ── BELİRSİZLİK TAHMİNE ÇEVRİLMEZ ───────────────────────────────────────────
 * Yolu gösteren kayıt sayısı 1 değilse `null` döner: iki kayıt aynı yolu
 * gösteriyorsa (yol çakışması) hangisinin kastedildiği ÖLÇÜLEMEZ ve çağıran
 * "tek kayıt bulunamadı" der. Tahminle yanlış kaydı onarmak yasaktır.
 */
export function yolaGoreTekKayit(
  kayitlar: readonly ManifestEvrak[],
  rel: string,
): ManifestEvrak | null {
  if (rel === "") return null;
  const eslesen = kayitlar.filter(
    (k) => k && typeof k === "object" && (k.path === rel || k.mdPath === rel),
  );
  return eslesen.length === 1 ? eslesen[0]! : null;
}

/** stableKey üretimi: ana evrak "ana:<birimEvrakNo>", ek "ek:<anaId>:<sıra>" */
export function stableKeyAna(birimEvrakNo: string | undefined, evrakId: string): string {
  if (birimEvrakNo !== undefined && birimEvrakNo.length > 0) return `ana:${birimEvrakNo}`;
  // evrakId'den kısa özet: opak token yerine kısa kimlik
  return `ana:${kisaOzet(evrakId)}`;
}

export function stableKeyEk(anaEvrakId: string, sira: number): string {
  return `ek:${kisaOzet(anaEvrakId)}:${sira}`;
}

export function kisaOzet(token: string): string {
  // opak token'ın ilk 24 karakteri kararlı kimlik sağlar
  const temiz = token.replace(/["'\\]/g, "");
  return temiz.length > 24 ? temiz.slice(0, 24) : temiz;
}
