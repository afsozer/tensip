// Hazırlık taksonomisi: `mdStatus`ın YAZILAN değer kümesi, eski birleşik
// `unsupported` değerinin OKUMA sırasındaki türetmesi ve özet sayacı.
//
// KATMAN: bu dosya `src/store/` altındadır çünkü `src/convert/run.ts` zaten
// `../store/fsops.js`i import ediyor — yani store alt, convert üst katmandır.
// Tipi convert altına koymak yönü tersine çevirirdi. Burası sıfır içe
// aktarımlı ve saf tutulur; hiçbir şey yazmaz, hiçbir şey okumaz.
//
// YAZILAN küme (yalnız src/convert/run.ts yazar):
//   ok             metin türetildi, mdPath var
//   gorsel         görsel uzantı ya da metin katmanı olmayan PDF — KAYNAK SAĞLAM,
//                  çok kipli model doğrudan okur. Başarısızlık değildir.
//   desteklenmiyor bilinmeyen uzantı ya da uzantısı .udf olup içeriği ZIP olmayan
//   arac-yok       pdftotext kurulu değil — belge hakkında hüküm değil, ortam eksikliği
//   hata           dönüşüm fırlattı
//   bekliyor       henüz denenmedi
//
// OKUNAN küme buna ek olarak:
//   unsupported    ESKİ birleşik değer. Diskte kalır, ASLA yeniden yazılmaz;
//                  yalnız okuma sırasında uzantıdan türetilir (hazirlikCoz).
//   bilinmiyor     tanınmayan/boş değer. Yalnız bellekte doğar.
//
// TOPLU GÖÇ YASAK: eski değerler bu modül yüzünden diske geri yazılmaz.
// `ManifestDepo.oku()` bilerek gevşek bırakıldı (normalize etseydi orkestratörün
// bir sonraki manifest yazımı türetilmiş değeri kalıcılaştırır, yani göç arka
// kapıdan girerdi).

export const GORSEL_UZANTILAR: ReadonlySet<string> = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".tif",
  ".tiff",
  ".bmp",
  ".webp",
]);

export const LEGACY_BIRLESIK = "unsupported";

export type MdDurum = "ok" | "gorsel" | "desteklenmiyor" | "arac-yok" | "hata" | "bekliyor";
export type HazirlikDurum = MdDurum | "bilinmiyor";

const YAZILAN: ReadonlySet<string> = new Set<MdDurum>([
  "ok",
  "gorsel",
  "desteklenmiyor",
  "arac-yok",
  "hata",
  "bekliyor",
]);

export const HAZIRLIK_DEGERLERI: readonly HazirlikDurum[] = [
  "ok",
  "gorsel",
  "desteklenmiyor",
  "arac-yok",
  "hata",
  "bekliyor",
  "bilinmiyor",
];

/** Yol sonundaki uzantı, noktası dâhil ve küçük harfli; yoksa "". */
export function uzantiAl(yol: unknown): string {
  const ad = String(yol ?? "").split("/").pop() ?? "";
  const i = ad.lastIndexOf(".");
  if (i <= 0) return "";
  return ad.slice(i).toLowerCase();
}

/**
 * Manifest'teki ham `mdStatus` + yol → gösterilecek hazırlık durumu.
 * Hiçbir koşulda "ok" UYDURMAZ: türetme en iyi ihtimalle `gorsel` der.
 *
 * Eski `unsupported` türetme tablosu (kaynağı src/convert/run.ts'in bugünkü
 * dalları; her dalın unsupported üretebildiği TEK yol ölçülerek çıkarıldı):
 *   görsel uzantılar → gorsel        (run.ts görsel dalı)
 *   .pdf             → gorsel        (pdf dalında unsupported'ın tek kaynağı "taranmis")
 *   .udf             → desteklenmiyor (udf dalı: içerik ZIP değil)
 *   .html/.htm, uzantısız → bilinmiyor (bu dal unsupported ÜRETEMEZ; türetme dürüst olmaz)
 *   diğer (.zip, .bin, …) → desteklenmiyor (bilinmeyen uzantı dalı)
 */
export function hazirlikCoz(mdStatus: unknown, yol?: unknown): HazirlikDurum {
  const d = typeof mdStatus === "string" ? mdStatus : "";
  if (YAZILAN.has(d)) return d as MdDurum;
  if (d !== LEGACY_BIRLESIK) return "bilinmiyor";
  const uz = uzantiAl(yol);
  if (GORSEL_UZANTILAR.has(uz) || uz === ".pdf") return "gorsel";
  if (uz === ".udf") return "desteklenmiyor";
  if (uz === "" || uz === ".html" || uz === ".htm") return "bilinmiyor";
  return "desteklenmiyor";
}

export interface HazirlikOzet {
  toplam: number;
  kullanilabilir: number;
  dagilim: Record<HazirlikDurum, number>;
}

/** Kullanılabilir = ok + gorsel. Görsel bir başarısızlık değil, ayrı okuma yoludur. */
export function hazirlikOzet(
  kayitlar: readonly { mdStatus?: unknown; path?: unknown }[] | null | undefined,
): HazirlikOzet {
  const dagilim = Object.fromEntries(HAZIRLIK_DEGERLERI.map((d) => [d, 0])) as Record<
    HazirlikDurum,
    number
  >;
  const liste = Array.isArray(kayitlar) ? kayitlar : [];
  for (const k of liste) dagilim[hazirlikCoz(k?.mdStatus, k?.path)]++;
  return {
    toplam: liste.length,
    kullanilabilir: dagilim.ok + dagilim.gorsel,
    dagilim,
  };
}
