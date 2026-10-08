// PDF metin katmanı tespiti + çıkarımı.
// Kural (uyap_tiff_pdf_guide):
//  - Metin katmanı VAR → çıkar (pdftotext varsa onu kullan).
//  - Taranmış (görüntü) PDF'te metin yok → çağıran bunu "gorsel" olarak
//    işaretler; ajan PDF'i görsel olarak okur. OCR v1'de yok.
//  - pdftotext yok → "arac-yok". Bu, belge hakkında bir hüküm DEĞİLDİR;
//    ortam eksikliğidir ve çağıran tarafından ayrı gösterilir.

import { spawnSync } from "node:child_process";

export interface PdfSonuc {
  durum: "ok" | "taranmis" | "arac-yok" | "hata";
  md?: string;
  hata?: string;
}

/** Yalnız kaba ipucu; sıkıştırılmış PDF için güvenilir değildir. Dönüşümde kullanılmaz. */
export function pdfMetinKatlmaniVarMi(baytlar: Buffer): boolean {
  const s = baytlar.toString("latin1");
  // /Font ve /Contents objeleri metin katmanının habercisi; sadece görüntü
  // PDF'lerde /DCTDecode (JPEG) + /Image baskındır ve metin operatörü yoktur
  const fontVar = s.includes("/Font");
  const metinOperatoru = /\b(BT|Tj|TJ|Td|Tm)\b/.test(s);
  const resimBaskin = (s.match(/\/Image/g)?.length ?? 0) > (s.match(/\/Font/g)?.length ?? 0);
  return (fontVar && metinOperatoru) && !resimBaskin;
}

function pdftotextAra(): string | null {
  const yollar = ["/opt/homebrew/bin/pdftotext", "/usr/local/bin/pdftotext", "/usr/bin/pdftotext"];
  for (const y of yollar) {
    try {
      const r = spawnSync(y, ["-v"], { timeout: 3000 });
      if (r.status === 0 || (r.stderr?.toString().includes("pdftotext") ?? false)) return y;
    } catch {
      /* yok */
    }
  }
  return null;
}

let bellek: { deger: string | null } | undefined;

/**
 * pdftotext yolunu bulur.
 *
 * YALNIZ POZİTİF SONUÇ BELLEKLENİR. Bulunan yol süreç ömrü boyunca saklanır
 * (eskiden her PDF için üç spawnSync çalışıyordu, o kazanç korunur); "yok"
 * cevabı ise HER ÇAĞRIDA yeniden ölçülür. Gerekçesi davranışsaldır: UI
 * `arac-yok` durumunda "poppler kurun, sonra yeniden eşitleyin" diyor.
 * Olumsuz sonuç belleklenirse bu talimat motor yeniden başlatılmadan
 * işlemez — kurulum yapılır, eşitleme yine `arac-yok` döner.
 *
 * `bellekle = false` belleği TAMAMEN atlar. Tanılama ("pdftotext şimdi var
 * mı?") bu yolu kullanır.
 *
 * `ara` yalnız test kancasıdır; üretimde sabit yol listesi taranır.
 */
export function pdftotextBul(bellekle = true, ara: () => string | null = pdftotextAra): string | null {
  if (!bellekle) {
    const taze = ara();
    bellek = taze === null ? undefined : { deger: taze };
    return taze;
  }
  if (bellek === undefined) {
    const bulunan = ara();
    if (bulunan === null) return null; // olumsuz sonuç belleklenmez
    bellek = { deger: bulunan };
  }
  return bellek.deger;
}

export interface PdfSecenek {
  /** Test/tanılama kancası. Verilirse bellekleme HİÇ kullanılmaz. */
  aracBul?: () => string | null;
}

/** PDF → Markdown; tarama/araç yokluğu düzgün işaretlenir. */
export function pdfToMd(baytlar: Buffer, kaynakDosya?: string, sec: PdfSecenek = {}): PdfSonuc {
  const arac = sec.aracBul !== undefined ? sec.aracBul() : pdftotextBul();
  if (!arac) {
    return { durum: "arac-yok", hata: "pdftotext bulunamadı (brew install poppler)" };
  }
  // Text operators may be compressed. Let the PDF parser inspect actual content.
  const r = spawnSync(arac, ["-layout", kaynakDosya ?? "-", "-"], {
    input: kaynakDosya === undefined ? baytlar : undefined,
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) {
    return { durum: "hata", hata: `pdftotext başarısız: ${r.stderr?.toString().slice(0, 200)}` };
  }
  const metin = r.stdout.toString("utf8");
  const md = metin
    .split(/\r?\n/)
    .map((s) => s.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
  if (!md) return { durum: "taranmis", hata: "PDF'ten metin çıkarılamadı; görüntü/OCR incelemesi gerekebilir" };
  return { durum: "ok", md };
}
