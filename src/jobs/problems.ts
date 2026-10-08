// Sorun deposu: indirme/dönüşüm hatalarının kaydı, retry/ignore.
// Sorun başına yoksay/yeniden dene yüzeyi.

import { readFileSync } from "node:fs";
import { yazJsonAtomik } from "../store/fsops.js";

export interface Sorun {
  sorunId: string;
  caseKey: string;
  evrakId?: string;
  tur: "indirme" | "donusum" | "yuklenmemis";
  hata: string;
  at: string;
  durum: "acik" | "yok-sayildi" | "cozuldu";
}

/**
 * P16 — hangi sorun kaydı SAYILIR (başlıktaki rozet ve sekme sayacı)?
 *
 * Ölçüt tek: kaydı KULLANICI ya da ortam düzeltebilir mi? Sayaç bir "yapılacak
 * iş" göstergesidir; düzeltilemeyen bir kaydı saymak rozeti kalıcı olarak
 * yakılı bırakır ve sayacın anlamını yok eder.
 *
 * Türler koddan ölçülerek sınıflandı (src/jobs/orchestrator.ts):
 *  - `indirme`   portal evrak isteğine hata döndü (orchestrator.ts `sorunEkle`,
 *                "portal N döndü"). Oturum/ağ geçici olabilir; yeniden eşitleme
 *                düzeltir → SAYILIR.
 *  - `donusum`   mdStatus `hata | arac-yok | bekliyor` (donusumleriTetikle açık
 *                listesi). `arac-yok` `brew install poppler` ile düzelir ve
 *                sayaçta görünmezse hiç fark edilmez (ROADMAP §14 bağlayıcı
 *                kararı); `hata`/`bekliyor` yeniden eşitlemeyle düzelir → SAYILIR.
 *  - `yuklenmemis` evrak UYAP sistemine hiç yüklenmemiş (evrakYuklenmemisMi).
 *                Kaynak mahkemededir; kullanıcının ne yeniden eşitlemesi ne de
 *                bir kurulum yapması bunu değiştirir → SAYILMAZ.
 *
 * SAYILMAZ, "yok sayılır" DEĞİLDİR: kayıt listede tam metniyle durur ve
 * yoksay/geri al düğmeleri aynen çalışır. Tek fark sayaçta yer almamasıdır.
 *
 * Şemaya yeni bir tür EKLENMEDİ: `arac-yok` bugün `donusum` türü altında
 * `mdHata` metniyle ayırt ediliyor ve sayaç kararı için tür yeterli.
 */
export const EYLEME_DONUK_TURLER: ReadonlySet<Sorun["tur"]> = new Set([
  "indirme",
  "donusum",
]);

/** Bu kayıt sayaca girer mi? Tek karar noktası — UI ve CLI buraya bakar. */
export function eylemeDonukMu(s: Pick<Sorun, "tur">): boolean {
  return EYLEME_DONUK_TURLER.has(s.tur);
}

export interface SorunDepoVeri {
  surum: 1;
  sorunlar: Sorun[];
}

export class SorunDepo {
  private dosya: string;
  private veri: SorunDepoVeri | null = null;

  constructor(dosya: string) {
    this.dosya = dosya;
  }

  oku(): SorunDepoVeri {
    if (this.veri) return this.veri;
    try {
      const ham = JSON.parse(readFileSync(this.dosya, "utf8"));
      if (ham && ham.surum === 1 && Array.isArray(ham.sorunlar)) {
        this.veri = ham as SorunDepoVeri;
        return this.veri;
      }
    } catch {
      /* yok */
    }
    this.veri = { surum: 1, sorunlar: [] };
    return this.veri;
  }

  yaz(): void {
    yazJsonAtomik(this.dosya, this.oku());
  }

  ekle(yeni: Omit<Sorun, "sorunId" | "at" | "durum">): Sorun {
    const v = this.oku();
    // aynı caseKey+evrakId+tür zaten açık: güncelle (yığılma yok)
    const mevcut = v.sorunlar.find(
      (s) =>
        s.durum === "acik" &&
        s.caseKey === yeni.caseKey &&
        s.evrakId === yeni.evrakId &&
        s.tur === yeni.tur
    );
    if (mevcut) {
      mevcut.hata = yeni.hata;
      mevcut.at = new Date().toISOString();
      this.yaz();
      return mevcut;
    }
    const kayit: Sorun = {
      ...yeni,
      sorunId: `srn-${Date.now()}-${Math.floor(Math.random() * 1e5)}`,
      at: new Date().toISOString(),
      durum: "acik",
    };
    v.sorunlar.push(kayit);
    if (v.sorunlar.length > 500) v.sorunlar.splice(0, v.sorunlar.length - 500);
    this.yaz();
    return kayit;
  }

  acik(): Sorun[] {
    return this.oku().sorunlar.filter((s) => s.durum === "acik");
  }

  /**
   * Aynı kimlikteki (dava + evrak + tür) AÇIK kayıt. `ekle`in eşleştirme
   * ölçütünün AYNISIDIR — kaydı açan ve kapatan iki yol aynı kimliği görsün
   * diye tek yerde durur. Yoksayılan ya da çözülmüş kayıt DÖNMEZ.
   */
  acikBul(
    caseKey: string,
    evrakId: string | undefined,
    tur: Sorun["tur"]
  ): Sorun | undefined {
    return this.oku().sorunlar.find(
      (s) =>
        s.durum === "acik" &&
        s.caseKey === caseKey &&
        s.evrakId === evrakId &&
        s.tur === tur
    );
  }

  /** P16 — sayaca giren açık kayıtlar. `acik()`in ALT kümesidir; liste değil. */
  acikSayilan(): Sorun[] {
    return this.acik().filter(eylemeDonukMu);
  }

  hepsi(): Sorun[] {
    return this.oku().sorunlar;
  }

  yokSay(sorunId: string): boolean {
    const s = this.oku().sorunlar.find((x) => x.sorunId === sorunId);
    if (!s) return false;
    s.durum = "yok-sayildi";
    this.yaz();
    return true;
  }

  yokSayVazgec(sorunId: string): boolean {
    const s = this.oku().sorunlar.find((x) => x.sorunId === sorunId);
    if (!s) return false;
    s.durum = "acik";
    this.yaz();
    return true;
  }

  /**
   * Kayıt DÜZELDİ. "Yoksay"dan farkı: yoksay kullanıcının "bunu bana bir daha
   * gösterme" kararıdır, `cozuldu` motorun ölçümüdür — sorunun anlattığı durum
   * artık yok (evrak indi, dönüşüm başarılı). Kayıt listede "Çözüldü" etiketiyle
   * durmaya devam eder, yalnız `acik()`ten ve dolayısıyla sayaçtan düşer.
   */
  cozuldu(sorunId: string): boolean {
    const s = this.oku().sorunlar.find((x) => x.sorunId === sorunId);
    if (!s) return false;
    s.durum = "cozuldu";
    this.yaz();
    return true;
  }
}
