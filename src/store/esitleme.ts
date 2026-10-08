// Eşitleme damgası: "bu evrak hangi eşitlemede indi?" sorusunun kalıcı cevabı
// ve "yeni" rozetinin TEK türetme kaynağı.
//
// KATMAN: `src/store/` altındadır ve `src/store/hazirlik.ts` gibi SIFIR içe
// aktarımlıdır — hiçbir şey okur, hiçbir şey yazar. Manifest tipleri buradan
// import eder (ters yön olurdu: manifest.ts I/O yapar, bu dosya saf kalır).
//
// ── KARAR 1: rozet KİMLİK eşitliğiyle verilir, zaman karşılaştırmasıyla değil.
// `evrak.indirmeDamgasi.esitlemeId === manifest.sonEsitleme.esitlemeId`.
// Zaman damgası karşılaştırması iki yerde yanıltır: sistem saati geri alınırsa
// yeni evrak eskiden inmiş görünür, iki eşitleme aynı ISO değerine düşerse
// önceki eşitlemenin evrakları da rozetlenir. `at` alanı YALNIZ gösterim
// içindir ve hiçbir karara girmez.
//
// ── KARAR 2: rozetin kaynağı TAMAMLANMIŞ denemedir.
// `sonEsitleme` yalnız orkestratörün commit noktasında (duraklatma erken
// dönüşünden SONRA çalışan `donusumleriTetikle` + `lastSyncedAt` yazımı)
// yazılır. Duraklatılan/iptal edilen/kesilen denemede manifest'te kısmi
// kayıtlar ve damgalar KALIR (her evraktan sonra diske yazılıyor), ama işaretçi
// eski değerinde durur — yani rozet uydurulmaz, ekran son tamamlanan
// eşitlemeyi göstermeye devam eder.
//
// ── KARAR 3: "sahiplenme" TOPLU ALAN GÜNCELLEMESİYLE DEĞİL, KİMLİK YENİDEN
// KULLANIMIYLA yapılır. Yarıda kalmış bir denemenin indirdiği evraklar, devam
// eden denemede de rozet almalıdır. Bunu "commit anında eski damgaları bu
// denemenin kimliğine çevir" diye yapmak iki sebeple yanlıştır:
//   (a) kayıt tek başına "hiç commit edilmemiş deneme" ile "iki eşitleme önceki
//       commit edilmiş deneme"yi ayırt ettiremez — ikinci hâlde BÜTÜN eski
//       arşiv "yeni" görünür;
//   (b) manifest'te toplu alan yeniden yazımı demektir.
// Bunun yerine: damga atan ama commit etmeyen deneme kimliğini manifest'e
// `acikEsitleme` olarak bırakır; sıradaki deneme yeni kimlik üretmez, AYNI
// kimliği devralır (`esitlemeKimligiSec`). Commit anında `acikEsitleme`
// silinir. Böylece A duraklar → B devam eder → B commit eder zincirinde
// A'nın indirdikleri de rozetlenir ve hiçbir kayıt yeniden yazılmaz.
//
// ── KARAR 4: İLK İNDİRMEDE (klonla) HİÇBİR EVRAK ROZETLENMEZ.
// Gerekçe: rozet "eşitledim, ne değişti?" sorusunun cevabıdır ve değeri
// KARŞITLIKTAN gelir — her satır "Yeni" derse hiçbir satır öne çıkmaz, sayfa
// okunmaz hâle gelir. Üstelik bilgi zaten ekranda: dava satırı "31 evrak"
// diyor, ilk indirme tam olarak bunu getirdi; yanına "31 yeni" yazmak aynı
// sayıyı ikinci kez söylemektir. Damgalar yine de YAZILIR (veri dürüst kalır,
// bir sonraki eşitleme doğru ayrımı yapabilsin) — bastırılan yalnız gösterimdir.
// `ilkIndirme` ölçüsü "daha önce hiç tamamlanmış eşitleme yok"tur; kayıt sayısı
// değil. Duraklatılıp devam ettirilen bir ilk klon da ilk indirmedir.
//
// ── SINIR: "yeni" ile "kullanıcı okudu" AYNI ŞEY DEĞİLDİR. Bu dosya okundu
// bilgisi tutmaz (P12). Rozet, evrak açılınca değil, bir sonraki TAMAMLANAN
// eşitlemede düşer.
//
// TÜRETME İKİZİ: aşağıdaki `yeniMi`/`esitlemeSayaci`, web/evrak-durum.js
// içindeki JS eşlerinin birebir kopyasıdır (web modülleri TS import edemez).
// İkisinin aynı tabloyu ürettiği test/arsiv-ui.test.ts içindeki "P15b türetme
// ikizi" testiyle sabitlenmiştir; birini değiştiren diğerini de değiştirmelidir.

/** Evrak kaydına yazılan damga. `at` YALNIZ gösterim içindir. */
export interface IndirmeDamgasi {
  esitlemeId: string;
  at: string;
  tur: "yeni" | "yenilenen";
}

/**
 * Manifest'e yalnız commit noktasında yazılan işaretçi.
 *
 * `yeni`/`yenilenen` ROZETLİ SATIR SAYISIDIR, ham indirme sayısı değil: ilk
 * indirmede (KARAR 4) rozet gösterilmediği için ikisi de 0'dır. İlk indirmenin
 * getirdiği evrak sayısı zaten dava satırındaki "N evrak"tır. Bu tanım sayesinde
 * "ekranda rozetli satır sayısı = sonEsitleme.yeni + sonEsitleme.yenilenen"
 * eşitliği her durumda korunur (bekçi: test/p15b.test.ts).
 */
export interface SonEsitleme {
  esitlemeId: string;
  at: string;
  kaynak: "klonla" | "esitle";
  ilkIndirme: boolean;
  yeni: number;
  yenilenen: number;
}

/** Damga atmış ama commit etmemiş deneme. Sıradaki deneme bu kimliği devralır. */
export interface AcikEsitleme {
  esitlemeId: string;
  at: string;
}

/** Çakışması pratikte imkânsız, sıralama taşımayan opak kimlik. */
export function esitlemeKimligiUret(): string {
  return `es-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e12).toString(36)}`;
}

/**
 * Bu denemenin kullanacağı kimlik. Yarıda kalmış bir deneme varsa onun kimliği
 * DEVRALINIR (KARAR 3); yoksa yeni kimlik üretilir.
 */
export function esitlemeKimligiSec(acik: AcikEsitleme | undefined, uret = esitlemeKimligiUret): string {
  const devir = acik?.esitlemeId;
  return typeof devir === "string" && devir !== "" ? devir : uret();
}

/**
 * Evrak son tamamlanan eşitlemede mi indi? Cevap damga türüdür ("yeni" ya da
 * "yenilenen"), inmemişse `null`. İlk indirmede her zaman `null` (KARAR 4).
 */
export function yeniMi(
  evrak: { indirmeDamgasi?: { esitlemeId?: unknown; tur?: unknown } | null } | null | undefined,
  sonEsitleme: { esitlemeId?: unknown; ilkIndirme?: unknown } | null | undefined,
): "yeni" | "yenilenen" | null {
  const isaret = sonEsitleme?.esitlemeId;
  if (typeof isaret !== "string" || isaret === "") return null;
  if (sonEsitleme?.ilkIndirme === true) return null;
  const damga = evrak?.indirmeDamgasi;
  if (!damga || damga.esitlemeId !== isaret) return null;
  return damga.tur === "yenilenen" ? "yenilenen" : "yeni";
}

/**
 * Son eşitlemede inen evrak sayısı, manifest'in KENDİSİNDEN sayılır — iş
 * sayaçlarından değil. Sebep: duraklatılıp devam ettirilen eşitlemede iş
 * sayaçları yalnız son koşuyu görür, manifest ise devralınan kimlik sayesinde
 * denemenin tamamını görür. Rozetli satır sayısı ile bu sayaç bu yüzden
 * tanım gereği birebir eşittir.
 */
export function esitlemeSayaci(
  evraklar: readonly unknown[] | null | undefined,
  sonEsitleme: { esitlemeId?: unknown; ilkIndirme?: unknown } | null | undefined,
): { yeni: number; yenilenen: number } {
  const liste = Array.isArray(evraklar) ? evraklar : [];
  let yeni = 0;
  let yenilenen = 0;
  for (const e of liste) {
    const t = yeniMi(e as { indirmeDamgasi?: { esitlemeId?: unknown; tur?: unknown } }, sonEsitleme);
    if (t === "yeni") yeni++;
    else if (t === "yenilenen") yenilenen++;
  }
  return { yeni, yenilenen };
}
