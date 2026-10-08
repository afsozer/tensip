// davalarim.json — tüm davaların kaydı (registry).
// Anahtar birim + esas no'dur;
// ilave alanlar başlarına eklenir (geriye dönük uyumluluk).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { yazJsonAtomik } from "./fsops.js";

export interface TarafKaydi {
  adi: string;
  /** P18 — portalın verdiği rol etiketi ("Alacaklı", "Suça Sürüklenen Çocuk"…).
   *  Opsiyoneldir: rol taşımayan eski kayıtlar olduğu gibi okunur. Sabit bir
   *  rol eşleme tablosuyla ÜRETİLMEZ, portaldan gelir (src/uyap/taraf.ts). */
  rol?: string;
  vekil?: string;
}

export interface DavaKaydi {
  /** birim\u0000esas — kalıcı dava anahtarı */
  caseKey: string;
  portal: "avukat";
  kaynak: string[];
  dosyaNo: string;
  birimAdi: string;
  birimId: string;
  group: string; // Hukuk / Ceza / İdari
  kod: string;
  yargiTuru: string;
  dosyaTur?: string;
  dosyaDurum?: string;
  isIcra: boolean;
  isCbs: boolean;
  hesap?: string;
  kapsam: string;
  portalGoruldu: string;
  taraflar?: TarafKaydi[];
  taraflarAt?: string;
  /** bizim ilavelerimiz */
  klonYolu?: string;
  klonAt?: string;
  sonEvrakSayisi?: number;
  sonEvrakAt?: string;
}

export interface Registry {
  surum: 1;
  guncellenmeAt: string;
  davalar: DavaKaydi[];
}

export function caseKeyYap(birimAdi: string, esasNo: string): string {
  return `${birimAdi}\u0000${esasNo}`;
}

export class RegistryDepo {
  private dosya: string;
  private veri: Registry | null = null;

  constructor(dosya: string) {
    this.dosya = dosya;
  }

  oku(): Registry {
    if (this.veri) return this.veri;
    try {
      const ham = JSON.parse(readFileSync(this.dosya, "utf8"));
      if (ham && ham.surum === 1 && Array.isArray(ham.davalar)) {
        this.veri = ham as Registry;
        return this.veri;
      }
    } catch {
      /* yok */
    }
    this.veri = { surum: 1, guncellenmeAt: "", davalar: [] };
    return this.veri;
  }

  yaz(): void {
    const v = this.oku();
    v.guncellenmeAt = new Date().toISOString();
    yazJsonAtomik(this.dosya, v);
  }

  bul(birimAdi: string, esasNo: string): DavaKaydi | undefined {
    const key = caseKeyYap(birimAdi, esasNo);
    return this.oku().davalar.find((d) => d.caseKey === key);
  }

  koy(kayit: DavaKaydi): void {
    const v = this.oku();
    const key = kayit.caseKey;
    const i = v.davalar.findIndex((d) => d.caseKey === key);
    if (i >= 0) v.davalar[i] = kayit;
    else v.davalar.push(kayit);
    this.yaz();
  }

  hepsi(): DavaKaydi[] {
    return this.oku().davalar;
  }

  /** Klonlanmış davalar */
  klonlanmis(): DavaKaydi[] {
    return this.oku().davalar.filter((d) => d.klonYolu !== undefined);
  }
}

export { join };
