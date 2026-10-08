// Oturum yönetimi.
//
// UYAP'ta kalıcı oturum yoktur; inaktiflikte oturum kapanır. Model:
//  - Çerez depoda saklanır (0600), her iş öncesi probe ile canlılık denetlenir.
//  - Probe ucunun ucuz olması gerekir: yargiBirimleriSorgula (hukuk) kullanılır.
//  - Oturum bittiğinde LOGIN_REQUIRED döndürülür; ajan yeni giriş ister.

import { readFileSync, mkdirSync, chmodSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { Hata, KODLAR } from "../core/errors.js";
import { yazJsonAtomik } from "../store/fsops.js";
import { UCLAR } from "./endpoints.js";

export type OturumDurumu = "giris_gerekiyor" | "kontrol_ediliyor" | "aktif" | "bitti";

export interface OturumKaydi {
  surum: 1;
  cookie: string;
  loginAt: string;
  yontem: "cdp" | "manuel" | "dosya";
  adSoyad?: string;
  not?: string;
}

export function oturumDizini(uygDizini: string): string {
  return join(uygDizini, "oturum.json");
}

export class OturumDepo {
  private dosya: string;
  constructor(uygDizini: string) {
    this.dosya = oturumDizini(uygDizini);
  }
  oku(): OturumKaydi | null {
    try {
      const ham = JSON.parse(readFileSync(this.dosya, "utf8"));
      if (ham && ham.surum === 1 && typeof ham.cookie === "string" && ham.cookie.length > 0) {
        return ham as OturumKaydi;
      }
    } catch {
      /* yok */
    }
    return null;
  }
  yaz(kayit: OturumKaydi): void {
    mkdirSync(dirname(this.dosya), { recursive: true });
    yazJsonAtomik(this.dosya, kayit);
    try {
      chmodSync(this.dosya, 0o600);
    } catch {
      /* platform */
    }
  }
  sil(): void {
    try {
      unlinkSync(this.dosya);
    } catch {
      /* yok */
    }
  }
  cookie(): string {
    const k = this.oku();
    return k ? k.cookie : "";
  }
}

export interface ProbeYanit {
  durum: number;
  rc?: string;
  govde: string;
  contentType?: string;
}

export interface ProbeIstemci {
  /** Ucuz uç çağrısı; oturum bitmişse hata (OTURUM_BITTI) fırlatır.
   *  `cerez` verilirse depolanan çerez yerine verilen çerez kullanılır. */
  json(yol: string, govde: unknown, cerez?: string): Promise<ProbeYanit>;
}

export class OturumYoneticisi {
  private depo: OturumDepo;
  private istemci: ProbeIstemci;
  durum: OturumDurumu = "giris_gerekiyor";
  sonProbeAt?: string;
  sonHata?: string;
  /** GERÇEK probe'ların art arda "bitti" sayısı (önbellek okumaları sayılmaz
   *  — tek 401 iki kez sayılıp oturum yanlışlıkla silinmesin). 2'ye ulaşınca
   *  oturum silinir; hangi aktör probe attıysa etsin (pano/keep-alive). */
  private bittiSayaci_ = 0;
  private nesil = 0;
  get surum(): number { return this.nesil; }
  private bekleyenProbe?: { nesil: number; sonuc: Promise<OturumDurumu> };

  constructor(depo: OturumDepo, istemci: ProbeIstemci) {
    this.depo = depo;
    this.istemci = istemci;
    const kayit = depo.oku();
    this.durum = kayit ? "aktif" : "giris_gerekiyor";
  }

  /** Art arda gerçek "bitti" probe sayısı (daemon canlı-tutma temizliği okur). */
  bittiSayaci(): number {
    return this.bittiSayaci_;
  }

  /** Çerezi kaydeder (CDP/manuel/dosya girişlerinden gelir). */
  girisYap(cookie: string, yontem: OturumKaydi["yontem"], not?: string): void {
    if (!cookie || !/JSESSIONID/i.test(cookie)) {
      throw new Hata(KODLAR.INVALID_INPUT, "çerez JSESSIONID içermiyor");
    }
    this.nesil++;
    this.sonProbeAt = undefined;
    this.depo.yaz({
      surum: 1,
      cookie,
      loginAt: new Date().toISOString(),
      yontem,
      not,
    });
    this.durum = "aktif";
    this.sonHata = undefined;
    this.bittiSayaci_ = 0;
  }

  /** Aday çerez yalnız tamamlanmış, başarılı JSON yanıtından sonra saklanır. */
  async girisiDogrula(cookie: string, yontem: OturumKaydi["yontem"]): Promise<OturumDurumu> {
    if (!/(?:^|;\s*)JSESSIONID=[^;]+/i.test(cookie)) {
      throw new Hata(KODLAR.INVALID_INPUT, "çerez JSESSIONID içermiyor");
    }
    const nesil = ++this.nesil;
    this.durum = "kontrol_ediliyor";
    const gecerli = await this.cerezDogrula(cookie);
    if (nesil !== this.nesil) {
      throw new Hata(KODLAR.LOGIN_REQUIRED, "giriş doğrulanırken oturum değişti; yeniden deneyin");
    }
    if (!gecerli) {
      this.cikis();
      throw new Hata(KODLAR.LOGIN_REQUIRED,
        "çerez yakalandı ama portal oturumu doğrulamadı — girişi tamamlayıp tekrar deneyin");
    }
    this.girisYap(cookie, yontem);
    this.sonProbeAt = new Date().toISOString();
    return this.durum;
  }

  /** Giriş tamamlandıktan sonra tek doğrulama. Paylaşılan durumu değiştirmez. */
  async cerezDogrula(cookie: string): Promise<boolean> {
    try {
      const yanit = await this.istemci.json(UCLAR.yargiTurleri.yol, { yargiTuru: "0" }, cookie);
      return probeBasariliMi(yanit);
    } catch {
      return false;
    }
  }

  cikis(): void {
    this.nesil++;
    this.sonProbeAt = undefined;
    this.sonHata = undefined;
    this.depo.sil();
    this.durum = "giris_gerekiyor";
    this.bittiSayaci_ = 0;
  }

  /** Aktif çerezi döndürür; giriş yoksa LOGIN_REQUIRED fırlatır. */
  gerektigiGibi(): string {
    const k = this.depo.oku();
    if (!k) {
      this.durum = "giris_gerekiyor";
      throw new Hata(KODLAR.LOGIN_REQUIRED, "giriş yapılmadı: `tensip giris` ile oturum açın");
    }
    return k.cookie;
  }

  /** Aynı oturuma ait eşzamanlı yoklamalar tek isteği paylaşır. */
  async probe(): Promise<OturumDurumu> {
    if (this.bekleyenProbe?.nesil === this.nesil) return this.bekleyenProbe.sonuc;
    const k = this.depo.oku();
    if (!k) {
      this.durum = "giris_gerekiyor";
      return this.durum;
    }
    const is = { nesil: this.nesil, sonuc: this.probeCalistir(k, this.nesil) };
    this.bekleyenProbe = is;
    try { return await is.sonuc; }
    finally { if (this.bekleyenProbe === is) this.bekleyenProbe = undefined; }
  }

  private async probeCalistir(k: OturumKaydi, nesil: number): Promise<OturumDurumu> {
    const onceki = this.durum;
    this.durum = "kontrol_ediliyor";
    try {
      const yanit = await this.istemci.json(UCLAR.yargiTurleri.yol, { yargiTuru: "0" }, k.cookie);
      if (nesil !== this.nesil) return this.durum;
      if (probeBasariliMi(yanit)) {
        this.durum = "aktif";
        this.sonHata = undefined;
        this.bittiSayaci_ = 0;
      } else {
        this.durum = "bitti";
        this.sonHata = `HTTP ${yanit.durum}, rc=${yanit.rc ?? "yok"}`;
        this.bittiHesapla();
      }
    } catch (e) {
      if (nesil !== this.nesil) return this.durum;
      const mesaj = e instanceof Error ? e.message : String(e);
      if ((e instanceof Hata && e.code === KODLAR.OTURUM_BITTI) || /\b401\b|\b302\b/.test(mesaj)) {
        this.durum = "bitti";
        this.sonHata = mesaj;
        this.bittiHesapla();
      } else {
        // Ağ arızası yeni oturumu doğrulamaz ve önceden bilinen ölümü gizlemez.
        this.durum = onceki;
        this.sonHata = mesaj;
      }
    }
    if (nesil === this.nesil) this.sonProbeAt = new Date().toISOString();
    return this.durum;
  }

  /** Gerçek probe başarısızlığını sayar; 2'ye ulaşınca ölü oturum silinir
   *  (dövme kuralı — aktörden bağımsız, sayaç probe'un kendi içinde). */
  private bittiHesapla(): void {
    this.bittiSayaci_ += 1;
    if (this.bittiSayaci_ >= 2 && this.depo.oku()) {
      this.depo.sil();
      this.durum = "giris_gerekiyor";
      this.bittiSayaci_ = 0;
    }
  }

  /**
   * Sonucu önbellekleyen probe — pano gibi sık çağıran yüzeyler portalı
   * rahatsız etmesin: son probe tazeleSn içindeyse yeniden istek atılmaz.
   * Varsayılan 10 dk — canlı-tutma aralığıyla AYNI kadran: pano sekmesi
   * 5 sn'de bir çağırsa bile portala en fazla 10 dk'da bir istek gider
   * (5 Eyl ölçümü: 60 sn önbellekle pano tek başına ~30-60 istek/saat
   * atıyordu; toplam 229 istek/gün böylesine çıkıyordu).
   */
  async probeTaze(tazeleSn = 600): Promise<OturumDurumu> {
    if (!this.depo.oku()) { this.durum = "giris_gerekiyor"; return this.durum; }
    if (this.bekleyenProbe?.nesil === this.nesil) return this.bekleyenProbe.sonuc;
    if (this.sonProbeAt !== undefined) {
      const gecen = Date.now() - Date.parse(this.sonProbeAt);
      if (Number.isFinite(gecen) && gecen < tazeleSn * 1000 && this.durum !== "giris_gerekiyor") {
        return this.durum;
      }
    }
    return this.probe();
  }

  /**
   * `surum` alanı: liste satırlarındaki OPAK KİMLİKLERİN hangi oturuma ait
   * olduğunu istemcinin ölçebilmesi için. Sayaç yalnız `girisYap`/`cikis` ile
   * artar; `kontrol_ediliyor` gibi geçici durumlar onu DEĞİŞTİRMEZ. Pano
   * bununla "oturum o an doğrulanıyor" ile "oturum başkalaştı, elimdeki
   * kimlikler bayat" arasını ayırabilir — `liste-taraflar`ın sunucu tarafında
   * uyguladığı kapının aynısı (daemon.ts). Sır değildir: yalnız bir sayaç.
   */
  durumBilgisi(): { durum: OturumDurumu; surum: number; loginAt?: string; yontem?: string; sonProbeAt?: string; sonHata?: string } {
    const k = this.depo.oku();
    return {
      durum: this.durum,
      surum: this.nesil,
      loginAt: k?.loginAt,
      yontem: k?.yontem,
      sonProbeAt: this.sonProbeAt,
      sonHata: this.sonHata,
    };
  }
}

/** Başarı başlığı tek başına HTML/yönlendirme/bozuk JSON'u meşrulaştırmaz. */
function probeBasariliMi(yanit: ProbeYanit): boolean {
  if (yanit.durum !== 200 || (yanit.contentType ?? "").toLowerCase().includes("html")) return false;
  if (yanit.rc !== undefined && yanit.rc !== "SUCCESS") return false;
  try {
    const veri: unknown = JSON.parse(yanit.govde);
    if (veri === null || typeof veri !== "object") return false;
    if (!Array.isArray(veri) && ("errorCode" in veri || "error" in veri)) return false;
    return yanit.rc === "SUCCESS" || (yanit.contentType ?? "").toLowerCase().includes("json");
  } catch { return false; }
}
