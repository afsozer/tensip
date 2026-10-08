// Uygulamanın koruyucu sınırlarıdır; UYAP'ın resmî kotası değildir.
//
// Avukat Portalı kullanıcı sözleşmesi programla sisteme olağan dışı yük
// bindirmeyi yasaklar ve ihlalde erişim engellenir. Bu yüzden portala giden
// her istek tek sıradan geçer, aralarında 3–5 sn rastgele beklenir ve günlük
// istek sayısı ayrıca sınırlanır. Varsayılanları gevşetmeden önce düşünün.
import { readFileSync } from "node:fs";
import { Hata, KODLAR } from "./errors.js";
import { yazJsonAtomik } from "../store/fsops.js";

/** İki portal isteği arasındaki en kısa bekleme. */
export const VARSAYILAN_ISTEK_ARALIK_MS = 3_000;
/** Günde en çok kaç portal isteği gönderilir (giriş doğrulaması ve oturum yenileme dâhil). */
export const VARSAYILAN_GUNLUK_ISTEK_TAVANI = 500;
export const VARSAYILAN_GUNLUK_IS_TAVANI = 40;

export interface FrenSecenekler {
  /** Asgari aralık; her isteğe ayrıca [0, istekSapmaMs) rastgele sapma eklenir. */
  istekAralikMs?: number;
  /** Rastgele sapma üst sınırı; verilmezse aralığın üçte ikisi (3 sn → 3–5 sn). */
  istekSapmaMs?: number;
  /** Günlük dosya işi tavanı. */
  gunlukTavan?: number;
  /** Günlük portal isteği tavanı. */
  gunlukIstekTavan?: number;
  bekleyenTavan?: number;
  cooldownMs?: number;
  simdi?: () => number;
  /** [0, 1) aralığında sayı; testte sapmayı sabitlemek için. */
  rastgele?: () => number;
  /** Bekleme işlevi; testte gerçek zaman beklemeden ölçmek için. */
  bekle?: (ms: number) => Promise<void>;
  /** Yalnız daemon kilidi alındıktan sonra yukle() çağrılır. */
  dosya?: string;
}
interface FrenKaydi {
  surum: 1;
  gun: string;
  gunlukSayac: number;
  /** Bugün gönderilen portal isteği. Eski kayıtlarda yoktur, 0 sayılır. */
  gunlukIstek: number;
  cooldownBitis: number;
}
const takvim = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Istanbul", year: "numeric", month: "2-digit", day: "2-digit" });

export class Fren {
  private sonIstekAt = 0;
  private istekOldu = false;
  private istekSirasi: Promise<void> = Promise.resolve();
  private veri: FrenKaydi = { surum: 1, gun: "", gunlukSayac: 0, gunlukIstek: 0, cooldownBitis: 0 };
  private bekleyen = 0;
  private yuklendi = false;
  private simdi: () => number;
  private rastgele: () => number;
  private bekle: (ms: number) => Promise<void>;
  constructor(private sec: FrenSecenekler = {}) {
    this.simdi = sec.simdi ?? Date.now;
    this.rastgele = sec.rastgele ?? Math.random;
    this.bekle = sec.bekle ?? (ms => new Promise<void>(c => setTimeout(c, ms)));
  }
  private get aralikMs(): number { return this.sec.istekAralikMs ?? VARSAYILAN_ISTEK_ARALIK_MS; }
  private get sapmaMs(): number { return this.sec.istekSapmaMs ?? Math.round(this.aralikMs * 2 / 3); }
  private get isTavani(): number { return this.sec.gunlukTavan ?? VARSAYILAN_GUNLUK_IS_TAVANI; }
  private get istekTavani(): number { return this.sec.gunlukIstekTavan ?? VARSAYILAN_GUNLUK_ISTEK_TAVANI; }
  yukle(): void {
    if (this.yuklendi) return;
    if (this.sec.dosya) {
      try {
        const v = JSON.parse(readFileSync(this.sec.dosya, "utf8"));
        if (v?.surum !== 1 || typeof v.gun !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v.gun) ||
          !Number.isSafeInteger(v.gunlukSayac) || v.gunlukSayac < 0 ||
          (v.gunlukIstek !== undefined && (!Number.isSafeInteger(v.gunlukIstek) || v.gunlukIstek < 0)) ||
          !Number.isSafeInteger(v.cooldownBitis) || v.cooldownBitis < 0) throw new Error("geçersiz kayıt");
        if (new Date(`${v.gun}T12:00:00Z`).toISOString().slice(0, 10) !== v.gun) throw new Error("geçersiz gün");
        this.veri = { surum: 1, gun: v.gun, gunlukSayac: v.gunlukSayac, gunlukIstek: v.gunlukIstek ?? 0, cooldownBitis: v.cooldownBitis };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new Hata(KODLAR.INTERNAL, "Otomasyon sayacı okunamadı; fren.json korunuyor. Sayaç sıfırlanmadı, dosyayı kontrol edin.");
        }
      }
    }
    this.yuklendi = true;
    this.gunuTazele();
  }
  private kaydet(v: FrenKaydi): void {
    if (this.sec.dosya) {
      if (!this.yuklendi) throw new Hata(KODLAR.INTERNAL, "Otomasyon sayacı henüz yüklenmedi");
      try { yazJsonAtomik(this.sec.dosya, v); }
      catch { throw new Hata(KODLAR.INTERNAL, "Otomasyon sayacı kaydedilemedi; yeni iş başlatılmadı. Disk erişimini kontrol edin."); }
    }
    this.veri = v;
  }
  private gunuTazele(): void {
    const gun = takvim.format(this.simdi());
    // Saat geri alınırsa sayacı sıfırlama. Cooldown gün değişiminden bağımsızdır.
    if (gun > this.veri.gun) this.kaydet({ ...this.veri, gun, gunlukSayac: 0, gunlukIstek: 0 });
  }
  /** Başlayan her dosya işi/devam denemesi bir iş sayılır; portal istekleri sayılmaz. */
  isBaslamadan(): void {
    this.gunuTazele();
    const kalan = this.durum().cooldownKalanSn;
    if (kalan > 0) throw new Hata(KODLAR.OTOMASYON_BUTCESI, `Otomasyon freni: bekleme sürüyor, ${kalan} sn sonra deneyin`);
    if (this.veri.gunlukSayac >= this.isTavani) throw new Hata(KODLAR.OTOMASYON_BUTCESI, `Otomasyon freni: günlük ${this.isTavani} iş tavanı doldu; İstanbul saatine göre ertesi gün deneyin`);
    if (this.bekleyen >= (this.sec.bekleyenTavan ?? 50)) throw new Hata(KODLAR.OTOMASYON_BUTCESI, "Otomasyon freni: bekleyen iş sınırı doldu");
    // Senkron atomik yazım kabulden önce tamamlanır. Çökme sayacı geri alamaz.
    this.kaydet({ ...this.veri, gunlukSayac: this.veri.gunlukSayac + 1 });
    this.bekleyen++;
  }
  isBitti(): void { this.bekleyen = Math.max(0, this.bekleyen - 1); }
  /** Portal isteğini sıraya alır: uçuşta en çok bir istek olur, aralık önceki isteğin
   *  BİTİŞİNDEN sayılır ve her seferinde rastgele bir sapma eklenir (sabit ritimli
   *  istek akışı insan kullanımına benzemez). Sıra gelen istek, göndermeden önce
   *  günlük istek tavanına sayılır; tavan doluysa portala hiç gitmez.
   *  Aralık başlangıçtan sayılırken yavaş dönen bir belge isteğinin üstüne
   *  sıradaki biniyor, UYAP da belge yerine "Eş zamanlı olarak birden fazla sorgulama
   *  yapamazsınız!" gövdesini başarı koduyla döndürüyordu. Farklı davaların işleri de
   *  aynı Fren'i paylaştığı için tek sıradan geçer. */
  istek<T>(is: () => Promise<T>): Promise<T> {
    const siradaki = this.istekSirasi.then(async () => {
      if (this.istekOldu) {
        const hedef = this.sonIstekAt + this.aralikMs + Math.floor(this.rastgele() * this.sapmaMs);
        const gecikme = hedef - this.simdi();
        if (gecikme > 0) await this.bekle(gecikme);
      }
      this.istekSay();
      try { return await is(); }
      finally { this.sonIstekAt = this.simdi(); this.istekOldu = true; }
    });
    this.istekSirasi = siradaki.then(() => undefined, () => undefined);
    return siradaki;
  }
  /** Sayaç yüklenmeden (daemon kilidinden önce) gelen istek yalnız bellekte sayılır;
   *  kalıcı dosyaya kilitsiz yazılmaz. Daemon her zaman önce yükler. */
  private istekSay(): void {
    const kalici = !this.sec.dosya || this.yuklendi;
    if (kalici) this.gunuTazele();
    if (this.veri.gunlukIstek >= this.istekTavani) {
      throw new Hata(KODLAR.OTOMASYON_BUTCESI, `Otomasyon freni: günlük ${this.istekTavani} portal isteği tavanı doldu; İstanbul saatine göre ertesi gün deneyin`);
    }
    const yeni = { ...this.veri, gunlukIstek: this.veri.gunlukIstek + 1 };
    if (kalici) this.kaydet(yeni); else this.veri = yeni;
  }
  cooldownBaslat(ms?: number): void {
    this.kaydet({ ...this.veri, cooldownBitis: Math.max(this.veri.cooldownBitis, this.simdi() + (ms ?? this.sec.cooldownMs ?? 600_000)) });
  }
  durum() {
    this.gunuTazele();
    return {
      gun: this.veri.gun, saatDilimi: "Europe/Istanbul", kalici: Boolean(this.sec.dosya && this.yuklendi),
      gunlukSayac: this.veri.gunlukSayac, gunlukTavan: this.isTavani, bekleyen: this.bekleyen,
      gunlukIstek: this.veri.gunlukIstek, gunlukIstekTavan: this.istekTavani,
      istekAralikMs: this.aralikMs, istekSapmaMs: this.sapmaMs,
      cooldownKalanSn: Math.max(0, Math.ceil((this.veri.cooldownBitis - this.simdi()) / 1000)),
    };
  }
}
