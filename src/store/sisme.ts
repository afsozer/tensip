// P19 — BİRİKMİŞ ŞİŞKİNLİK: "aynı belge manifestte fazladan kaç kere duruyor?"
//
// P19a eşitlemenin ŞİŞMESİNİ durdurur ama ELDEKİ fazlalığı temizlemez.
// Kullanıcının dosyası 116 satır / 113 gerçek belge ile kaldı. Bu modül o
// fazlalığı TANIR; ne siler ne indirir — kararı `src/store/denetim.ts`
// (bildirir) ve `src/store/sadelestir.ts` (kullanıcı onayıyla uygular) verir.
//
// ── FAZLALIK İKİ ÖLÇÜMÜN KESİŞİMİDİR ───────────────────────────────────────
// 1. AYNI GRUPTA METNİ BİREBİR AYNI birden çok kayıt.
// 2. Manifestteki kayıt sayısı, PORTALIN o grup için bildirdiği satır
//    sayısından FAZLA.
//
// İkinci ölçüm olmadan birinci yanıltır: portal aynı şablonu iki ayrı satır
// olarak bildiriyor olabilir. Gerçek arşivde ölçüldü — 5981 grubunda portal
// 2 satır bildiriyor, manifestte 5 kayıt birikmişti; "metni aynı olanı teke
// indir" kuralı 5 → 1 yapar, sonraki eşitleme 1 tanesini geri indirir ve
// kullanıcı "temizledim, geri geldi" der. Doğru sonuç 5 → 2'dir.
//
// Portal sayısı BİLİNMİYORSA (P19 öncesi yazılmış manifest) fazlalık
// BİLDİRİLİR ama otomatik olarak DÜŞÜRÜLMEZ: ölçülemeyen şey silinmez.
// Bir kez eşitlemek sayıyı yazar ve artık kayıt EKLEMEZ (P19a).
//
// ── ÜÇ ÖLÇÜT BİLEREK KULLANILMADI ──────────────────────────────────────────
//   • `sha256` — UYAP belgeyi her indirişte yeniden ürettiği için baytlar
//     aynı belgede bile farklı (34090/34092/34093/34083/34087 ölçüldü).
//   • `birimEvrakNo` tek başına — aynı numarayı taşıyan iki satır GERÇEKTEN
//     FARKLI belge olabilir (ölçüldü); numara aynılık KANITI değildir.
//   • dosya adı/boyut — ikisi de üretim damgasıyla değişiyor.
//
// ── METNİ OLMAYAN BELGEDE AYNILIK ÖLÇÜLEMEZ ────────────────────────────────
// `gorsel` (taranmış) evrakta metin katmanı yoktur. Orada iki kaydın aynı
// belge olduğu ÖLÇÜLEMEZ; o kayıtlar hiçbir kümeye girmez ve düşürülmez.

import { kayitAnahtari } from "./eslestir.js";
import type { ManifestEvrak } from "./manifest.js";

export interface SismisGrup {
  /** Grup anahtarı (`kayitAnahtari().grup`) — gösterim değil, kimlik. */
  grup: string;
  /** Portalın son listelemede bildirdiği satır sayısı; bilinmiyorsa null. */
  portal: number | null;
  /** Manifestteki kayıt sayısı. */
  manifest: number;
  /** Metni birebir aynı olan kayıtların toplamı (yalnız 2+ üyeli kümeler). */
  yinelenen: number;
  /**
   * Sadeleştirmede düşürülebilecek kayıtlar, EN YENİDEN başlayarak.
   * Portal sayısı bilinmiyorsa BOŞTUR. Her aynılık kümesinin İLK (en eski)
   * üyesi asla listeye girmez: farklı metinli belge tek kayda indirgenmez.
   */
  dusurulebilir: ManifestEvrak[];
  /** Gösterim için temsil kaydı — grubun manifestteki ilk üyesi. */
  ornek: ManifestEvrak;
}

/**
 * Kayıtları eşleşme grubuna böler. `grup` üretemeyen kayıt (numarasız ana
 * evrak, sırasız ek) hiç dönmez: orada "kaç tane olmalı" ölçülemez.
 */
export function kayitGruplari(kayitlar: readonly ManifestEvrak[]): Map<string, ManifestEvrak[]> {
  const gruplar = new Map<string, ManifestEvrak[]>();
  for (const k of kayitlar) {
    if (!k || typeof k !== "object") continue;
    const grup = kayitAnahtari(k).grup;
    if (grup === null) continue;
    const liste = gruplar.get(grup) ?? [];
    liste.push(k);
    gruplar.set(grup, liste);
  }
  return gruplar;
}

/** Grubu 2+ kayıtlı olan (yani metni ölçülmeye değer) kayıtlar. */
export function belirsizGrupKayitlari(kayitlar: readonly ManifestEvrak[]): ManifestEvrak[] {
  const cikti: ManifestEvrak[] = [];
  for (const uyeler of kayitGruplari(kayitlar).values()) {
    if (uyeler.length >= 2) cikti.push(...uyeler);
  }
  return cikti;
}

/**
 * Şişmiş grupları bulur.
 *
 * `metinOzetleri` bir kayıt için `null`/eksik veriyorsa o kayıt hiçbir aynılık
 * kümesine GİRMEZ. `grupSayilari` portalın son bildirdiği satır sayısıdır;
 * verilmezse (eski manifest) grup bildirilir ama `dusurulebilir` BOŞ döner.
 */
export function sismisGruplar(
  kayitlar: readonly ManifestEvrak[],
  grupSayilari: Record<string, number> | undefined,
  metinOzetleri: ReadonlyMap<ManifestEvrak, string | null>,
): SismisGrup[] {
  const cikti: SismisGrup[] = [];
  for (const [grup, uyeler] of kayitGruplari(kayitlar)) {
    if (uyeler.length < 2) continue;
    const ham = grupSayilari?.[grup];
    const portal = typeof ham === "number" && Number.isFinite(ham) && ham >= 0 ? ham : null;

    // Aynı metni taşıyan kümeler — manifest sırası korunur.
    const metneGore = new Map<string, ManifestEvrak[]>();
    for (const k of uyeler) {
      const ozet = metinOzetleri.get(k);
      if (typeof ozet !== "string" || ozet === "") continue;
      const liste = metneGore.get(ozet) ?? [];
      liste.push(k);
      metneGore.set(ozet, liste);
    }
    const kumeler = [...metneGore.values()].filter((l) => l.length >= 2);
    if (kumeler.length === 0) continue;
    const yinelenen = kumeler.reduce((n, l) => n + l.length, 0);

    // Portal sayısını AŞAN kadarı düşürülebilir; her kümenin en eski üyesi
    // kalır. Sıra: en yeni kayıttan başlanır (en eskisi kullanıcının ilk
    // klonundan gelmiş olabilir; onu korumak en güvenli varsayım).
    let dusurulebilir: ManifestEvrak[] = [];
    if (portal !== null && uyeler.length > portal) {
      const adaylar: ManifestEvrak[] = [];
      for (const kume of kumeler) adaylar.push(...kume.slice(1).reverse());
      dusurulebilir = adaylar.slice(0, uyeler.length - portal);
    }
    if (portal !== null && uyeler.length <= portal) continue;
    cikti.push({ grup, portal, manifest: uyeler.length, yinelenen, dusurulebilir, ornek: uyeler[0]! });
  }
  return cikti;
}

/**
 * P19 (inceleme) — AYNI GRUPTA BAYT BAYT AYNI İKİ KAYIT.
 *
 * `grup-sismis` yalnız `manifest > portal` iken bakıyordu ve şu hâli
 * KAÇIRIYORDU (izole motorda ölçüldü): grup büyüdüğünde satırlar sıraya göre
 * eşlenince portalın yeni belgesi hiç inmiyor, yerine kardeşinin İKİNCİ
 * KOPYASI kaydediliyordu. Sonuçta kayıt sayısı portal sayısına EŞİT oluyor
 * (yani şişme eleği susuyor), yollar farklı olduğu için `mukerrer-kayit` de
 * susuyor, ama arşivde bir belge EKSİK ve bir belge İKİ KERE duruyordu.
 *
 * Ölçüt `sha256` — burada bilerek kullanılabilir, çünkü soru "aynı belge mi"
 * değil, "AYNI İNDİRMENİN iki kopyası mı". UYAP belgeyi her indirişte yeniden
 * ürettiği için (baytlar farklı) iki ayrı portal satırının baytı bu kadar denk
 * gelmez; aynı grupta birebir aynı baytlar bir KOPYALAMA izidir.
 *
 * `mukerrer-kayit`ten ayrıdır: orada YOL da aynıdır (tek dosyayı gösteren iki
 * kayıt) ve o yüzden `bilgi`dir; burada iki AYRI dosya aynı baytları taşır.
 */
export interface IkizKayit {
  grup: string;
  /** Aynı sha256'yı taşıyan kayıtlar (2+), manifest sırasında. */
  kopyalar: ManifestEvrak[];
  /** Portalın bu grup için bildirdiği satır sayısı; bilinmiyorsa null. */
  portal: number | null;
}

export function ikizKayitlar(
  kayitlar: readonly ManifestEvrak[],
  grupSayilari?: Record<string, number>,
): IkizKayit[] {
  const cikti: IkizKayit[] = [];
  for (const [grup, uyeler] of kayitGruplari(kayitlar)) {
    if (uyeler.length < 2) continue;
    const ham = grupSayilari?.[grup];
    const portal = typeof ham === "number" && Number.isFinite(ham) && ham >= 0 ? ham : null;
    const shaya = new Map<string, ManifestEvrak[]>();
    for (const k of uyeler) {
      const sha = typeof k.sha256 === "string" ? k.sha256 : "";
      const yol = typeof k.path === "string" ? k.path : "";
      if (sha === "" || yol === "") continue;
      const liste = shaya.get(sha) ?? [];
      // Aynı YOLU gösteren iki kayıt `mukerrer-kayit`in işidir, burada sayılmaz.
      if (liste.some((x) => x.path === yol)) continue;
      liste.push(k);
      shaya.set(sha, liste);
    }
    for (const kopyalar of shaya.values()) {
      if (kopyalar.length >= 2) cikti.push({ grup, kopyalar, portal });
    }
  }
  return cikti;
}

/**
 * P19 (inceleme) — GRUPLANAMAYAN KAYITLARDA SESSİZ BİRİKME.
 *
 * `birimEvrakNo` boş ana evrak küme eşleşmesine hiç girmez (ROADMAP T13):
 * orada "kaç tane olmalı" ÖLÇÜLEMEZ ve grup anahtarını tahmin etmek iki farklı
 * belgeyi birbirinin yerine geçirir. Bedeli ölçüldü: portalın kimliği her
 * listede döndüğü için böyle bir satır HER EŞİTLEMEDE yeniden inip yeni kayıt
 * oluyor (sahte portalda beş eşitlemede 2 → 7 kayıt). Şişme sürüyor ve
 * `grup-sismis` bunu GÖREMİYOR, çünkü kayıtların grubu yok.
 *
 * Bu fonksiyon kimliği TAHMİN ETMEZ, yalnız GÖRÜNÜR KILAR: aynı
 * (tür, tarih, gönderen, tip) altındaki gruplanamayan kayıtlardan metni
 * birebir aynı olanları sayar. Ağırlığı `bilgi`dir ve otomatik sadeleştirmeye
 * ASLA girmez — "burada bir şey birikiyor" demek, iki belgeyi karıştırma
 * riskini almadan söylenebilecek en fazla şeydir.
 */
export interface OlculemezYigin {
  /** Gösterim için ikincil anahtar (tür/tarih/gönderen/tip). Kimlik DEĞİL. */
  anahtar: string;
  /** Yığındaki gruplanamayan kayıt sayısı. */
  toplam: number;
  /** Metni birebir aynı olan kayıtların toplamı (yalnız 2+ üyeli kümeler). */
  yinelenen: number;
  ornek: ManifestEvrak;
}

/** Gruplanamayan ANA kayıtları ikincil anahtara yığar; 2+ üyeliler döner. */
export function olculemezYiginlar(kayitlar: readonly ManifestEvrak[]): Map<string, ManifestEvrak[]> {
  const yiginlar = new Map<string, ManifestEvrak[]>();
  for (const k of kayitlar) {
    if (!k || typeof k !== "object") continue;
    if (kayitAnahtari(k).grup !== null) continue;
    // Sırasız EK evrak da gruplanamaz ama şişmesi ana evraktan başka bir
    // yoldan gelir; burada bilerek karıştırılmaz.
    if (k.isEkEvrak === true) continue;
    const a = [k.tur ?? "", k.tarih ?? "", k.gonderen ?? "", k.tip ?? ""].join("\u0000");
    const liste = yiginlar.get(a) ?? [];
    liste.push(k);
    yiginlar.set(a, liste);
  }
  for (const [a, liste] of yiginlar) if (liste.length < 2) yiginlar.delete(a);
  return yiginlar;
}

export function olculemezSisme(
  kayitlar: readonly ManifestEvrak[],
  metinOzetleri: ReadonlyMap<ManifestEvrak, string | null>,
): OlculemezYigin[] {
  const cikti: OlculemezYigin[] = [];
  for (const [anahtar, uyeler] of olculemezYiginlar(kayitlar)) {
    const metneGore = new Map<string, ManifestEvrak[]>();
    for (const k of uyeler) {
      const ozet = metinOzetleri.get(k);
      if (typeof ozet !== "string" || ozet === "") continue;
      const liste = metneGore.get(ozet) ?? [];
      liste.push(k);
      metneGore.set(ozet, liste);
    }
    const yinelenen = [...metneGore.values()]
      .filter((l) => l.length >= 2)
      .reduce((n, l) => n + l.length, 0);
    if (yinelenen < 2) continue;
    cikti.push({ anahtar, toplam: uyeler.length, yinelenen, ornek: uyeler[0]! });
  }
  return cikti;
}
