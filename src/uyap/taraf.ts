// Portal taraf satırlarının toleranslı çözümü (P18).
//
// ROL ETİKETİ PORTALDAN GELİR — BURADA SABİT ROL EŞLEME TABLOSU YOKTUR.
// Ölçüldü (12 Eylül, canlı portal): icra dosyasında "Alacaklı"/"Borçlu",
// ceza (çocuk) dosyasında "Katılan"/"Suça Sürüklenen Çocuk". "icra →
// alacaklı/borçlu, hukuk → davacı/davalı" biçiminde sabit bir tablo ceza ve
// çocuk dosyalarında YANLIŞ olur. `rol` alanı ne diyorsa aynen taşınır;
// bilinmeyen bir rol adı da olduğu gibi geçer, kategoriye zorlanmaz.
//
// Alan adları toleranslıdır: canlı yanıt `adi`/`rol`/`vekil` gönderiyor, mock
// ve eski gözlemler `isim`+`soyad`/`sifat` gönderiyor. İkisi de yutulur;
// tanınmayan satır (adı olmayan) SESSİZCE ATLANIR — bir satırın çözülememesi
// dosyanın taraf listesini düşürmez.

import { alanAl } from "./schema.js";

export interface TarafBilgisi {
  /** Portalın verdiği ad (kişi ya da kurum). */
  adi: string;
  /** Portalın verdiği rol etiketi; boş olabilir. Sabit tabloya çevrilmez. */
  rol: string;
  /** Vekil adı; liste satırında GÖSTERİLMEZ, yalnız kayıtta durur. */
  vekil?: string;
}

const AD_ADLARI = ["adi", "ad", "adSoyad", "adiSoyadi", "isim", "kisiKurumAdi", "tarafAdi", "unvan"];
const SOYAD_ADLARI = ["soyad", "soyadi"];
const ROL_ADLARI = ["rol", "rolAdi", "rolAciklama", "sifat", "sifatAciklama", "tarafRolu", "tarafSifati"];
const VEKIL_ADLARI = ["vekil", "vekilAdi", "vekilAdSoyad"];

/** Verilen adlardan İLK BOŞ OLMAYAN değeri döndürür (alanAl boş dizeyi de kabul eder). */
function ilkMetin(kayit: Record<string, unknown>, adlar: string[]): string {
  for (const a of adlar) {
    const v = alanAl(kayit, [a]);
    const s = typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
    if (s !== "") return s;
  }
  return "";
}

/** "AYŞE" + "YILMAZ" → "AYŞE YILMAZ"; ad zaten soyadı içeriyorsa tekrarlamaz. */
function adBirlestir(ad: string, soyad: string): string {
  if (soyad === "") return ad;
  if (ad === "") return soyad;
  const buyuk = (s: string) => s.toLocaleUpperCase("tr-TR");
  return buyuk(ad).includes(buyuk(soyad)) ? ad : `${ad} ${soyad}`;
}

/** Tek satır → taraf; adı çözülemeyen satır için null. */
export function tarafCoz(satir: Record<string, unknown>): TarafBilgisi | null {
  const adi = adBirlestir(ilkMetin(satir, AD_ADLARI), ilkMetin(satir, SOYAD_ADLARI));
  if (adi === "") return null;
  const rol = ilkMetin(satir, ROL_ADLARI);
  const vekil = ilkMetin(satir, VEKIL_ADLARI);
  return vekil === "" ? { adi, rol } : { adi, rol, vekil };
}

/** Portal satır dizisi → taraf listesi. Çözülemeyen satırlar atlanır. */
export function taraflariCoz(satirlar: readonly unknown[]): TarafBilgisi[] {
  const sonuc: TarafBilgisi[] = [];
  for (const s of satirlar) {
    if (s === null || typeof s !== "object" || Array.isArray(s)) continue;
    const t = tarafCoz(s as Record<string, unknown>);
    if (t !== null) sonuc.push(t);
  }
  return sonuc;
}
