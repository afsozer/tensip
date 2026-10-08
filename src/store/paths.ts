// Yol yönetimi: veri kökü, dava klasörü adı, dosya adı sanitizasyonu.
//
// Kök: ~/Documents/Tensip/Avukat UYAP/<AVUKAT>/<Grup>/<KOD>/<Birim YYYY-ESAS>/
// Avukat → grup → yargı türü → dava hiyerarşisi; başka araçların köküyle çakışmaz.

import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";

/** Var olan arşivi yerinde tutar (UYAP Asistan adlı önceki sürümlerin iki kökü);
 *  yeni kurulum ~/Documents/Tensip'e yazar. Arşiv hiçbir zaman sessizce taşınmaz. */
export function varsayilanArsiv(ev = homedir()): string {
  const eskiler = [join(ev, "Documents", "UYAPAsistan"), join(ev, "AVUKATLIK-ISLERI", "UYAP-Asistan")];
  return eskiler.find((d) => existsSync(d)) ?? join(ev, "Documents", "Tensip");
}

export function kokDizin(secenek?: { kok?: string; avukat?: string }): string {
  if (secenek?.kok) return join(secenek.kok, "Avukat UYAP", secenek.avukat ?? "AVUKAT");
  return join(varsayilanArsiv(), "Avukat UYAP", secenek?.avukat ?? "AVUKAT");
}

/** Dosya adına uygun olmayan karakterleri kırpın/çevirin. */
export function adTemizle(ad: string, uzunluk = 120): string {
  const temiz = ad
    .replace(/[\\/:*?"<>|\u0000]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return temiz.length > uzunluk ? temiz.slice(0, uzunluk).trim() : temiz;
}

/** "2026/928" esas → klasör no: "2026-928" */
export function esasKlasorNo(esasNo: string): string {
  return esasNo.replace("/", "-");
}

/** Dava klasör adı: "Çamlık Asliye Hukuk Mahkemesi 2026-928" */
export function davaKlasorAdi(birimAdi: string, esasNo: string): string {
  return adTemizle(`${birimAdi} ${esasKlasorNo(esasNo)}`);
}

/** Dava klasörü tam yolu. */
export function davaKlasoru(
  kok: string,
  avukat: string,
  grup: string,
  kod: string,
  birimAdi: string,
  esasNo: string
): string {
  return join(
    kok,
    "Avukat UYAP",
    adTemizle(avukat, 60),
    adTemizle(grup, 40),
    adTemizle(kod, 60),
    davaKlasorAdi(birimAdi, esasNo)
  );
}

/** "2026-09-04" — yerel gün (tr-TR ISO) */
export function gunDami(tarih: string): string {
  // UYAP tarihleri "04/09/2026" biçiminde; zaten gün damgası varsa dokunma
  if (/^\d{4}-\d{2}-\d{2}$/.test(tarih)) return tarih;
  const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(tarih);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  // bozuk/boşsa bugün
  return new Date().toISOString().slice(0, 10);
}

/** Evrak dosya adı: "2026-09-04_Cevap Dilekçesi_6973.udf".
 *  uzanti boş geçilebilir — taban ad döner (uzantı indirmeden sonra türetilir). */
export function evrakDosyaAdi(tarih: string, tur: string, evrakNo: string | undefined, uzanti: string): string {
  const t = gunDami(tarih);
  const turT = adTemizle(tur, 60);
  const no = evrakNo !== undefined && evrakNo.length > 0 ? `_${evrakNo}` : "";
  const taban = adTemizle(`${t}_${turT}${no}`, 150);
  return uzanti.length > 0 ? `${taban}.${uzanti}` : taban;
}

export { join };
