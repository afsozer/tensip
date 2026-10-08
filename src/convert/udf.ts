// UDF → Markdown.
// UDF = ZIP(content.xml + sign.sgn); content.xml:
//   <template format_id="1.8">
//     <content><![CDATA[TAM METİN]]></content>
//     <properties pageFormat … />
//     <elements resolver="…"><paragraph><content startOffset="N" length="M"/></paragraph>…</elements>
//     <styles>…</styles>
//   </template>
// Metin CDATA havuzunda; paragraflar offset/length ile işaretlenir.
// length=1 paragraflar tek \n'dir → boş satır ayırıcı.

import { zipAc } from "./zip.js";

export interface UdfBilgi {
  formatId?: string;
  paragrafSayisi: number;
  toplamMetinUzunlugu: number;
}

/** UDF baytlarından içerik CDATA'sını çıkarır. */
export function udfIcerikCikar(
  zipVerisi: Buffer
): { metin: string; paragraflar: { baslangic: number; uzunluk: number }[]; bilgi: UdfBilgi } {
  const girdiler = zipAc(zipVerisi);
  const content = girdiler["content.xml"];
  if (content === undefined) {
    throw new Error("udf: content.xml yok — gerçek UDF değil");
  }
  const xml = content.toString("utf8");
  const acilis = xml.indexOf("<content><![CDATA[");
  if (acilis < 0) throw new Error("udf: CDATA başlangıcı yok");
  const metinBaslangic = acilis + "<content><![CDATA[".length;
  const kapanis = xml.indexOf("]]>", metinBaslangic);
  if (kapanis < 0) throw new Error("udf: CDATA kapanışı yok");
  const metin = xml.slice(metinBaslangic, kapanis);

  const paragraflar: { baslangic: number; uzunluk: number }[] = [];
  const elementsIdx = xml.indexOf("<elements");
  if (elementsIdx >= 0) {
    let kalip = xml.slice(elementsIdx);
    const bitis = kalip.indexOf("</elements>");
    if (bitis >= 0) kalip = kalip.slice(0, bitis);
    const re = /<content\b([^>]*)\/?>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(kalip)) !== null) {
      const ozellikler = Object.fromEntries([...m[1]!.matchAll(/([\w]+)\s*=\s*["']([^"']*)["']/g)].map((a) => [a[1]!, a[2]!]));
      if (ozellikler.startOffset === undefined || ozellikler.length === undefined) continue;
      const baslangic = Number(ozellikler.startOffset);
      const uzunluk = Number(ozellikler.length);
      if (!Number.isInteger(baslangic) || !Number.isInteger(uzunluk) || baslangic < 0 || uzunluk < 0 || baslangic + uzunluk > metin.length) {
        throw new Error("udf: geçersiz metin ofseti");
      }
      paragraflar.push({ baslangic, uzunluk });
    }
  }
  const fid = /format_id="([^"]+)"/.exec(xml);
  return {
    metin,
    paragraflar,
    bilgi: {
      formatId: fid?.[1],
      paragrafSayisi: paragraflar.length,
      toplamMetinUzunlugu: metin.length,
    },
  };
}

/** UDF → Markdown metni. */
export function udfToMd(zipVerisi: Buffer): { md: string; bilgi: UdfBilgi } {
  const { metin, paragraflar, bilgi } = udfIcerikCikar(zipVerisi);
  const satirlar: string[] = [];
  for (const p of paragraflar) {
    const dilim = metin.slice(p.baslangic, p.baslangic + p.uzunluk);
    if (dilim === "\n" || dilim.length === 0) {
      satirlar.push("");
      continue;
    }
    satirlar.push(dilim);
  }
  const md = (paragraflar.length === 0 ? metin : satirlar.join("\n"))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { md, bilgi };
}

/** Dosya gerçekten UDF mi? (ZIP magic + content.xml denetimi) */
export function udfMu(baytlar: Buffer): boolean {
  if (baytlar.length < 4) return false;
  if (baytlar.readUInt32LE(0) !== 0x04034b50) return false; // PK\x03\x04
  try {
    const g = zipAc(baytlar);
    return g["content.xml"] !== undefined;
  } catch {
    return false;
  }
}
