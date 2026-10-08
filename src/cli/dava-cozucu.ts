// `--dava "Birim Adı YYYY-SIRA"` → caseKey çözümü. Saf modül (I/O yok).
//
// T05 KURALI: BELİRSİZ EŞLEŞMEDE İLK ADAY SESSİZCE SEÇİLMEZ.
// Eski davranış `Array.prototype.find` ile ilk adayı döndürüyordu; registry'de
// "Denizli 1. Asliye Hukuk Mahkemesi 2026/928" ve "Denizli 2. Asliye Hukuk
// Mahkemesi 2026/928" birlikte dururken `--dava "Asliye Hukuk Mahkemesi
// 2026-928"` ikisini de tutuyor, hangisinin geldiği kayıtların sırasına
// kalıyordu. Sonucu yalnız yanlış liste değil, YANLIŞ DAVAYA İNDİRME olabilir.
//
// Yeni kural: her eşleşme yolu adaylarını SAYAR. Tek aday varsa çözülür, iki ve
// üzeri adayda INVALID_INPUT atılır ve adaylar kullanıcıya gösterilir. Kesin
// eşleşme (birim adı birebir) toleranslı eşleşmeyi yener — daraltılmış bir
// sorgu belirsizlik sayılmaz.
//
// Aday listesinde ham `caseKey` BASILMAZ: içinde NUL ayracı vardır ve terminale
// yapıştırılamaz; okunur biçim "Birim Adı Esas/No"dur.

import { CliHata } from "./istemci.js";

export interface DavaKaydi {
  caseKey: string;
  birimAdi: string;
  dosyaNo: string;
  klonYolu?: string;
}

const normalize = (s: string) => s.replace(/\u0000/g, " ");

// Gündelik yazım: "çamlık asliye hukuk", "Camlik 2026/928". Türkçe küçültme +
// aksan düşürme; "2026-928" ile "2026/928" aynı sözcük sayılır.
const sade = (s: string) =>
  normalize(s)
    .toLocaleLowerCase("tr")
    .replace(/ı/g, "i")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/(\d{4})-(\d+)/g, "$1/$2");
const sozcukler = (s: string) => sade(s).split(/[^\p{L}\p{N}/]+/u).filter((x) => x !== "");

function etiket(d: DavaKaydi): string {
  const birim = (d.birimAdi ?? "").trim();
  const no = (d.dosyaNo ?? "").trim();
  return birim === "" ? no : `${birim} ${no}`;
}

function belirsiz(ref: string, adaylar: DavaKaydi[]): never {
  const liste = adaylar.map(etiket).sort();
  throw new CliHata(
    "INVALID_INPUT",
    `"${ref}" ${adaylar.length} dosyaya birden uyuyor; hangisini istediğiniz belirsiz. Birim adını tam yazın ya da --caseKey kullanın. Adaylar: ${liste.join(" | ")}`,
    { adaylar: liste },
  );
}

/**
 * Referansı tek bir caseKey'e çözer.
 *
 * @throws CliHata INVALID_INPUT — birden çok aday (çıkış kodu 2)
 * @throws CliHata NOT_FOUND — hiç aday yok (çıkış kodu 1)
 */
export function davaRefCoz(davalar: DavaKaydi[], ref: string): string {
  const aranan = ref.trim();
  // klasör biçimi: "Birim Adı 2026-928"
  const m = /^(.*)\s(\d{4})-(\d+)$/.exec(aranan);
  if (m) {
    const birim = m[1]!;
    const esas = `${m[2]}/${m[3]}`;
    const kesin = davalar.filter((d) => d.birimAdi === birim && d.dosyaNo === esas);
    if (kesin.length === 1) return kesin[0]!.caseKey;
    if (kesin.length > 1) belirsiz(aranan, kesin);
    // tolerans: klasör adı birimi kırpılmış olabilir → içerme kontrolü.
    // Tek adayda eskisi gibi çözülür; birden çok adayda SESSİZ SEÇİM YOK.
    const yumusak = davalar.filter(
      (d) => normalize(d.caseKey).includes(birim) && d.dosyaNo === esas,
    );
    if (yumusak.length === 1) return yumusak[0]!.caseKey;
    if (yumusak.length > 1) belirsiz(aranan, yumusak);
  }
  const tam = davalar.filter((d) => normalize(d.caseKey) === aranan);
  if (tam.length === 1) return tam[0]!.caseKey;
  if (tam.length > 1) belirsiz(aranan, tam);
  // Son yol — serbest yazım: referansın HER sözcüğü kaydın sözcüklerinden
  // birinin başında geçmeli. Kural aynı: adaylar sayılır, ilk aday seçilmez.
  const istenen = sozcukler(aranan);
  if (istenen.length > 0) {
    const serbest = davalar.filter((d) => {
      const kayit = sozcukler(`${d.birimAdi} ${d.dosyaNo}`);
      // Rakam taşıyan sözcük (esas no, "3.") BİREBİR tutmalı: "2026/92" önekiyle
      // "2026/928"e çözülmek yanlış dosyayı açar.
      return istenen.every((i) => kayit.some((k) => (/\d/.test(i) ? k === i : k.startsWith(i))));
    });
    if (serbest.length === 1) return serbest[0]!.caseKey;
    if (serbest.length > 1) belirsiz(aranan, serbest);
  }
  throw new CliHata("NOT_FOUND", `dava bulunamadı: ${aranan}`);
}
