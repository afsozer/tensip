// Mahkeme birim cache'i.
//
// DOĞRULANMIŞ portal akışı (PS betiği):
//   her yargiTuru (0,1,2) için:
//     yargiBirimleriSorgula_brd.ajx {yargiTuru} → öğe listesi, HER ÖĞEDE `tablo` alanı
//     her tablo için: avukat_mahkemeleri_sorgula.ajx {yargiBirimi: tablo} → [{birimAdi, birimId}]
//   İlk çalıştırmada ~25 istek ödenir; sonra diskteki önbellekten okunur.

import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { yazJsonAtomik } from "../store/fsops.js";
import { UCLAR, YARGI_TURLERI } from "./endpoints.js";
import { UyapIstemci } from "./client.js";
import { birimSatiriAyristir, satirlariDuzlestir, alanAl } from "./schema.js";
import { Hata, KODLAR } from "../core/errors.js";

export interface BirimKaydi {
  birimId: string;
  birimAdi: string;
  yargiTuru: string;
  /** yargiBirimleriSorgula'nın döndüğü tablo kodu (search'te birimTuru2) */
  tablo?: string;
}

export interface BirimOnbellek {
  surum: 1;
  guncellenmeAt: string;
  birimler: Record<string, BirimKaydi>; // anahtar: normalleştirilmiş birim adı
  tabloKodlari: Record<string, string[]>; // yargiTuru → tablo kodları
}

const TUR_ADI: Record<string, string> = {
  "0": "Hukuk",
  "1": "Ceza",
  "2": "İdari",
};

function anahtarla(birimAdi: string): string {
  return birimAdi
    .toLocaleLowerCase("tr-TR")
    .replace(/\s+/g, " ")
    .trim();
}

export class BirimKatalog {
  private istemci: UyapIstemci;
  private dosya: string;
  private onbellek?: BirimOnbellek;
  private tabloKodlar: Record<string, string[]> = {};

  constructor(istemci: UyapIstemci, dosya: string) {
    this.istemci = istemci;
    this.dosya = dosya;
  }

  private oku(): BirimOnbellek {
    if (this.onbellek) return this.onbellek;
    try {
      const ham = JSON.parse(readFileSync(this.dosya, "utf8"));
      if (ham && ham.surum === 1 && typeof ham.birimler === "object") {
        this.onbellek = ham as BirimOnbellek;
        this.tabloKodlar = ham.tabloKodlari ?? {};
        return this.onbellek;
      }
    } catch {
      /* dosya yok: boş katalog */
    }
    this.onbellek = { surum: 1, guncellenmeAt: "", birimler: {}, tabloKodlari: {} };
    return this.onbellek;
  }

  private yaz(): void {
    const ob = this.oku();
    mkdirSync(dirname(this.dosya), { recursive: true });
    ob.guncellenmeAt = new Date().toISOString();
    ob.tabloKodlari = this.tabloKodlar;
    yazJsonAtomik(this.dosya, ob);
  }

  /** Bir yargi türünün TÜM tablo kodları için mahkemeleri çeker. */
  async turlariCek(yargiTuru: string): Promise<BirimKaydi[]> {
    const ob = this.oku();
    const eklenen: BirimKaydi[] = [];

    // 1) yargiBirimleriSorgula: yargiTuru → [{tablo}, ...] (her öğede tablo alanı)
    const turYanit = await this.istemci.json(UCLAR.yargiTurleri.yol, { yargiTuru });
    const turSatirlar = satirlariDuzlestir(belki(turYanit.govde));
    const tablolar: string[] = [];
    for (const s of turSatirlar) {
      const kayit = s as Record<string, unknown>;
      const tablo = alanAl(kayit, ["tablo", "kod", "tabloKod", "birimTuru", "id", "value"]);
      if (typeof tablo === "string" && tablo.length > 0) tablolar.push(tablo);
    }
    if (tablolar.length === 0) {
      throw new Hata(
        KODLAR.PORTAL_YANIT_BILINMIYOR,
        "yargi türü tablo kodları çözülemedi (tablo alanı yok)",
        { ham: turYanit.govde.slice(0, 800) }
      );
    }
    this.tabloKodlar[yargiTuru] = tablolar;

    // 2) her tablo için mahkemeler
    for (const tablo of tablolar) {
      const mahYanit = await this.istemci.json(UCLAR.mahkemeler.yol, { yargiBirimi: tablo });
      const mahSatirlar = satirlariDuzlestir(belki(mahYanit.govde));
      for (const s of mahSatirlar) {
        const kayit = birimSatiriAyristir(s as Record<string, unknown>);
        if (!kayit) continue;
        const kaydi: BirimKaydi = {
          birimId: kayit.birimId,
          birimAdi: kayit.birimAdi,
          yargiTuru,
          tablo,
        };
        ob.birimler[anahtarla(kayit.birimAdi)] = kaydi;
        eklenen.push(kaydi);
      }
    }
    this.yaz();
    return eklenen;
  }

  /** Birim adını birimId'ye çevirir; gerekirse portaldan çeker. */
  yerelListe(): { birimler: BirimKaydi[]; guncellenmeAt: string } {
    const ob = this.oku();
    return { birimler: Object.values(ob.birimler).sort((a, b) => a.birimAdi.localeCompare(b.birimAdi, "tr")), guncellenmeAt: ob.guncellenmeAt };
  }

  async coz(birimAdi: string, yargiTuru?: string): Promise<BirimKaydi> {
    const ob = this.oku();
    const a = anahtarla(birimAdi);
    const var_ = ob.birimler[a];
    if (var_) return var_;
    const turlar = yargiTuru !== undefined ? [yargiTuru] : Object.values(YARGI_TURLERI);
    for (const tur of turlar) {
      try {
        await this.turlariCek(tur);
      } catch (e) {
        if (yargiTuru !== undefined || (e instanceof Hata && [KODLAR.OTURUM_BITTI, KODLAR.LOGIN_REQUIRED, KODLAR.IS_BUSY, KODLAR.OTOMASYON_BUTCESI].some(code => code === e.code))) throw e;
        // diğer türü dene
      }
      const b = this.oku().birimler[a];
      if (b) return b;
    }
    throw new Hata(KODLAR.NOT_FOUND, `birim bulunamadı: ${birimAdi}`);
  }

  /** Mahkeme adının yargi türünü tahmin eder (bilinmiyorsa). */
  static turTahminEt(birimAdi: string): string {
    const n = birimAdi.toLocaleLowerCase("tr-TR");
    if (n.includes("iş mahkemesi") || n.includes("aile") || n.includes("hukuk") || n.includes("sulh")) return YARGI_TURLERI.HUKUK;
    if (n.includes("ceza") || n.includes("çocuk") || n.includes("cocuk")) return YARGI_TURLERI.CEZA;
    if (n.includes("idare") || n.includes("vergi")) return YARGI_TURLERI.IDARI;
    return YARGI_TURLERI.HUKUK;
  }
}

function belki(metin: string): unknown {
  try {
    return JSON.parse(metin);
  } catch {
    return { ham: metin };
  }
}
