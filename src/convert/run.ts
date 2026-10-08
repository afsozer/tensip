// Dönüşüm kuyruğu: ham evrak dosyası → .md (ajan okuması için).
// mdStatus (YAZILAN küme): ok | gorsel | desteklenmiyor | arac-yok | hata | bekliyor
// Tanım ve eski `unsupported` türetmesi: src/store/hazirlik.ts. Bu dosya
// `unsupported` YAZMAZ; eski kayıtlar bir sonraki dönüşümde doğal olarak
// tazelenir (`donusumleriTetikle` yalnız ok+mdPath olan kaydı atlar).
// Yol kuralı:
//   ham:  <dava>/_kaynak/evraklar/<Yon>/<kategori>/<ad>.<uz>
//   md :  <dava>/evraklar/<Yon>/<kategori>/<ad>.md

import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { udfMu, udfToMd } from "./udf.js";
import { htmlToMd } from "./htmlmd.js";
import { pdfToMd, type PdfSecenek } from "./pdftext.js";
import { yazMetinAtomik, kapsamKontrol } from "../store/fsops.js";
import { GORSEL_UZANTILAR, type MdDurum } from "../store/hazirlik.js";

export type { MdDurum };

export interface DonusumSonucu {
  mdStatus: MdDurum;
  mdPath?: string;
  mdHata?: string;
}

/** Bir ham evrak dosyasını dönüştürür; dava köküne göre relPath ver. */
export function donustur(kok: string, relHam: string, sec: PdfSecenek = {}): DonusumSonucu {
  const hamTam = join(kok, relHam);
  try { kapsamKontrol(kok, hamTam); } catch (e) {
    return { mdStatus: "hata", mdHata: e instanceof Error ? e.message : String(e) };
  }
  if (!existsSync(hamTam)) {
    return { mdStatus: "hata", mdHata: "ham dosya yok" };
  }
  const uz = extname(hamTam).toLowerCase();
  // md hedefi: relHam '_kaynak/evraklar/...' → 'evraklar/...'
  const mdRel = relHam.replace(/^_kaynak\//, "").replace(/\.[^.]+$/, "") + ".md";
  const mdTam = join(kok, mdRel);

  try {
    kapsamKontrol(kok, mdTam);
    // Görsel evrak baytları HİÇ OKUNMAZ: `baytlardanMetin` de aynı yanıtı verir
    // ama taranmış bir TIFF'i belleğe almak boşuna maliyettir. Ayrımın ölçütü
    // orada da burada da `GORSEL_UZANTILAR`dır; ikisi ayrışamaz.
    if (GORSEL_UZANTILAR.has(uz)) {
      return { mdStatus: "gorsel", mdHata: "görsel evrak; metin katmanı yok (OCR v1'de yok)" };
    }
    const son = baytlardanMetin(readFileSync(hamTam), uz, sec, hamTam);
    if (son.mdStatus === "ok" && son.md !== undefined) {
      yazMetinAtomik(mdTam, son.md);
      return { mdStatus: "ok", mdPath: mdRel };
    }
    return son.mdHata !== undefined
      ? { mdStatus: son.mdStatus, mdHata: son.mdHata }
      : { mdStatus: son.mdStatus };
  } catch (e) {
    return { mdStatus: "hata", mdHata: e instanceof Error ? e.message : String(e) };
  }
}

export interface MetinSonucu {
  mdStatus: MdDurum;
  /** Yalnız `mdStatus === "ok"` dalında dolu. */
  md?: string;
  mdHata?: string;
}

/**
 * P20 — HAM BAYTLARDAN METİN; DİSKE TEK BAYT YAZILMAZ.
 *
 * `donustur`un kararlarının aynısını verir (dosya adı değil, UZANTI + içerik)
 * ama sonucu dosyaya yazmaz. Gerekçesi eşitlemededir: belirsiz bir grupta
 * yeniden indirilen satır için "bu zaten elimdeki belge mi?" sorusu, indirilen
 * baytlar HERHANGİ BİR YERE yazılmadan ÖNCE yanıtlanmak zorundadır — cevap
 * "evet" ise hiçbir dosya değişmemeli, "hayır" ise baytlar eşleşen kaydın
 * yoluna gitmelidir. Önce yazıp sonra karşılaştırmak, karşılaştırmanın
 * dayandığı eski metni ezer (ölçüldü: eski .md aynı yola yazılıyor).
 *
 * `donustur` bunun ÜSTÜNDE durur: aynı dağıtım iki yerde ayrı yazılsaydı biri
 * "ok" derken öteki "desteklenmiyor" diyebilir, eşitleme de kaydı boşuna
 * yenilerdi.
 *
 * `kaynakDosya` verilirse PDF metni o yoldan çıkarılır (pdftotext dosyayı
 * doğrudan okur); verilmezse baytlar pdftotext'e STDIN'den geçer, yani geçici
 * dosya AÇILMAZ.
 */
export function baytlardanMetin(
  baytlar: Buffer,
  uzanti: string,
  sec: PdfSecenek = {},
  kaynakDosya?: string,
): MetinSonucu {
  const uz = uzanti.toLowerCase();
  if (uz === ".udf" || (uz === "" && udfMu(baytlar))) {
    if (!udfMu(baytlar)) {
      return { mdStatus: "desteklenmiyor", mdHata: "uzantı udf ama içerik ZIP değil" };
    }
    const { md } = udfToMd(baytlar);
    return { mdStatus: "ok", md };
  }
  if (uz === ".html" || uz === ".htm") {
    const { md } = htmlToMd(baytlar.toString("utf8"));
    return { mdStatus: "ok", md };
  }
  if (uz === ".pdf") {
    const son = pdfToMd(baytlar, kaynakDosya, sec);
    if (son.durum === "ok" && son.md !== undefined) return { mdStatus: "ok", md: son.md };
    // Açık ayrım: taranmış PDF sağlam bir belgedir (gorsel), pdftotext'in
    // yokluğu ise ortam eksikliğidir (arac-yok). Eskiden ikincisi üçlü
    // zincirin son dalına, "bekliyor"a düşüyordu.
    switch (son.durum) {
      case "taranmis":
        return { mdStatus: "gorsel", mdHata: son.hata };
      case "arac-yok":
        return { mdStatus: "arac-yok", mdHata: son.hata };
      case "hata":
        return { mdStatus: "hata", mdHata: son.hata };
      default:
        return { mdStatus: "bekliyor", mdHata: son.hata };
    }
  }
  if (GORSEL_UZANTILAR.has(uz)) {
    return { mdStatus: "gorsel", mdHata: "görsel evrak; metin katmanı yok (OCR v1'de yok)" };
  }
  return { mdStatus: "desteklenmiyor", mdHata: `bilinmeyen uzantı: ${uz}` };
}
