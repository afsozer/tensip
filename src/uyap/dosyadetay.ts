// Dosya detay verileri: safahat / taraflar / hesap.
//
// Önceki geliştirme oturumu safahat sarmalayıcısını portal yanıtından çıkardı.
// Bu denetimde yalnız yerel fixture/mock kullanıldı; son parser için canlı
// kabul testi yapılmadı. Hata kodları ve bilinmeyen sarmalayıcılar reddedilir.

import { UCLAR } from "./endpoints.js";
import { Hata, KODLAR } from "../core/errors.js";
import { satirlariDuzlestir } from "./schema.js";

export type DetaySatiri = Record<string, unknown>;

export interface DosyaDetayIstemci {
  json(yol: string, govde: unknown): Promise<{ durum: number; rc?: string; govde: string }>;
}

/** {dosyaId} ile sorgular; bilinen sarmalayıcıları satırlara açar. */
async function satirlarGetir(
  istemci: DosyaDetayIstemci,
  yol: string,
  dosyaId: string,
  ad: string
): Promise<DetaySatiri[]> {
  const yanit = await istemci.json(yol, { dosyaId });
  // UYAP kendi hız sınırı (canlı, 5 Eyl): "Bu işlem 60 dakikada 1 defa"
  if ((yanit.rc ?? "").startsWith("PRTL_GNL_1-1")) {
    throw new Hata(KODLAR.OTOMASYON_BUTCESI, `${ad}: UYAP bu sorguyu 60 dakikada 1 kez kabul eder (rc=${yanit.rc})`);
  }
  if (yanit.durum !== 200 || (yanit.rc !== undefined && yanit.rc !== "SUCCESS")) {
    throw new Hata(KODLAR.PORTAL_YANIT_BILINMIYOR, `${ad}: HTTP ${yanit.durum}, rc=${yanit.rc ?? "-"}`);
  }
  let ham: unknown;
  try {
    ham = JSON.parse(yanit.govde);
  } catch {
    throw new Hata(KODLAR.PORTAL_YANIT_BILINMIYOR, `${ad} yanıtı JSON değil`, { ham: yanit.govde.slice(0, 300) });
  }
  if (ham !== null && typeof ham === "object" && !Array.isArray(ham)) {
    const kayit = ham as Record<string, unknown>;
    const anahtarlar = Object.keys(kayit);
    // hata zarfı ({"errorCode","error"}) — satır değil
    if (anahtarlar.includes("errorCode") || anahtarlar.includes("error")) {
      throw new Hata(KODLAR.PORTAL_YANIT_BILINMIYOR, `${ad}: portal doğrulama hatası`, { ham: yanit.govde.slice(0, 200) });
    }
    // Sarmalayıcı açma: yalnız bilinen adlar; rastgele dizi alanı veri sayılmaz.
    // (5 Eyl canlı: {"safahatlar":[...], ...} çok-anahtarlı da gelebiliyor —
    // 17,7 KB'lık yanıt tek-anahtar varsayımına takıldı.)
    const oncelikli = ["safahatlar", "taraflar", "hesap", "rows", "data", "list", "items", "tumEvraklar"];
    for (const a of oncelikli) {
      if (Array.isArray(kayit[a])) {
        ham = kayit[a];
        break;
      }
    }
    if (!Array.isArray(ham)) {
      throw new Hata(KODLAR.PORTAL_YANIT_BILINMIYOR, `${ad}: bilinmeyen yanıt sarmalayıcısı`);
    }
  }
  return satirlariDuzlestir(ham) as DetaySatiri[];
}

/** Dosya safahatı (kronolojik işlem geçmişi). */
export async function safahatiGetir(istemci: DosyaDetayIstemci, dosyaId: string): Promise<DetaySatiri[]> {
  return satirlarGetir(istemci, UCLAR.dosyaSafahat.yol, dosyaId, "safahat");
}

/** Dosya tarafları. */
export async function taraflariGetir(istemci: DosyaDetayIstemci, dosyaId: string): Promise<DetaySatiri[]> {
  return satirlarGetir(istemci, UCLAR.dosyaTaraf.yol, dosyaId, "taraf");
}

/** Dosya hesap bilgileri (icra: hesap dökümü/bakiye). */
export async function hesabiGetir(istemci: DosyaDetayIstemci, dosyaId: string): Promise<DetaySatiri[]> {
  return satirlarGetir(istemci, UCLAR.dosyaHesap.yol, dosyaId, "hesap");
}
