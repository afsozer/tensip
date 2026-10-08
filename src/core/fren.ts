// Uygulamanın koruyucu sınırlarıdır; UYAP'ın resmî kotası değildir.
import { readFileSync } from "node:fs";
import { Hata, KODLAR } from "./errors.js";
import { yazJsonAtomik } from "../store/fsops.js";

export interface FrenSecenekler {
  istekAralikMs?: number;
  gunlukTavan?: number;
  bekleyenTavan?: number;
  cooldownMs?: number;
  simdi?: () => number;
  /** Yalnız daemon kilidi alındıktan sonra yukle() çağrılır. */
  dosya?: string;
}
interface FrenKaydi {
  surum: 1;
  gun: string;
  gunlukSayac: number;
  cooldownBitis: number;
}
const takvim = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Istanbul", year: "numeric", month: "2-digit", day: "2-digit" });

export class Fren {
  private sonIstekAt = 0;
  private istekSirasi: Promise<void> = Promise.resolve();
  private veri: FrenKaydi = { surum: 1, gun: "", gunlukSayac: 0, cooldownBitis: 0 };
  private bekleyen = 0;
  private yuklendi = false;
  private simdi: () => number;
  constructor(private sec: FrenSecenekler = {}) {
    this.simdi = sec.simdi ?? Date.now;
  }
  yukle(): void {
    if (this.yuklendi) return;
    if (this.sec.dosya) {
      try {
        const v = JSON.parse(readFileSync(this.sec.dosya, "utf8"));
        if (v?.surum !== 1 || typeof v.gun !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v.gun) ||
          !Number.isSafeInteger(v.gunlukSayac) || v.gunlukSayac < 0 ||
          !Number.isSafeInteger(v.cooldownBitis) || v.cooldownBitis < 0) throw new Error("geçersiz kayıt");
        if (new Date(`${v.gun}T12:00:00Z`).toISOString().slice(0, 10) !== v.gun) throw new Error("geçersiz gün");
        this.veri = { surum: 1, gun: v.gun, gunlukSayac: v.gunlukSayac, cooldownBitis: v.cooldownBitis };
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
    if (gun > this.veri.gun) this.kaydet({ ...this.veri, gun, gunlukSayac: 0 });
  }
  /** Başlayan her dosya işi/devam denemesi bir iş sayılır; portal istekleri sayılmaz. */
  isBaslamadan(): void {
    this.gunuTazele();
    const kalan = this.durum().cooldownKalanSn;
    if (kalan > 0) throw new Hata(KODLAR.OTOMASYON_BUTCESI, `Otomasyon freni: bekleme sürüyor, ${kalan} sn sonra deneyin`);
    if (this.veri.gunlukSayac >= (this.sec.gunlukTavan ?? 40)) throw new Hata(KODLAR.OTOMASYON_BUTCESI, `Otomasyon freni: günlük ${this.sec.gunlukTavan ?? 40} iş tavanı doldu; İstanbul saatine göre ertesi gün deneyin`);
    if (this.bekleyen >= (this.sec.bekleyenTavan ?? 50)) throw new Hata(KODLAR.OTOMASYON_BUTCESI, "Otomasyon freni: bekleyen iş sınırı doldu");
    // Senkron atomik yazım kabulden önce tamamlanır. Çökme sayacı geri alamaz.
    this.kaydet({ ...this.veri, gunlukSayac: this.veri.gunlukSayac + 1 });
    this.bekleyen++;
  }
  isBitti(): void { this.bekleyen = Math.max(0, this.bekleyen - 1); }
  /** Portal isteğini sıraya alır: uçuşta en çok bir istek olur, aralık önceki isteğin
   *  BİTİŞİNDEN sayılır. Başlangıçtan sayılırken yavaş dönen bir belge isteğinin üstüne
   *  sıradaki biniyor, UYAP da belge yerine "Eş zamanlı olarak birden fazla sorgulama
   *  yapamazsınız!" gövdesini başarı koduyla döndürüyordu. Farklı davaların işleri de
   *  aynı Fren'i paylaştığı için tek sıradan geçer. */
  istek<T>(is: () => Promise<T>): Promise<T> {
    const siradaki = this.istekSirasi.then(async () => {
      const gecikme = this.sonIstekAt + (this.sec.istekAralikMs ?? 800) - this.simdi();
      if (gecikme > 0) await new Promise<void>(c => setTimeout(c, gecikme));
      try { return await is(); }
      finally { this.sonIstekAt = this.simdi(); }
    });
    this.istekSirasi = siradaki.then(() => undefined, () => undefined);
    return siradaki;
  }
  cooldownBaslat(ms?: number): void {
    this.kaydet({ ...this.veri, cooldownBitis: Math.max(this.veri.cooldownBitis, this.simdi() + (ms ?? this.sec.cooldownMs ?? 600_000)) });
  }
  durum() {
    this.gunuTazele();
    return {
      gun: this.veri.gun, saatDilimi: "Europe/Istanbul", kalici: Boolean(this.sec.dosya && this.yuklendi),
      gunlukSayac: this.veri.gunlukSayac, gunlukTavan: this.sec.gunlukTavan ?? 40, bekleyen: this.bekleyen,
      cooldownKalanSn: Math.max(0, Math.ceil((this.veri.cooldownBitis - this.simdi()) / 1000)),
    };
  }
}
