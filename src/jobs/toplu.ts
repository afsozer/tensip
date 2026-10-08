// Kalıcı, kullanıcı tarafından başlatılan tek sıralı eşitleme kuyruğu.
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { yazJsonAtomik } from "../store/fsops.js";
import { Hata, KODLAR } from "../core/errors.js";
import { redakteEt } from "../core/log.js";
import type { Orkestrator, IsKaydi } from "./orchestrator.js";

export interface TopluIs {
  id: string;
  baslamaAt: string;
  durum: "calisiyor" | "duraklatildi" | "kesildi" | "hazir" | "iptal";
  talep?: "duraklat" | "iptal";
  mesaj?: string;
  dosyalar: { caseKey: string; denemeler: string[] }[];
}
function dogrula(v: unknown): v is { surum: 1; isler: TopluIs[] } {
  const x = v as { surum?: unknown; isler?: TopluIs[] } | null;
  if (x?.surum !== 1 || !Array.isArray(x.isler)) return false;
  return new Set(x.isler.map(i => i?.id)).size === x.isler.length && x.isler.every(i =>
    i && typeof i.id === "string" && typeof i.baslamaAt === "string" &&
    ["calisiyor", "duraklatildi", "kesildi", "hazir", "iptal"].includes(i.durum) &&
    (i.talep === undefined || ["duraklat", "iptal"].includes(i.talep)) &&
    (i.mesaj === undefined || typeof i.mesaj === "string") &&
    Array.isArray(i.dosyalar) && i.dosyalar.length > 0 && i.dosyalar.length <= 50 &&
    new Set(i.dosyalar.map(d => d?.caseKey)).size === i.dosyalar.length &&
    i.dosyalar.every(d => d && typeof d.caseKey === "string" && Array.isArray(d.denemeler) && d.denemeler.every(id => typeof id === "string")));
}
export class TopluEsitle {
  private isler: TopluIs[] = [];
  private calisan?: Promise<void>;
  private kapanis = false;
  private kapandi = false;
  private yuklendi = false;
  private depoHatasi = false;
  constructor(private dosya: string, private ork: Orkestrator, private onKontrol: () => void) {}

  yukle(): void {
    if (this.yuklendi) return;
    try {
      const v: unknown = JSON.parse(readFileSync(this.dosya, "utf8"));
      if (!dogrula(v)) throw new Error("geçersiz kayıt");
      this.isler = v.isler;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new Hata(KODLAR.INTERNAL, "Toplu iş kuyruğu okunamadı; toplu-isler.json korunuyor, dosyayı kontrol edin.");
    }
    this.yuklendi = true;
    let degisti = false;
    for (const is of this.isler) {
      if (is.durum === "calisiyor") {
        is.durum = is.talep === "iptal" ? "iptal" : "kesildi";
        delete is.talep;
        degisti = true;
      }
    }
    if (degisti) this.kaydet();
  }
  private kaydet(): void {
    if (!this.yuklendi || this.depoHatasi) throw new Hata(KODLAR.INTERNAL, "Toplu iş kuyruğu kullanılamıyor; disk erişimini kontrol edip motoru yeniden başlatın.");
    try { yazJsonAtomik(this.dosya, { surum: 1, isler: this.isler }); }
    catch { this.depoHatasi = true; throw new Hata(KODLAR.INTERNAL, "Toplu iş kuyruğu kaydedilemedi; sıra durduruldu. Disk erişimini kontrol edin."); }
  }
  hepsi(): TopluIs[] { return structuredClone(this.isler); }
  aktifMi(): boolean { return Boolean(this.calisan); }
  isiSahipleniyor(isId: string): boolean { return this.isler.some(i => i.dosyalar.some(d => d.denemeler.includes(isId))); }
  private kabulKontrol(): void {
    if (this.kapanis || this.aktifMi() || this.ork.islerHepsi().some(i => ["bekliyor", "calisiyor"].includes(i.durum))) throw new Hata(KODLAR.IS_BUSY, "Başka bir işlem sürüyor; tamamlanmasını veya duraklamasını bekleyin.");
    if (!this.yuklendi || this.depoHatasi) throw new Hata(KODLAR.INTERNAL, "Toplu iş deposu hazır değil");
    this.onKontrol();
  }
  baslat(keys: string[]): TopluIs {
    this.kabulKontrol();
    const is: TopluIs = { id: `toplu-${randomUUID()}`, baslamaAt: new Date().toISOString(), durum: "calisiyor", dosyalar: keys.map(caseKey => ({ caseKey, denemeler: [] })) };
    if (!dogrula({ surum: 1, isler: [is] })) throw new Hata(KODLAR.INVALID_INPUT, "1–50 farklı arşiv dosyası seçin");
    this.isler.push(is);
    try { this.kaydet(); } catch (e) { this.isler.pop(); throw e; }
    this.calistir(is);
    return structuredClone(is);
  }
  devam(id: string): TopluIs {
    this.kabulKontrol();
    const is = this.bul(id);
    if (!["duraklatildi", "kesildi"].includes(is.durum)) throw new Hata(KODLAR.INVALID_INPUT, "Bu toplu işe devam edilemez");
    const eski = is.durum;
    is.durum = "calisiyor"; delete is.talep; delete is.mesaj;
    try { this.kaydet(); } catch (e) { is.durum = eski; throw e; }
    this.calistir(is);
    return structuredClone(is);
  }
  kes(id: string, talep: "duraklat" | "iptal"): void {
    const is = this.bul(id);
    if (["hazir", "iptal"].includes(is.durum)) throw new Hata(KODLAR.INVALID_INPUT, "Toplu iş zaten sona ermiş");
    is.talep = talep;
    if (is.durum !== "calisiyor") {
      is.durum = talep === "iptal" ? "iptal" : "duraklatildi";
      delete is.talep;
    }
    this.kaydet(); // Talep, çalışan iş kesilmeden önce kalıcıdır.
    for (const d of is.dosyalar) {
      const son = d.denemeler.at(-1);
      if (son) talep === "iptal" ? this.ork.iptal(son) : this.ork.duraklat(son);
    }
  }
  private bul(id: string): TopluIs {
    const is = this.isler.find(i => i.id === id);
    if (!is) throw new Hata(KODLAR.NOT_FOUND, "Toplu iş bulunamadı");
    return is;
  }
  private calistir(is: TopluIs): void {
    // Mikro görev: çağıran yanıtı almadan ikinci kuyruk kabul edilemez.
    this.calisan = Promise.resolve().then(() => this.sira(is)).catch((e: unknown) => {
      if (this.kapandi) return;
      is.durum = "duraklatildi";
      is.mesaj = redakteEt(e instanceof Error ? e.message : String(e));
      if (!this.depoHatasi) {
        try { this.kaydet(); } catch { is.mesaj = "Toplu iş kaydedilemedi; disk erişimini kontrol edin."; }
      }
    }).finally(() => { this.calisan = undefined; });
  }
  private async sira(is: TopluIs): Promise<void> {
    if (this.kapandi) return;
    for (const d of is.dosyalar) {
      if (this.kapanis || is.talep) break;
      const son = d.denemeler.at(-1);
      if (son && this.ork.isGetir(son)?.durum === "hazir") continue;
      this.onKontrol();
      const sonuc = await this.ork.esitleSirali(d.caseKey, (job: IsKaydi) => {
        d.denemeler.push(job.isId);
        this.kaydet(); // İş portal isteği göndermeden kuyruğa bağlanır.
      });
      if (this.kapandi) return;
      if (this.kapanis || is.talep) break;
      if (sonuc.durum !== "hazir") {
        is.durum = "duraklatildi";
        is.mesaj = "Eşitleme tamamlanamadı. Dosya sonucunu inceleyin; Devam et bu dosyayı yeniden dener ve ardından kalan sırayı işler.";
        this.kaydet();
        return;
      }
      this.kaydet();
    }
    if (this.kapandi) return;
    is.durum = is.talep === "iptal" ? "iptal" : this.kapanis ? "kesildi" : is.talep === "duraklat" ? "duraklatildi" : "hazir";
    delete is.talep;
    this.kaydet();
  }
  /** Yeni dosyayı engelle, orkestratör kapandıktan sonra döngünün kaydını bekle. */
  kapanisiBaslat(): void { this.kapanis = true; }
  kapanisiBitir(): void {
    if (!this.yuklendi) return;
    this.kapandi = true;
    for (const is of this.isler) if (is.durum === "calisiyor") {
      is.durum = is.talep === "iptal" ? "iptal" : "kesildi";
      delete is.talep;
    }
    this.kaydet();
  }
}
