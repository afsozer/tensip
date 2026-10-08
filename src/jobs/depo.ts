// Kalıcı iş geçmişi. İş deposu daemon kilidi edinildikten sonra yüklenir;
// dosya yoksa boş başlar, bozuk dosya sessizce sıfırlanmaz.
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Hata, KODLAR } from "../core/errors.js";
import { yazJsonAtomik } from "../store/fsops.js";
import { redakteEt } from "../core/log.js";
import type { IsKaydi, KlonlaIstek, IsDurum } from "./orchestrator.js";

export const IS_DEPO_SURUMU = 1 as const;
const DURUMLAR: IsDurum[] = [
  "bekliyor",
  "calisiyor",
  "hazir",
  "eksikli",
  "iptal",
  "hata",
  "duraklatildi",
  "kesildi",
];

export interface IsParametreleri {
  klonla?: KlonlaIstek;
  /**
   * P06b — seçili onarımın hedefleri: dava klasörüne göreli evrak yolları.
   * Devam ettirilen bir onarım işi AYNI hedefleri denemek zorundadır, o yüzden
   * kalıcıdır ve doğrulanır. Kök dışına çıkan ya da mutlak yol KABUL EDİLMEZ:
   * iş deposu bir dosya yolu taşıyorsa, o yolun kapsamı burada da ölçülür.
   */
  onar?: { hedefler: string[] };
}

export interface KaliciIsKaydi extends IsKaydi {
  parametreler?: IsParametreleri;
  oncekiIsId?: string;
  devamIsId?: string;
}

interface IsDeposu {
  surum: typeof IS_DEPO_SURUMU;
  isler: KaliciIsKaydi[];
}

function nesne(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * Onarım hedefi geçerli mi? Yol dava klasörüne GÖRELİ olmalı: mutlak yol,
 * `..` ile yukarı çıkan yol ve boş dize reddedilir. Depo dosyası elle
 * düzenlenmiş olabilir; oradan gelen bir yol doğrudan diske yazılmaz.
 */
export function gecerliOnarimHedefi(v: unknown): v is string {
  if (typeof v !== "string" || v === "" || v.length > 1024) return false;
  if (v.startsWith("/") || /^[A-Za-z]:[\\/]/.test(v)) return false;
  return !v.split(/[\\/]/).includes("..");
}

function gecerliOnarIstek(v: unknown): v is { hedefler: string[] } {
  if (!nesne(v) || !Array.isArray(v.hedefler)) return false;
  return (
    v.hedefler.length >= 1 &&
    v.hedefler.length <= 200 &&
    v.hedefler.every(gecerliOnarimHedefi)
  );
}

function gecerliKlonIstek(v: unknown): v is KlonlaIstek {
  if (!nesne(v)) return false;
  return (
    typeof v.birimAdi === "string" &&
    typeof v.esasNo === "string" &&
    (v.kapsam === "acik" || v.kapsam === "kapali" || v.kapsam === "hepsi") &&
    typeof v.avukat === "string" &&
    (v.grup === undefined || typeof v.grup === "string") &&
    (v.kod === undefined || typeof v.kod === "string")
  );
}

function kayitDogrula(v: unknown): v is KaliciIsKaydi {
  if (!nesne(v)) return false;
  if (
    typeof v.isId !== "string" ||
    (v.tur !== "klonla" && v.tur !== "esitle" && v.tur !== "onar") ||
    typeof v.caseKey !== "string" ||
    typeof v.baslamaAt !== "string" ||
    !DURUMLAR.includes(v.durum as IsDurum) ||
    !nesne(v.ilerleme) ||
    !Number.isInteger(v.ilerleme.toplam) ||
    !Number.isInteger(v.ilerleme.biten) ||
    Number(v.ilerleme.toplam) < 0 ||
    Number(v.ilerleme.biten) < 0
  ) return false;
  if (v.tur === "klonla" && (!nesne(v.parametreler) || !gecerliKlonIstek(v.parametreler.klonla))) return false;
  // P06b — onarım işi hedefsiz OLAMAZ: hedefi olmayan bir kayıt "devam et"
  // dendiğinde neyi onaracağını bilemez.
  if (v.tur === "onar" && (!nesne(v.parametreler) || !gecerliOnarIstek(v.parametreler.onar))) return false;
  if (v.parametreler !== undefined) {
    if (!nesne(v.parametreler)) return false;
    if (v.tur === "klonla" && !gecerliKlonIstek(v.parametreler.klonla)) return false;
    if (v.tur === "esitle" && (v.parametreler.klonla !== undefined || v.parametreler.onar !== undefined)) return false;
    if (v.tur === "klonla" && v.parametreler.onar !== undefined) return false;
    if (v.tur === "onar" && v.parametreler.klonla !== undefined) return false;
  }
  if (v.hata !== undefined && (!nesne(v.hata) || typeof v.hata.code !== "string" || typeof v.hata.message !== "string")) return false;
  if (v.oncekiIsId !== undefined && typeof v.oncekiIsId !== "string") return false;
  if (v.devamIsId !== undefined && typeof v.devamIsId !== "string") return false;
  if (v.iptalIsteniyor !== undefined && typeof v.iptalIsteniyor !== "boolean") return false;
  return true;
}

/** YAZIM kapısı: tek geçersiz kayıt bile dosyaya YAZILMAZ. */
function depoDogrula(v: unknown): v is IsDeposu {
  if (!nesne(v) || v.surum !== IS_DEPO_SURUMU || !Array.isArray(v.isler) || !v.isler.every(kayitDogrula)) return false;
  const ids = v.isler.map((is) => is.isId);
  return new Set(ids).size === ids.length;
}

/**
 * OKUMA kapısı — YAZIMDAN AYRI VE DAHA HOŞGÖRÜLÜ.
 *
 * ── NEDEN ───────────────────────────────────────────────────────────────────
 * Doğrulama HEPSİ-YA-HİÇBİRİ olduğu sürece, tanınmayan TEK bir `tur` bütün iş
 * geçmişini "bozuk" yapıyordu. ÖLÇÜLDÜ (13 Eylül, izole ayar dizini): içinde
 * bu sürümün tanımadığı tek bir kayıt bulunan bir `isler.json` + aynı içerikli
 * yedek `IsDepo.oku()`yu `INTERNAL: iş deposu bozuk` ile düşürüyor; o hata
 * `depoYukle()` üzerinden MOTORUN AÇILIŞINI reddediyor. P06b `onar` türünü
 * eklediğine göre bu, ileride bir sürüm daha eklendiğinde geri dönen
 * kullanıcının klonla/esitle geçmişini de yakacak bir tuzaktı (ROADMAP §4
 * P06b madde 4: "Eski iş geçmişi açılabilmelidir").
 *
 * ── KURAL ───────────────────────────────────────────────────────────────────
 * Dosyanın KABUĞU (nesne + sürüm + dizi) bozuksa hiçbir şey okunmaz: eskisi
 * gibi null döner ve yedeğe düşülür. Kabuk sağlamsa TANINMAYAN KAYITLAR ELENİR,
 * tanınanlar okunur ve elenen sayısı görünür kalır (`kurtarmaGerekiyor`).
 * Yazım kapısı gevşemez: elenen kayıt bir sonraki yazımda dosyadan düşer, o
 * yüzden sessiz kalmaz.
 */
function depoOku(v: unknown): { veri: IsDeposu; elenen: number } | null {
  if (!nesne(v) || v.surum !== IS_DEPO_SURUMU || !Array.isArray(v.isler)) return null;
  const isler: KaliciIsKaydi[] = [];
  const gorulen = new Set<string>();
  let elenen = 0;
  for (const kayit of v.isler) {
    // Aynı isId iki kez: hangisinin doğru olduğu ölçülemez, ikincisi elenir.
    if (!kayitDogrula(kayit) || gorulen.has(kayit.isId)) {
      elenen++;
      continue;
    }
    gorulen.add(kayit.isId);
    isler.push(kayit);
  }
  return { veri: { surum: IS_DEPO_SURUMU, isler }, elenen };
}

function izinliKopya(is: KaliciIsKaydi): KaliciIsKaydi {
  const out: KaliciIsKaydi = {
    isId: is.isId,
    tur: is.tur,
    caseKey: is.caseKey,
    durum: is.durum,
    baslamaAt: is.baslamaAt,
    ilerleme: { toplam: is.ilerleme.toplam, biten: is.ilerleme.biten },
  };
  if (is.bitisAt !== undefined) out.bitisAt = is.bitisAt;
  if (is.sonuc !== undefined) out.sonuc = is.sonuc;
  if (is.hata !== undefined) out.hata = { code: is.hata.code, message: redakteEt(is.hata.message) };
  if (is.parametreler?.klonla !== undefined) {
    const p = is.parametreler.klonla;
    out.parametreler = {
      klonla: {
        birimAdi: p.birimAdi,
        esasNo: p.esasNo,
        kapsam: p.kapsam,
        avukat: p.avukat,
        ...(p.grup !== undefined ? { grup: p.grup } : {}),
        ...(p.kod !== undefined ? { kod: p.kod } : {}),
      },
    };
  }
  // P06b — hedefler KOPYALANIR; taşınmasaydı doğrulama düşer ve bütün iş
  // geçmişi "bozuk" sayılırdı (P15b'nin manifest literalindeki tuzağın ikizi).
  if (is.parametreler?.onar !== undefined) {
    out.parametreler = { onar: { hedefler: [...is.parametreler.onar.hedefler] } };
  }
  if (is.oncekiIsId !== undefined) out.oncekiIsId = is.oncekiIsId;
  if (is.devamIsId !== undefined) out.devamIsId = is.devamIsId;
  if (is.iptalIsteniyor !== undefined) out.iptalIsteniyor = is.iptalIsteniyor;
  return out;
}

export class IsDepo {
  readonly dosya: string;
  readonly yedek: string;
  private veri: IsDeposu | null = null;
  private kurtarildi = false;
  /** Okuma sırasında tanınmadığı için elenen kayıt sayısı; sessiz kalmaz. */
  private elenen = 0;

  constructor(ayarDir: string) {
    this.dosya = join(ayarDir, "isler.json");
    this.yedek = `${this.dosya}.yedek`;
  }

  oku(): KaliciIsKaydi[] {
    if (this.veri) return this.veri.isler;
    const ana = this.jsonOku(this.dosya);
    if (ana !== null) {
      this.veri = ana;
      return ana.isler;
    }
    if (!existsSync(this.dosya) && !existsSync(this.yedek)) {
      this.veri = { surum: IS_DEPO_SURUMU, isler: [] };
      return this.veri.isler;
    }
    const yedek = this.jsonOku(this.yedek);
    if (yedek !== null) {
      if (existsSync(this.dosya)) copyFileSync(this.dosya, `${this.dosya}.bozuk-${Date.now()}`);
      this.veri = yedek;
      this.kurtarildi = true;
      return yedek.isler;
    }
    throw new Hata(
      KODLAR.INTERNAL,
      `iş deposu bozuk: ${basename(this.dosya)} okunamadı; kaynak işler korunuyor, ${basename(this.yedek)} yedeğini düzeltip yeniden başlatın`
    );
  }

  /** Son başarılı görüntüyü atomik ana dosyadan önce yedekler. */
  yaz(isler: readonly KaliciIsKaydi[]): void {
    const veri: IsDeposu = { surum: IS_DEPO_SURUMU, isler: isler.map(izinliKopya) };
    if (!depoDogrula(veri)) throw new Hata(KODLAR.INTERNAL, "iş deposuna geçersiz kayıt yazılamadı");
    const mevcut = this.jsonOku(this.dosya);
    if (mevcut !== null) yazJsonAtomik(this.yedek, mevcut);
    // Yedekten kurtarılan veri de ana dosyaya ancak geçerli yeni bir yazımda taşınır.
    yazJsonAtomik(this.dosya, veri);
    this.veri = veri;
    this.kurtarildi = false;
  }

  kurtarmaGerekiyor(): boolean {
    return this.kurtarildi;
  }

  /**
   * Okunurken elenen kayıt sayısı. Sıfırdan büyükse geçmişin bir kısmı bu
   * sürüm tarafından tanınmadı (örneğin daha yeni bir sürümün yazdığı iş türü)
   * ve bir sonraki yazımda dosyadan düşecek. Motor bunu `durum` yanıtında
   * bildirir; sessiz veri kaybı olmaz.
   */
  elenenKayitSayisi(): number {
    return this.elenen;
  }

  private jsonOku(dosya: string): IsDeposu | null {
    try {
      const v: unknown = JSON.parse(readFileSync(dosya, "utf8"));
      const son = depoOku(v);
      if (son === null) return null;
      this.elenen += son.elenen;
      return son.veri;
    } catch {
      return null;
    }
  }
}

export function isDepoKayitlarinaCevir(isler: readonly IsKaydi[]): KaliciIsKaydi[] {
  return isler.map(izinliKopya);
}
