// Toleranslı şema ayrıştırma.
//
// UYAP yanıt biçimleri alan adı bazında değişken (sürüm, modül, HTML
// zarfı). Bu katman:
//  1. JSON gövdeyi güvenle çözer (JSON değilse hata).
//  2. "İç içe dizi" ([[rows]]) desenlerini düzleştirir.
//  3. Kayıt alanlarını bilinen alternatif anahtar adlarından çeker.
//  4. Bilinmeyen biçimde PORTAL_YANIT_BILINMIYOR hata kodu üretir; ajan
//     ham gövdeyi details'ten görebilir.

import { Hata, KODLAR } from "../core/errors.js";

/** Yanıt içinde JSON dizisi dizi (ve herhangi bir derinlikte) satır listesi bulur. */
export function satirlariDuzlestir(veri: unknown): unknown[] {
  if (Array.isArray(veri)) {
    const out: unknown[] = [];
    const yigina = [...veri] as unknown[];
    while (yigina.length > 0) {
      const o = yigina.shift();
      if (Array.isArray(o)) yigina.unshift(...o);
      else out.push(o);
    }
    return out.filter((o) => o !== null && typeof o === "object");
  }
  if (veri !== null && typeof veri === "object") {
    const kayit = veri as Record<string, unknown>;
    // {tumEvraklar: {ana:[...], ekler:[...]}} — GRUP OBJESİ (doğrulanmış portal biçimi)
    const gruplar = kayit["tumEvraklar"] ?? kayit["son20Evrak"];
    if (gruplar !== undefined && !Array.isArray(gruplar) && typeof gruplar === "object") {
      const out: unknown[] = [];
      for (const v of Object.values(gruplar as Record<string, unknown>)) {
        if (Array.isArray(v)) out.push(...satirlariDuzlestir(v));
      }
      if (out.length > 0) return out;
    }
    // {tumEvraklar: [...]} ya da {rows: [...]} gibi alanlar
    for (const anahtar of ["tumEvraklar", "son20Evrak", "rows", "data", "list", "items"]) {
      const v = kayit[anahtar];
      if (Array.isArray(v)) return satirlariDuzlestir(v);
    }
  }
  throw new Hata(
    KODLAR.PORTAL_YANIT_BILINMIYOR,
    "portal yanıtı beklenen satır dizisi değil",
    { ham: kisaYaz(veri) }
  );
}

/** Bir kayıttan verilen adlar sırayla denenen alan değerini çeker. */
export function alanAl(
  kayit: Record<string, unknown>,
  adlar: string[]
): unknown {
  for (const a of adlar) {
    if (kayit[a] !== undefined && kayit[a] !== null) return kayit[a];
    // küçük/büyük harf duyarsız arama
    const lc = a.toLowerCase();
    const eslesen = Object.keys(kayit).find((k) => k.toLowerCase() === lc);
    if (eslesen !== undefined && kayit[eslesen] !== undefined && kayit[eslesen] !== null) {
      return kayit[eslesen];
    }
  }
  return undefined;
}

export function kisaYaz(veri: unknown, sinir = 2000): string {
  try {
    const s = JSON.stringify(veri);
    if (s === undefined) return String(veri);
    return s.length > sinir ? s.slice(0, sinir) + "…" : s;
  } catch {
    return String(veri);
  }
}

/** Evrak satırı — UYAP list_dosya_evraklar satır alanları (bilinen adlar). */
export interface EvrakSatiri {
  evrakId: string;
  tur: string;
  gonderen: string;
  tarih: string;
  birimEvrakNo?: string;
  ekEvrak?: boolean;
  anaEvrakId?: string;
  dosyaAdi?: string;
  ham: Record<string, unknown>;
}

const EVRAK_ID_ADLARI = ["evrakId", "evrakID", "id", "evrakNo", "evrak_id"];
const TUR_ADLARI = ["tur", "evrakTuru", "evrakTurAdi", "turAdi", "evrakTuruAciklama", "dosyaTuru"];
const GONDEREN_ADLARI = ["gonderen", "gonderenBirim", "gonderenAdi", "kaynak", "islemYapanBirim"];
const TARIH_ADLARI = ["onaylandigiTarih", "tarih", "evrakTarihi", "tarihSTR", "kayitTarihi", "yuklenmeTarihi"];
const EVRAK_NO_ADLARI = ["birimEvrakNo", "evrakSayisi", "siraNo", "birimEvrakSayisi", "evrakNo"];
const DOSYA_ADI_ADLARI = ["dosyaAdi", "dosyaAd", "ad", "evrakAdi"];

export function evrakSatiriAyristir(ham: Record<string, unknown>): EvrakSatiri | null {
  const evrakId = alanAl(ham, EVRAK_ID_ADLARI);
  if (typeof evrakId !== "string" || evrakId.length < 4) return null;
  return {
    evrakId: evrakId,
    tur: str(ham, TUR_ADLARI) ?? "Bilinmeyen",
    gonderen: str(ham, GONDEREN_ADLARI) ?? "—",
    tarih: str(ham, TARIH_ADLARI) ?? "",
    birimEvrakNo: str(ham, EVRAK_NO_ADLARI),
    dosyaAdi: str(ham, DOSYA_ADI_ADLARI),
    ham,
  };
}

function str(kayit: Record<string, unknown>, adlar: string[]): string | undefined {
  const v = alanAl(kayit, adlar);
  if (typeof v === "string") return v;
  if (v !== undefined) return String(v);
  return undefined;
}

/** Dosya arama satırı */
export interface DosyaSatiri {
  dosyaId: string;
  birimAdi: string;
  birimId?: string;
  esasNo: string; // "2026/928"
  dosyaDurum?: string;
  dosyaTur?: string;
  ham: Record<string, unknown>;
}

const DOSYA_ID_ADLARI = ["dosyaId", "dosyaID", "dosya_id"];
const BIRIM_ADI_ADLARI = ["birimAdi", "mahkemeAdi", "birim", "islemYapanBirim"];
const BIRIM_ID_ADLARI = ["birimId", "birimID", "birim_id"];
const ESAS_ADLARI = ["esasNo", "esasNumarasi", "esas", "dosyaNo", "dosyaNumarasi"];
const DURUM_ADLARI = ["dosyaDurum", "dosyaDurumu", "durumAdi", "durum", "dosyaDurumuString"];
const TUR_ADLARI2 = ["dosyaTurKodAciklama", "dosyaTuru", "turAciklama", "dosyaTur"];

export function dosyaSatiriAyristir(ham: Record<string, unknown>): DosyaSatiri | null {
  const dosyaId = alanAl(ham, DOSYA_ID_ADLARI);
  if (typeof dosyaId !== "string" || dosyaId.length < 4) return null;
  const esasHam = alanAl(ham, ESAS_ADLARI);
  let esasNo = typeof esasHam === "string" ? esasHam : "";
  // "2026/928" biçiminde mi? yoksa yil+sira alanlarından kur
  if (!/^\d{4}\/\d+/.test(esasNo)) {
    const yil = alanAl(ham, ["dosyaYil", "esasYil"]);
    const sira = alanAl(ham, ["dosyaSira", "esasSira"]);
    if (typeof yil === "string" && typeof sira === "string" && yil.length === 4 && sira.length > 0) {
      esasNo = `${yil}/${sira}`;
    }
  }
  if (!esasNo) return null;
  return {
    dosyaId,
    birimAdi: str(ham, BIRIM_ADI_ADLARI) ?? "—",
    birimId: str(ham, BIRIM_ID_ADLARI),
    esasNo,
    dosyaDurum: str(ham, DURUM_ADLARI),
    dosyaTur: str(ham, TUR_ADLARI2),
    ham,
  };
}

/** Mahkeme satırı */
export interface BirimSatiri {
  birimId: string;
  birimAdi: string;
  ham: Record<string, unknown>;
}

export function birimSatiriAyristir(ham: Record<string, unknown>): BirimSatiri | null {
  const birimId = alanAl(ham, BIRIM_ID_ADLARI);
  const birimAdi = alanAl(ham, BIRIM_ADI_ADLARI);
  if (typeof birimId === "string" && typeof birimAdi === "string" && birimId.length > 0) {
    return { birimId, birimAdi, ham };
  }
  return null;
}
