// Duruşma/keşif takvimi.
//
// Uç sözleşmesi 5 Eyl 2026'da GERÇEK portalden doğrulandı (SPA paketindeki
// çağrı + tek canlı doğrulama): POST /avukat_durusma_sorgula_brd.ajx,
// gövde {baslangicTarihi, bitisTarihi} — biçim dd.MM.yyyy (SPA dateFormat
// varsayılanı; pano penceresi bugün → +7 gün). Yanıt 200 + uyapfc_rc:SUCCESS
// + DÜZ DİZİ (sarmalayıcı yok): [{kayitId, dosyaId, dosyaNo, birimId,
// yerelBirimAd, tarihSaat ("2026-09-09 11:40:00.0"), islemTuru,
// islemTuruAciklama, islemSonucuAciklama, dosyaTaraflari:[...], ...}].

import { UCLAR } from "./endpoints.js";
import { Hata, KODLAR } from "../core/errors.js";

export interface DurusmaTarafi {
  isim: string;
  soyad: string;
  sifat: string;
  isVekil: boolean;
}

export interface DurusmaKaydi {
  kayitId: number;
  dosyaId: string;
  dosyaNo: string;
  dosyaTurKod: number;
  dosyaTurKodAciklama: string;
  birimId: string;
  yerelBirimAd: string;
  /** "2026-09-09 11:40:00.0" — UYAP biçimi; gösterimde yeniden biçimlenir. */
  tarihSaat: string;
  islemTuru: number;
  islemTuruAciklama: string;
  islemSonucuAciklama: string;
  dosyaTaraflari: DurusmaTarafi[];
}

/** SPA dateFormat varsayılanı: dd.MM.yyyy. */
export function durusmaTarihiBiçimle(d: Date): string {
  const g = String(d.getDate()).padStart(2, "0");
  const a = String(d.getMonth() + 1).padStart(2, "0");
  const y = d.getFullYear();
  return `${g}.${a}.${y}`;
}

export interface DurusmaIstemci {
  json(yol: string, govde: unknown): Promise<{ durum: number; rc?: string; govde: string }>;
}

/**
 * Yaklaşan duruşma/keşif günleri — `gun` gün penceresi (varsayılan 7, SPA
 * paneliyle aynı). Satırlar tarih-saat artan sırada döner.
 */
export async function durusmalariSorgula(istemci: DurusmaIstemci, gun = 7): Promise<DurusmaKaydi[]> {
  const gunSayisi = Math.min(31, Math.max(1, Math.round(gun)));
  const bugun = new Date();
  const bitis = new Date(bugun.getTime() + gunSayisi * 86_400_000);
  const yanit = await istemci.json(UCLAR.durusmaSorgula.yol, {
    baslangicTarihi: durusmaTarihiBiçimle(bugun),
    bitisTarihi: durusmaTarihiBiçimle(bitis),
  });
  let ham: unknown;
  try {
    ham = JSON.parse(yanit.govde);
  } catch {
    throw new Hata(KODLAR.PORTAL_YANIT_BILINMIYOR, "duruşma yanıtı JSON değil", { ham: yanit.govde.slice(0, 300) });
  }
  if (!Array.isArray(ham)) {
    throw new Hata(KODLAR.PORTAL_YANIT_BILINMIYOR, "duruşma yanıtı dizi değil (sarmalayıcı beklenmedik)", {
      ham: yanit.govde.slice(0, 300),
    });
  }
  const satirlar: DurusmaKaydi[] = ham
    .filter((r): r is Record<string, unknown> => r !== null && typeof r === "object")
    .map((r) => ({
      kayitId: Number(r["kayitId"] ?? 0),
      dosyaId: String(r["dosyaId"] ?? ""),
      dosyaNo: String(r["dosyaNo"] ?? ""),
      dosyaTurKod: Number(r["dosyaTurKod"] ?? 0),
      dosyaTurKodAciklama: String(r["dosyaTurKodAciklama"] ?? ""),
      birimId: String(r["birimId"] ?? ""),
      yerelBirimAd: String(r["yerelBirimAd"] ?? ""),
      tarihSaat: String(r["tarihSaat"] ?? ""),
      islemTuru: Number(r["islemTuru"] ?? 0),
      islemTuruAciklama: String(r["islemTuruAciklama"] ?? ""),
      islemSonucuAciklama: String(r["islemSonucuAciklama"] ?? ""),
      dosyaTaraflari: Array.isArray(r["dosyaTaraflari"])
        ? (r["dosyaTaraflari"] as Array<Record<string, unknown>>).map((t) => ({
            isim: String(t["isim"] ?? ""),
            soyad: String(t["soyad"] ?? ""),
            sifat: String(t["sifat"] ?? ""),
            isVekil: t["isVekil"] === true,
          }))
        : [],
    }));
  // kronolojik sıra: en yakın duruşma önce
  satirlar.sort((a, b) => a.tarihSaat.localeCompare(b.tarihSaat));
  return satirlar;
}
