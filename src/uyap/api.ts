// UYAP API yüzeyi — CLI/RPC/orkestratörün kullandığı yüksek düzey işlemler.
// Yalnızca doğrulanmış uçlar kullanılır; sözleşme değerleri kullanıcı
// tarafından gerçek portala karşı doğrulanmış betikten (uyap skill) gelir.

import { UyapIstemci } from "./client.js";
import { UCLAR, YARGI_TURLERI } from "./endpoints.js";
import {
  dosyaSatiriAyristir,
  evrakSatiriAyristir,
  satirlariDuzlestir,
  EvrakSatiri,
  DosyaSatiri,
  BirimSatiri,
} from "./schema.js";
import { BirimKatalog } from "./birimler.js";

export interface DavaAramasi {
  birimAdi: string;
  esasYil: string;
  esasSira: string;
  /**
   * Kapsam — v1'de yalnız DOĞRULANMIŞ değer kullanılır: dosyaDurumKod=0
   * (durum filtresi yok; açık+kapalı birlikte). "acik"/"kapali" biçimsel
   * olarak kabul edilir ama portala yine 0 gider (sonuçta dosyaDurum alanı
   * ayırt etmeye yetar).
   */
  kapsam?: "acik" | "kapali" | "hepsi";
  sayfaBuyuklugu?: number;
}

export const DOSYA_DURUM_KOD = {
  /** Doğrulanmış: durum filtresiz arama (PS betiğindeki değer). */
  hepsi: 0,
} as const;

export class UyapApi {
  istemci: UyapIstemci;
  birimler: BirimKatalog;

  constructor(istemci: UyapIstemci, birimler: BirimKatalog) {
    this.istemci = istemci;
    this.birimler = birimler;
  }

  /** Dosya arama — doğrulanmış uç: search_phrase_detayli.ajx */
  async davalarim(arama: DavaAramasi): Promise<DosyaSatiri[]> {
    const birim = await this.birimler.coz(arama.birimAdi);
    const tur = birim.yargiTuru;
    const sonuc: DosyaSatiri[] = [];
    let sayfa = 1;
    const boyut = arama.sayfaBuyuklugu ?? 500; // doğrulanmış değer
    for (;;) {
      const yanit = await this.istemci.json(UCLAR.dosyaAra.yol, {
        dosyaDurumKod: DOSYA_DURUM_KOD.hepsi,
        pageSize: boyut,
        pageNumber: sayfa,
        dosyaYil: arama.esasYil,
        dosyaSira: arama.esasSira,
        birimId: birim.birimId,
        birimTuru2: birim.tablo ?? tur,
        birimTuru3: tur,
      });
      const satirlar = satirlariDuzlestir(belki(yanit.govde));
      if (satirlar.length === 0) break;
      let buSayfada = 0;
      for (const s of satirlar) {
        const d = dosyaSatiriAyristir(s as Record<string, unknown>);
        if (d) {
          sonuc.push(d);
          buSayfada++;
        }
      }
      if (buSayfada === 0) break;
      if (satirlar.length < boyut) break;
      sayfa++;
      if (sayfa > 50) break; // emniyet sınırı
    }
    return sonuc;
  }

  /** Tüm dosyaların (birim bazlı sayfalı) evraklarını listeler. */
  async evraklariListele(dosyaId: string): Promise<{ evraklar: EvrakSatiri[]; sayfaToplami: number }> {
    const evraklar: EvrakSatiri[] = [];
    let sayfa = 1;
    let sayfaToplami = 1;
    for (;;) {
      const yanit = await this.istemci.json(UCLAR.evrakListele.yol, {
        dosyaId,
        pageNumber: sayfa,
      });
      const obje = belki(yanit.govde) as Record<string, unknown>;
      const satirlar = satirlariDuzlestir(obje);
      let buSayfada = 0;
      for (const s of satirlar) {
        const e = evrakSatiriAyristir(s as Record<string, unknown>);
        if (e) {
          evraklar.push(e);
          buSayfada++;
        }
      }
      const pt = obje["pageTotal"];
      if (typeof pt === "number" && pt > 0) sayfaToplami = pt;
      if (buSayfada === 0) break;
      if (sayfa >= sayfaToplami) break; // doğrulanmış: pageTotal'a ulaşınca dur
      sayfa++;
      if (sayfa > sayfaToplami + 5) break; // emniyet
    }
    return { evraklar, sayfaToplami };
  }

}

function belki(metin: string): unknown {
  try {
    return JSON.parse(metin);
  } catch {
    return { ham: metin };
  }
}

export { YARGI_TURLERI, evrakSatiriAyristir, dosyaSatiriAyristir, satirlariDuzlestir, BirimSatiri };
