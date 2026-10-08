// İş orkestratörü: klonla / esitle / duraklat / devam / iptal.
//
// İş durumu makinesi: bekliyor → calisiyor → (hazir | hata | iptal |
// duraklatildi). Duraklatma/iptal: kesme tabanlı; indirme döngüsü
// noktalarında denetlenir. Devamlılık (resume): manifest'te evrak başına
// kayıt var; var olan dosyalar atlanır, yalnız eksikler iner.

import { mkdirSync, existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { ayniKaynakTekillestir } from "../store/tekrar.js";
import { evraklariEslestir, grupOzeti, kayitAnahtari, type EsAnahtari } from "../store/eslestir.js";
import { esitlemeKimligiSec, esitlemeSayaci, type SonEsitleme } from "../store/esitleme.js";
import { dirname, extname, join } from "node:path";
import { createHash } from "node:crypto";
import { Hata, KODLAR } from "../core/errors.js";
import { OlayYayici } from "../core/log.js";
import { Fren } from "../core/fren.js";
import { kapsamKontrol, kapsamIcindeMi, yazMetinAtomik } from "../store/fsops.js";
import { BelirsizHavuz, type AdayKayit, type IndirilenOlcum } from "../store/tazeleme.js";
import { kaynakOnarimPlani, type OnarimDurumu } from "../store/onarim.js";
import { davaKlasoru, adTemizle, evrakDosyaAdi } from "../store/paths.js";
import { siniflandir } from "../store/taxonomy.js";
import { RegistryDepo, caseKeyYap, type DavaKaydi } from "../store/registry.js";
import {
  MANIFEST_ADI,
  ManifestDepo,
  hamDosyaKaydiTutuyorMu,
  manifestiYedekle,
  stableKeyAna,
  stableKeyEk,
  kisaOzet,
  type Manifest,
  type ManifestEvrak,
} from "../store/manifest.js";
import { UyapApi } from "../uyap/api.js";
import { taraflariGetir } from "../uyap/dosyadetay.js";
import { taraflariCoz } from "../uyap/taraf.js";
import type { EvrakSatiri, DosyaSatiri } from "../uyap/schema.js";
import { donustur, baytlardanMetin, type DonusumSonucu } from "../convert/run.js";
import { evrakYuklenmemisMi, yuklenmemisMesaji } from "../uyap/client.js";
import { udfMu } from "../convert/udf.js";
import { SorunDepo } from "./problems.js";
import { IsDepo, isDepoKayitlarinaCevir, type KaliciIsKaydi, type IsParametreleri } from "./depo.js";

export type IsDurum = "bekliyor" | "calisiyor" | "hazir" | "eksikli" | "hata" | "iptal" | "duraklatildi" | "kesildi";

export interface IsKaydi {
  isId: string;
  /**
   * P06b — üçüncü tür: `onar`. Seçili evrakın kaynağını portaldan geri getirir
   * ve YALNIZ o satırları değiştirir; `esitle`nin yerine GEÇMEZ (o bütün
   * davayı tarar). Ayrı tür olması şart: iş geçmişi, CLI beklemesi ve UI
   * durumları "ne yapıldı" sorusuna doğru yanıtı vermeli.
   */
  tur: "klonla" | "esitle" | "onar";
  caseKey: string;
  durum: IsDurum;
  baslamaAt: string;
  bitisAt?: string;
  ilerleme: { toplam: number; biten: number };
  sonuc?: unknown;
  hata?: { code: string; message: string };
  parametreler?: IsParametreleri;
  oncekiIsId?: string;
  devamIsId?: string;
  iptalIsteniyor?: boolean;
}

/** P06b — seçili onarımın tek satırlık sonucu. Yollar dava klasörüne GÖRELİ. */
export interface OnarimIsSatiri {
  yol: string;
  durum: OnarimDurumu | "indirilemedi" | "yuklenmemis";
  aciklama: string;
  /** Onarıldıysa belgenin yazıldığı yol (yerinde yazılmadıysa YENİ yol). */
  yeniYol?: string;
  /** Belge kayıtlı yoluna mı yazıldı? false ise eski dosya olduğu gibi duruyor. */
  yerinde?: boolean;
  mdStatus?: string;
}

export interface OnarimIsSonucu {
  klonYolu: string;
  istenen: number;
  onarilan: number;
  /** Ölçüm "zaten yerinde" dediği için hiç indirilmeyen satır sayısı. */
  atlanan: number;
  /** BAŞARISIZ satır sayısı — başarısız indirme başarı SAYILMAZ (iş "eksikli" olur). */
  eksikEvrak: number;
  yedek?: string;
  satirlar: OnarimIsSatiri[];
  duraklatildi?: boolean;
}

export interface KlonlaIstek {
  birimAdi: string;
  esasNo: string; // "2026/928"
  kapsam: "acik" | "kapali" | "hepsi";
  avukat: string;
  grup?: string;
  kod?: string;
}

export interface OrkestratorSecenek {
  api: UyapApi;
  registry: RegistryDepo;
  olaylar: OlayYayici;
  fren: Fren;
  kok: string;
  sorunlar: SorunDepo;
  isDepo?: IsDepo;
  /** indirme döngüsünde çağrılır: duraklat/iptal kararı */
  kesmeDenetle?: (isId: string) => "devam" | "duraklat" | "iptal";
}

interface DavaBilgi {
  dosyaId: string;
  birimAdi: string;
  esasNo: string;
  dosyaDurum?: string;
  dosyaTur?: string;
  birimId: string;
  yargiTuru: string;
}

export class Orkestrator {
  private sec: OrkestratorSecenek;
  private isler = new Map<string, IsKaydi>();
  private mesgulCase = new Set<string>();
  private butceAlinanIsler = new Set<string>();
  /** duraklatılan işlerin kesme bayrağı */
  private kesmeler = new Map<string, "duraklat" | "iptal">();
  /** sorun kaydı için klasör → caseKey eşlemesi */
  private klasorCaseKey = new Map<string, string>();
  private isDepo?: IsDepo;
  private depoAktif = false;
  private depoKurtarildi = false;
  private depoElenen = 0;
  private kapanis = false;
  private depoHatasi?: Error;
  private calisanlar = new Set<Promise<void>>();

  constructor(sec: OrkestratorSecenek) {
    this.sec = sec;
    this.isDepo = sec.isDepo;
  }

  /** RPC kilidi edinildikten sonra çağrılır. Eski aktif işler burada kesilir. */
  depoYukle(): void {
    if (this.depoAktif) return;
    const kayitlar = this.isDepo?.oku() ?? [];
    this.depoKurtarildi = this.isDepo?.kurtarmaGerekiyor() ?? false;
    // Tanınmayan kayıt elendiyse GÖRÜNÜR olur: bir sonraki yazımda dosyadan
    // düşeceği için sessiz kalması veri kaybını gizlemek olurdu.
    this.depoElenen = this.isDepo?.elenenKayitSayisi() ?? 0;
    this.isler = new Map(kayitlar.map((kayit) => [kayit.isId, { ...kayit, ilerleme: { ...kayit.ilerleme } }]));
    let degisti = false;
    for (const is of this.isler.values()) {
      if (is.durum === "calisiyor" || is.durum === "bekliyor") {
        is.durum = is.iptalIsteniyor ? "iptal" : "kesildi";
        is.bitisAt = new Date().toISOString();
        if (is.durum === "kesildi") is.hata = { code: KODLAR.INTERNAL, message: "Daemon yeniden başlatıldığı için iş kesildi; kullanıcı devam ettirebilir." };
        degisti = true;
      }
    }
    this.depoAktif = true;
    if (degisti) this.kaydet();
  }

  depoDurumu(): { yuklendi: boolean; kurtarildi: boolean; elenen: number } {
    return { yuklendi: this.depoAktif, kurtarildi: this.depoKurtarildi, elenen: this.depoElenen };
  }

  private kaydet(): void {
    if (this.depoHatasi) throw this.depoHatasi;
    if (!this.depoAktif || this.isDepo === undefined) return;
    this.isDepo.yaz(isDepoKayitlarinaCevir(this.islerHepsi()));
  }

  // ── kesme kontrolü ──────────────────────────────────────────────────

  duraklat(isId: string): boolean {
    const is = this.isler.get(isId);
    if (!is || is.durum !== "calisiyor") return false;
    this.kesmeler.set(isId, "duraklat");
    return true;
  }

  iptal(isId: string): boolean {
    const is = this.isler.get(isId);
    if (!is || is.devamIsId !== undefined || !(is.durum === "calisiyor" || is.durum === "duraklatildi" || is.durum === "kesildi" || is.durum === "eksikli")) return false;
    if (is.durum === "duraklatildi" || is.durum === "kesildi" || is.durum === "eksikli") {
      is.iptalIsteniyor = true;
      this.kesmeler.delete(isId);
      this.durumKoy(is, "iptal");
    } else {
      is.iptalIsteniyor = true;
      this.kaydet();
      this.kesmeler.set(isId, "iptal");
    }
    return true;
  }

  /** Kapanış kullanıcı iptali değildir; kaldığı yerden devam edilebilsin. */
  async kapanisiBekle(): Promise<void> {
    this.kapanis = true;
    let zaman: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...this.calisanlar]),
        new Promise<void>(resolve => { zaman = setTimeout(resolve, 5_000); }),
      ]);
      for (const is of this.isler.values()) {
        if (is.durum === "calisiyor" || is.durum === "bekliyor") {
          is.durum = is.iptalIsteniyor ? "iptal" : "kesildi";
          is.bitisAt = new Date().toISOString();
        }
      }
      this.kaydet();
    } finally {
      if (zaman) clearTimeout(zaman);
      this.depoAktif = false;
    }
  }

  /** Duraklatılmış işi kesme bayrağını temizleyip yeniden başlatır. */
  devamEt(isId: string): IsKaydi | null {
    const eski = this.isler.get(isId);
    if (!eski || !(eski.durum === "duraklatildi" || eski.durum === "kesildi" || eski.durum === "eksikli") || eski.devamIsId !== undefined) return null;
    const yeni = this.isYap(eski.tur, eski.caseKey, eski.parametreler, false);
    eski.devamIsId = yeni.isId;
    yeni.oncekiIsId = eski.isId;
    try {
      this.kaydet();
    } catch (e) {
      this.isler.delete(yeni.isId);
      delete eski.devamIsId;
      throw e;
    }
    this.olay(yeni, "is:devam", { öncekiIsId: isId });
    if (eski.tur === "klonla") {
      const param = eski.parametreler?.klonla;
      if (param === undefined) {
        yeni.durum = "hata";
        yeni.hata = { code: KODLAR.INTERNAL, message: "Eski işin klon parametreleri bulunamadı; güvenli devam için yeni iş başlatın." };
        yeni.bitisAt = new Date().toISOString();
        this.kaydet();
      } else void this.calistir(yeni, () => this.klonla(yeni, param));
    } else if (eski.tur === "onar") {
      // P06b — devam eden onarım AYNI hedefleri dener. Hedefi olmayan bir
      // kayıt "hepsini onar"a genişletilmez: seçim kullanıcınındır.
      const hedefler = eski.parametreler?.onar?.hedefler;
      if (hedefler === undefined || hedefler.length === 0) {
        yeni.durum = "hata";
        yeni.hata = { code: KODLAR.INTERNAL, message: "Eski onarım işinin hedefleri bulunamadı; denetim ekranından yeniden seçin." };
        yeni.bitisAt = new Date().toISOString();
        this.kaydet();
      } else void this.calistir(yeni, () => this.onar(yeni, eski.caseKey, [...hedefler]));
    } else {
      void this.calistir(yeni, () => this.esitle(yeni, eski.caseKey));
    }
    return yeni;
  }

  // ── iş kayıt ve izleme ──────────────────────────────────────────────

  private isYap(tur: IsKaydi["tur"], caseKey: string, parametreler?: IsParametreleri, kaydet = true): IsKaydi {
    if (this.kapanis) throw new Hata(KODLAR.IS_BUSY, "Motor kapanıyor");
    const isId = `is-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const kayit: IsKaydi = {
      isId,
      tur,
      caseKey,
      durum: "bekliyor",
      baslamaAt: new Date().toISOString(),
      ilerleme: { toplam: 0, biten: 0 },
      ...(parametreler !== undefined ? { parametreler } : {}),
    };
    this.isler.set(isId, kayit);
    if (kaydet) {
      try {
        this.kaydet();
      } catch (e) {
        this.isler.delete(isId);
        throw e;
      }
    }
    return kayit;
  }

  isGetir(isId: string): IsKaydi | undefined {
    return this.isler.get(isId);
  }

  islerHepsi(): IsKaydi[] {
    return [...this.isler.values()].sort((a, b) => a.baslamaAt.localeCompare(b.baslamaAt));
  }

  private olay(is: IsKaydi, tip: string, veri?: Record<string, unknown>): void {
    this.sec.olaylar.bas(tip, { isId: is.isId, caseKey: is.caseKey, ...veri });
  }

  private durumKoy(is: IsKaydi, durum: IsDurum): void {
    is.durum = durum;
    if (durum === "hazir" || durum === "eksikli" || durum === "hata" || durum === "iptal" || durum === "duraklatildi" || durum === "kesildi") {
      is.bitisAt = new Date().toISOString();
      if (this.butceAlinanIsler.delete(is.isId)) this.sec.fren.isBitti();
    }
    this.kaydet();
    this.olay(is, "is:durum", { durum });
  }

  private calistir(is: IsKaydi, kurulum: () => Promise<unknown>): Promise<void> {
    const kilitSahibi = !this.mesgulCase.has(is.caseKey);
    const islem = this.calistirIc(is, kurulum).catch((e: unknown) => {
      this.depoHatasi = e instanceof Error ? e : new Error(String(e));
      is.durum = "hata";
      is.hata = { code: KODLAR.INTERNAL, message: "İş geçmişi kaydedilemedi; motoru yeniden başlatmadan önce disk erişimini kontrol edin." };
      this.olay(is, "is:durum", { durum: is.durum });
    }).finally(() => {
      this.calisanlar.delete(islem);
      if (kilitSahibi) this.mesgulCase.delete(is.caseKey);
      if (this.butceAlinanIsler.delete(is.isId)) this.sec.fren.isBitti();
    });
    this.calisanlar.add(islem);
    return islem;
  }

  private async calistirIc(is: IsKaydi, kurulum: () => Promise<unknown>): Promise<void> {
    if (this.mesgulCase.has(is.caseKey)) {
      is.hata = { code: KODLAR.IS_BUSY, message: "bu dava için zaten iş sürüyor" };
      this.durumKoy(is, "hata");
      return;
    }
    this.mesgulCase.add(is.caseKey);
    this.durumKoy(is, "calisiyor");
    try {
      this.sec.fren.isBaslamadan();
      this.butceAlinanIsler.add(is.isId);
    } catch (e) {
      is.hata = { code: e instanceof Hata ? e.code : KODLAR.INTERNAL, message: (e as Error).message };
      this.durumKoy(is, "hata");
      this.mesgulCase.delete(is.caseKey);
      return;
    }
    try {
      const sonuc = await kurulum();
      if (is.iptalIsteniyor) {
        this.durumKoy(is, "iptal");
      } else if (this.kapanis) {
        this.durumKoy(is, "kesildi");
      } else if (is.durum !== "duraklatildi") {
        is.sonuc = sonuc;
        this.durumKoy(is, isEksikSonuc(sonuc) ? "eksikli" : "hazir");
      }
    } catch (e) {
      if (is.iptalIsteniyor) {
        is.iptalIsteniyor = true;
        this.durumKoy(is, "iptal");
      } else if (this.kapanis) {
        this.durumKoy(is, "kesildi");
      } else {
        is.hata =
          e instanceof Hata
            ? { code: e.code, message: e.message }
            : { code: KODLAR.INTERNAL, message: e instanceof Error ? e.message : String(e) };
        this.durumKoy(is, "hata");
        if (is.hata.code === KODLAR.OTURUM_BITTI) this.sec.fren.cooldownBaslat(60_000);
      }
    } finally {
      this.kesmeler.delete(is.isId);
      this.mesgulCase.delete(is.caseKey);
    }
  }

  private kesmeDurumu(is: IsKaydi): "devam" | "duraklat" | "iptal" {
    if (this.depoHatasi) throw this.depoHatasi;
    if (this.kapanis) throw new Hata(KODLAR.IS_BUSY, "Motor kapanıyor");
    const k = this.kesmeler.get(is.isId);
    if (k === "duraklat") return "duraklat";
    if (k === "iptal") return "iptal";
    return "devam";
  }

  // ── klonla ──────────────────────────────────────────────────────────

  klonlaBaslat(istek: KlonlaIstek): IsKaydi {
    const key = caseKeyYap(istek.birimAdi, istek.esasNo);
    const is = this.isYap("klonla", key, { klonla: { ...istek } });
    void this.calistir(is, () => this.klonla(is, istek));
    return is;
  }

  private async klonla(is: IsKaydi, istek: KlonlaIstek): Promise<{ klonYolu: string; evrakSayisi: number; eksikEvrak: number }> {
    this.olay(is, "klonla", { asama: "arama", birim: istek.birimAdi, esas: istek.esasNo });
    const dava = await this.davaBul(istek.birimAdi, istek.esasNo, istek.kapsam);

    const kayit = this.registryKaydiOlustur(dava, istek);
    const { evraklar } = await this.sec.api.evraklariListele(dava.dosyaId);
    this.olay(is, "klonla", { asama: "evrak-listelendi", adet: evraklar.length });

    const klasor = davaKlasoru(
      this.sec.kok,
      kayit.hesap ?? istek.avukat,
      kayit.group,
      kayit.kod,
      dava.birimAdi,
      dava.esasNo
    );
    kapsamKontrol(this.sec.kok, klasor);
    mkdirSync(join(klasor, "_kaynak"), { recursive: true });
    kayit.klonYolu = klasor;
    kayit.klonAt = new Date().toISOString();
    this.klasorCaseKey.set(klasor, kayit.caseKey);
    // duraklatma/iş kesilirse resume registry'den klasörü bulsun
    this.sec.registry.koy(kayit);
    await this.taraflariTazele(is, kayit, dava.dosyaId);

    const manifestDepo = new ManifestDepo(join(klasor, "uyap-project.json"));
    const oncekiManifest = manifestDepo.oku();
    const manifest: Manifest = {
      dosyaId: dava.dosyaId,
      mahkeme: dava.birimAdi,
      birimId: dava.birimId,
      esasNo: dava.esasNo,
      caseType: dava.dosyaTur,
      indirenAvukat: istek.avukat,
      isIcra: false,
      clonedAt: oncekiManifest?.clonedAt ?? new Date().toISOString(),
      // P15b — bu literal manifest'i SIFIRDAN kurar: taşınmayan her alan
      // yeniden klonlamada sessizce DÜŞER. `lastSyncedAt` bugüne kadar
      // düşüyordu; damga işaretçileriyle birlikte taşınıyor. Düşseydi mevcut
      // bir arşivin yeniden klonlanması bütün rozetleri siler ve arşivi "ilk
      // indirme" sanardı.
      lastSyncedAt: oncekiManifest?.lastSyncedAt,
      sonEsitleme: oncekiManifest?.sonEsitleme,
      acikEsitleme: oncekiManifest?.acikEsitleme,
      evraklar: oncekiManifest?.evraklar ?? [],
    };
    // Daha önce hiç TAMAMLANMIŞ eşitleme yoksa bu bir ilk indirmedir; ölçü
    // kayıt sayısı değildir (duraklatılıp devam ettirilen ilk klon da ilk
    // indirmedir). Commit'ten ÖNCE okunur — commit bu alanı yazacak.
    const ilkIndirme = manifest.lastSyncedAt === undefined && manifest.sonEsitleme === undefined;
    const esitlemeId = esitlemeKimligiSec(manifest.acikEsitleme);
    manifestDepo.yaz(manifest);

    const indirilen = await this.evraklariIndir(is, klasor, manifest, evraklar, dava.dosyaId, esitlemeId);
    if (indirilen.duraklatildi) {
      return { klonYolu: klasor, evrakSayisi: manifest.evraklar.length, eksikEvrak: indirilen.hatali };
    }
    await this.donusumleriTetikle(is, klasor, manifest);
    manifest.lastSyncedAt = new Date().toISOString();
    esitlemeyiKapat(manifest, esitlemeId, "klonla", ilkIndirme);
    manifestDepo.yaz(manifest);

    kayit.sonEvrakSayisi = manifest.evraklar.length;
    kayit.sonEvrakAt = manifest.lastSyncedAt;
    this.sec.registry.koy(kayit);
    this.olay(is, "klonla", { asama: "bitti", ...indirilen });
    return { klonYolu: klasor, evrakSayisi: manifest.evraklar.length, eksikEvrak: indirilen.hatali };
  }

  private async davaBul(birimAdi: string, esasNo: string, kapsam: "acik" | "kapali" | "hepsi"): Promise<DavaBilgi> {
    const [yil, sira] = esasNo.split("/");
    if (yil === undefined || sira === undefined || !/^\d{4}$/.test(yil) || !/^\d+$/.test(sira)) {
      throw new Hata(KODLAR.INVALID_INPUT, `esasNo biçimi YYYY/SIRA olmalı: ${esasNo}`);
    }
    const sonuc = await this.sec.api.davalarim({
      birimAdi,
      esasYil: yil,
      esasSira: sira,
      kapsam,
    });
    const eslesen = sonuc.filter((d) => d.esasNo === esasNo);
    if (eslesen.length === 0) {
      throw new Hata(KODLAR.NOT_FOUND, `${birimAdi} ${esasNo} bulunamadı (kapsam=${kapsam})`);
    }
    if (eslesen.length > 1) {
      throw new Hata(
        KODLAR.INVALID_INPUT,
        `çift eşleşme (AMBIGUOUS_CASE): ${birimAdi} ${esasNo} — ${eslesen.length} kayıt`,
        { adaylar: eslesen.map((e) => ({ dosyaTur: e.dosyaTur, durum: e.dosyaDurum })) }
      );
    }
    const d: DosyaSatiri = eslesen[0]!;
    const birim = await this.sec.api.birimler.coz(d.birimAdi);
    return {
      dosyaId: d.dosyaId,
      birimAdi: d.birimAdi,
      esasNo: d.esasNo,
      dosyaDurum: d.dosyaDurum,
      dosyaTur: d.dosyaTur,
      birimId: birim.birimId,
      yargiTuru: birim.yargiTuru,
    };
  }

  private registryKaydiOlustur(dava: DavaBilgi, istek: KlonlaIstek): DavaKaydi {
    const birimAdi = istek.birimAdi;
    const grup = istek.grup ?? turGrup(dava.dosyaTur, birimAdi);
    const kod = istek.kod ?? turKod(birimAdi);
    const caseKey = caseKeyYap(birimAdi, dava.esasNo);
    // P18b — bu literal kaydı SIFIRDAN kurar (P15b'nin manifest literalindeki
    // tuzağın registry ikizi): taşınmayan alan yeniden klonlamada sessizce
    // DÜŞER. Taraf sorgusu bu klonda başarısız olursa "eski değer korunur"
    // sözü ancak burada taşınırsa tutar.
    const onceki = this.sec.registry.oku().davalar.find((d) => d.caseKey === caseKey);
    return {
      caseKey,
      portal: "avukat",
      kaynak: ["portal"],
      dosyaNo: dava.esasNo,
      birimAdi,
      birimId: dava.birimId,
      group: grup,
      kod,
      yargiTuru: dava.yargiTuru,
      dosyaTur: dava.dosyaTur,
      dosyaDurum: dava.dosyaDurum,
      isIcra: false,
      isCbs: false,
      hesap: istek.avukat === "*" ? undefined : istek.avukat,
      kapsam: `klonla:${istek.kapsam}`,
      portalGoruldu: new Date().toISOString(),
      ...(onceki?.taraflar !== undefined ? { taraflar: onceki.taraflar } : {}),
      ...(onceki?.taraflarAt !== undefined ? { taraflarAt: onceki.taraflarAt } : {}),
    };
  }

  /**
   * P18b — dosya taraflarını klon/eşitleme başına BİR KEZ çekip registry'ye
   * yazar. Arşiv satırı bunu OFFLINE gösterir; oturum gerekmez.
   *
   * TARAF, EVRAKIN ÖNÜNE GEÇMEZ. Sorgu başarısız olursa iş DÜŞMEZ: eski değer
   * olduğu gibi korunur, uyarı olay günlüğüne yazılır, evrak indirme kaldığı
   * yerden devam eder. Sorun deposuna kayıt AÇILMAZ — P16 kararı 1 gereği
   * sayaç kullanıcının düzeltebileceği EVRAK kayıtlarını sayar; taraf
   * bilgisinin gelmemesi ne evrakı ne eşitlemeyi eksik bırakır.
   *
   * FREN: istek `UyapIstemci` üzerinden gittiği için asgari istek aralığından
   * geçer ama İŞ SAYACINI ARTIRMAZ — `fren.isBaslamadan()` iş başına bir kez
   * `calistir` içinde çağrılır, portal isteği başına değil.
   *
   * GİZLİLİK: uyarıya yalnız hata mesajı (HTTP/rc) ve SAYI girer; taraf adı
   * olay günlüğüne yazılmaz.
   */
  private async taraflariTazele(is: IsKaydi, kayit: DavaKaydi, dosyaId: string): Promise<void> {
    try {
      const taraflar = taraflariCoz(await taraflariGetir(this.sec.api.istemci, dosyaId));
      if (taraflar.length === 0) {
        // Boş yanıt ELDEKİNİ EZMEZ: portal "taraf yok" ile "taraf gelmedi"yi
        // ayırt edecek bir işaret vermiyor; eski kayıt yanlış olmaktansa
        // bayat kalsın.
        this.olay(is, "taraf", { asama: "bos", yazildi: false });
        return;
      }
      kayit.taraflar = taraflar;
      kayit.taraflarAt = new Date().toISOString();
      this.sec.registry.koy(kayit);
      this.olay(is, "taraf", { asama: "yazildi", adet: taraflar.length });
    } catch (e) {
      this.olay(is, "taraf", {
        asama: "atlandi",
        uyari: e instanceof Error ? e.message : String(e),
        korunan: kayit.taraflar?.length ?? 0,
      });
    }
  }

  // ── esitle ──────────────────────────────────────────────────────────

  esitleBaslat(caseKey: string): IsKaydi {
    const is = this.isYap("esitle", caseKey);
    void this.calistir(is, () => this.esitle(is, caseKey));
    return is;
  }

  /** Kuyruk kaydı portal erişiminden önce yazılır; tamamlanınca sonraki dosya başlayabilir. */
  async esitleSirali(caseKey: string, kayitHazir: (is: IsKaydi) => void): Promise<IsKaydi> {
    const is = this.isYap("esitle", caseKey);
    try { kayitHazir(is); }
    catch (e) {
      is.hata = { code: KODLAR.INTERNAL, message: "Toplu iş kaydı yazılamadı; dosya başlatılmadı." };
      this.durumKoy(is, "hata");
      throw e;
    }
    await this.calistir(is, () => this.esitle(is, caseKey));
    return is;
  }

  private async esitle(is: IsKaydi, caseKey: string): Promise<{ yeniEvrak: number; yenilenenEvrak: number; korunanEvrak: number; klonYolu?: string; eksikEvrak: number }> {
    const kayit = this.sec.registry.oku().davalar.find((d) => d.caseKey === caseKey);
    if (!kayit || kayit.klonYolu === undefined) {
      throw new Hata(KODLAR.NOT_FOUND, `klonlanmamış dava: ${caseKey.replace("\u0000", " ")}`);
    }
    const klasor = kayit.klonYolu;
    const manifestDepo = new ManifestDepo(join(klasor, "uyap-project.json"));
    const manifest = manifestDepo.oku();
    if (!manifest) throw new Hata(KODLAR.NOT_FOUND, "manifest yok; yeniden klonlayın");

    const [birimAdi, esasNo] = caseKeyCoz(caseKey);
    this.klasorCaseKey.set(klasor, caseKey);
    this.olay(is, "esitle", { asama: "evrak-listeleme", dava: `${birimAdi} ${esasNo}` });
    const dava = await this.davaBul(birimAdi, esasNo, "hepsi");
    const { evraklar } = await this.sec.api.evraklariListele(dava.dosyaId);
    manifest.dosyaId = dava.dosyaId;
    this.olay(is, "esitle", { asama: "evrak-listelendi", adet: evraklar.length });
    await this.taraflariTazele(is, kayit, dava.dosyaId);

    const ilkIndirme = manifest.lastSyncedAt === undefined && manifest.sonEsitleme === undefined;
    const esitlemeId = esitlemeKimligiSec(manifest.acikEsitleme);

    const indirilen = await this.evraklariIndir(is, klasor, manifest, evraklar, dava.dosyaId, esitlemeId);
    if (indirilen.duraklatildi) {
      return { yeniEvrak: indirilen.yeni, yenilenenEvrak: indirilen.yenilenen, korunanEvrak: indirilen.atlandi, klonYolu: klasor, eksikEvrak: indirilen.hatali };
    }
    await this.donusumleriTetikle(is, klasor, manifest);
    manifest.lastSyncedAt = new Date().toISOString();
    esitlemeyiKapat(manifest, esitlemeId, "esitle", ilkIndirme);
    manifestDepo.yaz(manifest);
    this.olay(is, "esitle", { asama: "bitti", ...indirilen });
    kayit.sonEvrakSayisi = manifest.evraklar.length;
    kayit.sonEvrakAt = manifest.lastSyncedAt;
    this.sec.registry.koy(kayit);
    return { yeniEvrak: indirilen.yeni, yenilenenEvrak: indirilen.yenilenen, korunanEvrak: indirilen.atlandi, klonYolu: klasor, eksikEvrak: indirilen.hatali };
  }

  // ── P06b — SEÇİLİ ONARIM (AĞ) ───────────────────────────────────────
  //
  // `esitle`nin yerine GEÇMEZ: hedef, kullanıcının denetim ekranından seçtiği
  // EVRAK KÜMESİDİR (yollarıyla). Bütün davayı yeniden indirmek onarım değildir.
  //
  // ÜÇ MUTLAK KURAL:
  //  1. BAYAT RAPORDAN ONARIM YAPILMAZ. Manifest ve kaynak, iş başlarken
  //     YENİDEN ölçülür (`kaynakOnarimPlani`). Ölçüm "zaten yerinde" diyorsa o
  //     satır atlanır; bütün satırlar atlanıyorsa PORTALA TEK İSTEK GİTMEZ.
  //  2. KİMLİK BELİRSİZSE İŞLEM DURUR. Portalın hiçbir kimliği kalıcı değil
  //     (P20); satır ancak grup TEKİLSE (portal 1 / manifest 1) ve eşleştirici
  //     onu bu kayda bağlıyorsa indirilir. "En iyi tahminle" başka bir belgeyi
  //     indirmek YASAK.
  //  3. YERİNDE DURAN DOSYA EZİLMEZ. Ölçüt tek yerde: `hamDosyaKaydiTutuyorMu`
  //     (src/store/manifest.ts). Dosya yoksa kayıtlı yola yazılır (onarım);
  //     duruyor ama kaydı tutmuyorsa YENİ yol açılır, eskisi olduğu gibi kalır.
  onarBaslat(caseKey: string, hedefler: readonly string[]): IsKaydi {
    const liste = [...hedefler];
    const is = this.isYap("onar", caseKey, { onar: { hedefler: liste } });
    void this.calistir(is, () => this.onar(is, caseKey, liste));
    return is;
  }

  private async onar(is: IsKaydi, caseKey: string, hedefler: string[]): Promise<OnarimIsSonucu> {
    const kayit = this.sec.registry.oku().davalar.find((d) => d.caseKey === caseKey);
    if (!kayit || kayit.klonYolu === undefined) {
      throw new Hata(KODLAR.NOT_FOUND, `klonlanmamış dava: ${caseKey.replace("\u0000", " ")}`);
    }
    const klasor = kayit.klonYolu;
    this.klasorCaseKey.set(klasor, caseKey);
    const manifestDepo = new ManifestDepo(join(klasor, MANIFEST_ADI));
    const manifest = manifestDepo.oku();
    if (!manifest) throw new Hata(KODLAR.NOT_FOUND, "manifest yok; yeniden klonlayın");

    const satirlar: OnarimIsSatiri[] = [];
    let yedek: string | undefined;
    is.ilerleme.toplam = hedefler.length;
    const sonuc = (duraklatildi: boolean): OnarimIsSonucu => ({
      klonYolu: klasor,
      istenen: hedefler.length,
      onarilan: satirlar.filter((x) => x.durum === "onarildi").length,
      atlanan: satirlar.filter((x) => x.durum === "zaten-yerinde").length,
      eksikEvrak: satirlar.filter(
        (x) => x.durum !== "onarildi" && x.durum !== "zaten-yerinde",
      ).length,
      ...(yedek !== undefined ? { yedek } : {}),
      satirlar,
      ...(duraklatildi ? { duraklatildi: true } : {}),
    });
    const ilerlemeyiKaydet = () => {
      is.sonuc = sonuc(false);
      this.kaydet();
    };
    ilerlemeyiKaydet();

    // 1) YEREL ÖN ÖLÇÜM — portal isteğinden ÖNCE (bayat rapor kapısı).
    const bekleyen: { rel: string; kayit: ManifestEvrak }[] = [];
    for (const rel of hedefler) {
      const plan = kaynakOnarimPlani(this.sec.kok, klasor, rel);
      const hedefKayit = manifest.evraklar.filter((k) => k?.path === rel);
      if (!plan.yapilabilir || hedefKayit.length !== 1) {
        satirlar.push({ yol: rel, durum: plan.durum, aciklama: plan.aciklama });
        is.ilerleme.biten++;
        ilerlemeyiKaydet();
        continue;
      }
      bekleyen.push({ rel, kayit: hedefKayit[0]! });
    }
    if (bekleyen.length === 0) {
      this.olay(is, "onar", { asama: "yapilacak-is-yok", istenen: hedefler.length });
      return sonuc(false);
    }

    // 2) KİMLİK BU TURDA ÇÖZÜLÜR — portalın kimlikleri kalıcı değil.
    const [birimAdi, esasNo] = caseKeyCoz(caseKey);
    this.olay(is, "onar", { asama: "evrak-listeleme", hedef: bekleyen.length });
    const dava = await this.davaBul(birimAdi, esasNo, "hepsi");
    const { evraklar } = await this.sec.api.evraklariListele(dava.dosyaId);
    this.olay(is, "onar", { asama: "evrak-listelendi", adet: evraklar.length });
    const anaEvraklar = evraklar.filter((e) => !ekEvrakMi(e));
    const anahtarlar = evraklar.map((e) => portalAnahtari(e, anaEvraklar));
    const eslesme = evraklariEslestir(
      anahtarlar,
      manifest.evraklar.map((k) => ({ anahtar: kayitAnahtari(k), kayit: k })),
    );

    for (const { rel, kayit: hedefKayit } of bekleyen) {
      const kesme = this.kesmeDurumu(is);
      if (kesme === "iptal") throw new Hata(KODLAR.INTERNAL, "iptal edildi");
      if (kesme === "duraklat") {
        this.durumKoy(is, "duraklatildi");
        return sonuc(true);
      }
      const grup = kayitAnahtari(hedefKayit).grup;
      const olcum = grup === null ? undefined : eslesme.gruplar.get(grup);
      const indeks = grup === null ? -1 : anahtarlar.findIndex((a) => a.grup === grup);
      if (
        grup === null ||
        olcum === undefined ||
        olcum.portal !== 1 ||
        olcum.manifest !== 1 ||
        indeks < 0 ||
        eslesme.esler.get(indeks) !== hedefKayit
      ) {
        satirlar.push({
          yol: rel,
          durum: "kimlik-belirsiz",
          aciklama:
            "Portalın güncel listesinde bu evrak tekil olarak bulunamadı; yanlış belgeyi indirmemek için onarım durdu.",
        });
        is.ilerleme.biten++;
        ilerlemeyiKaydet();
        continue;
      }
      const satir = evraklar[indeks]!;
      const ana = ekEvrakMi(satir)
        ? anaEvraklar.find((a) => a.evrakId === anaEvrakId(satir))
        : undefined;
      let yanit;
      try {
        yanit = await this.sec.api.istemci.baytlar(satir.evrakId, dava.dosyaId);
      } catch (err) {
        if (this.kapanis || this.depoHatasi) throw err;
        // Oturum öldüyse işi DURDUR: tamamlanan satırlar diskte kalır.
        if (err instanceof Hata && err.code === KODLAR.OTURUM_BITTI) throw err;
        const mesaj = err instanceof Error ? err.message : String(err);
        this.sec.olaylar.bas("evrak:indirme-hatasi", { evrakId: satir.evrakId, tur: satir.tur, hata: mesaj });
        this.sorunEkle(klasor, satir, "indirme", mesaj);
        satirlar.push({ yol: rel, durum: "indirilemedi", aciklama: `Belge indirilemedi: ${mesaj}` });
        is.ilerleme.biten++;
        ilerlemeyiKaydet();
        continue;
      }
      if (yanit.durum >= 400) {
        this.sec.olaylar.bas("evrak:indirme-hatasi", { evrakId: satir.evrakId, durum: yanit.durum, tur: satir.tur });
        this.sorunEkle(klasor, satir, "indirme", `portal ${yanit.durum} döndü`);
        satirlar.push({ yol: rel, durum: "indirilemedi", aciklama: `Portal ${yanit.durum} döndü; belge inmedi.` });
        is.ilerleme.biten++;
        ilerlemeyiKaydet();
        continue;
      }
      if (evrakYuklenmemisMi(yanit.baytlar, yanit.basliklar["content-type"] ?? "")) {
        const mesaj = yuklenmemisMesaji(yanit.baytlar) || "Evrak UYAP sistemine yüklenmemiş";
        this.sec.olaylar.bas("evrak:yuklenmemis", { evrakId: satir.evrakId, tur: satir.tur, mesaj });
        this.sorunEkle(klasor, satir, "yuklenmemis", mesaj);
        satirlar.push({ yol: rel, durum: "yuklenmemis", aciklama: `${mesaj}; onarılacak bir belge yok.` });
        is.ilerleme.biten++;
        ilerlemeyiKaydet();
        continue;
      }
      const ct = (yanit.basliklar["content-type"] ?? "").split(";")[0]!.trim();
      const uzanti = contentTipiUzanti(ct, yanit.baytlar);
      const { kat, hedefDizin, tabanAd } = evrakKonumu(klasor, satir, ana);
      kapsamKontrol(this.sec.kok, join(hedefDizin, tabanAd));
      // YERİNDE DURAN DOSYA EZİLMEZ (ölçüt: hamDosyaKaydiTutuyorMu). Yol ancak
      // dosya GERÇEKTEN yoksa ve uzantı aynıysa yeniden kullanılır.
      let hedef: string | undefined;
      const yerindeYol = join(klasor, hedefKayit.path);
      if (
        hamDosyaKaydiTutuyorMu(klasor, hedefKayit) &&
        kapsamIcindeMi(klasor, yerindeYol) &&
        !existsSync(yerindeYol) &&
        extname(hedefKayit.path).toLowerCase() === `.${uzanti}`
      ) {
        hedef = yerindeYol;
      }
      const yerindeYazildi = hedef !== undefined;
      if (hedef === undefined) hedef = bosHedefSec(hedefDizin, tabanAd, satir, uzanti);
      kapsamKontrol(this.sec.kok, hedef);
      // YEDEKSİZ YAZILMAZ: ilk değişiklikten önce manifest kopyalanır.
      yedek ??= manifestiYedekle(klasor);
      mkdirSync(dirname(hedef), { recursive: true });
      yazMetinAtomik(hedef, yanit.baytlar);
      const yeniKayit = manifestKaydiYap(satir, klasor, hedef, yanit.baytlar, kat, ana, false);
      // Kaydın KÖKENİ değişmez: onarım bir eşitleme değildir, yeni indirme
      // damgası BASMAZ (rozet "son eşitlemede indi" demektir) ve yedek kopya
      // işareti olduğu gibi taşınır.
      if (hedefKayit.indirmeDamgasi !== undefined) yeniKayit.indirmeDamgasi = hedefKayit.indirmeDamgasi;
      if (hedefKayit.belirsizKopya === true) yeniKayit.belirsizKopya = true;
      const yer = manifest.evraklar.indexOf(hedefKayit);
      if (yer >= 0) manifest.evraklar[yer] = yeniKayit;
      else manifest.evraklar.push(yeniKayit);
      manifestDepo.yaz(manifest);
      this.sorunCozuldu(caseKey, satir.evrakId, "indirme");
      // Kaynak yenilendi: eski metin artık bu belgeyi anlatmıyor.
      const donusum = this.donusumUygula(caseKey, klasor, yeniKayit);
      manifestDepo.yaz(manifest);
      satirlar.push({
        yol: rel,
        durum: "onarildi",
        yeniYol: yeniKayit.path,
        yerinde: yerindeYazildi,
        mdStatus: donusum.mdStatus,
        aciklama: yerindeYazildi
          ? "Belge portaldan indirildi ve kayıtlı yoluna yazıldı."
          : "Belge portaldan indirildi; yerindeki dosya EZİLMEDİ, yeni kopya ayrı bir yola yazıldı.",
      });
      is.ilerleme.biten++;
      ilerlemeyiKaydet();
    }
    this.olay(is, "onar", { asama: "bitti", ...ozetSayilari(satirlar) });
    return sonuc(false);
  }

  // ── ortak gövdeler ──────────────────────────────────────────────────

  private async evraklariIndir(
    is: IsKaydi,
    klasor: string,
    manifest: Manifest,
    evraklar: EvrakSatiri[],
    dosyaId: string,
    esitlemeId: string
  ): Promise<{ yeni: number; yenilenen: number; atlandi: number; hatali: number; duraklatildi: boolean }> {
    let yeni = 0;
    let yenilenen = 0;
    let atlandi = 0;
    let hatali = 0;
    const ilerlemeyiKaydet = () => {
      if (is.tur === "esitle") is.sonuc = { yeniEvrak: yeni, yenilenenEvrak: yenilenen, korunanEvrak: atlandi, eksikEvrak: hatali, klonYolu: klasor };
      this.kaydet();
    };
    is.ilerleme.toplam = evraklar.length;
    ilerlemeyiKaydet();
    this.olay(is, "evrak", { asama: "indirme", toplam: evraklar.length });

    const guncelKimlikler = new Set(evraklar.map(e => e.evrakId));
    const tekil = ayniKaynakTekillestir(manifest.evraklar, guncelKimlikler);
    if (tekil.length < manifest.evraklar.length) {
      // Kaynaklar silinmez. Eski manifest kurtarılabilir biçimde saklanır.
      // P06c — AD KALIBI TEK YERDE: burada kendi `Date.now()` adını kuran bir
      // kopya vardı ve aynı milisaniyede ikinci yedek `EEXIST` ile eşitlemeyi
      // düşürüyordu; artık `manifestiYedekle` çağrılır (çakışmada sıra
      // numarası alır) ve denetim aynı deseni yetim saymaz.
      kapsamKontrol(this.sec.kok, join(klasor, MANIFEST_ADI));
      const yedek = manifestiYedekle(klasor);
      // Yedeğin ADI olaya yazılır: kesintiden sonra "hangi yedek geçerli"
      // sorusunun yanıtı iş geçmişinde dursun (P06c).
      this.olay(is, "manifest", { asama: "tekrarlar-birlestirildi", once: manifest.evraklar.length, sonra: tekil.length, yedek });
      manifest.evraklar = tekil;
      new ManifestDepo(join(klasor, "uyap-project.json")).yaz(manifest);
    }
    const anaEvraklar = evraklar.filter((e) => !ekEvrakMi(e));
    const ekler = evraklar.filter((e) => ekEvrakMi(e));

    // ── P19 — KÜME BAZLI KİMLİK ───────────────────────────────────────────
    // Eski kapanış (`oncekiAdaylar`) belirsiz grupta eski kaydı aday
    // GÖSTERMİYORDU. Gerekçesi doğruydu — yanlış belgeyi yanlış kayda
    // iliştirmemek — ama bedeli sınırsızdı: portalın kimliği her istekte
    // değiştiği için grup her eşitlemede yeniden inip yeni satır oluyordu
    // (kullanıcının dosyasında ölçüldü: 108 → 114 → 116 kayıt, bir grup
    // 1 → 3 → 5 satır, portalda HİÇBİR ŞEY değişmeden).
    //
    // Temkin KALDIRILMADI, BEDELİ SINIRLANDI: eşleşme grup DIŞINA asla
    // taşmaz ve her portal satırına EN ÇOK BİR kayıt düşer. Kural ve
    // gerekçeleri src/store/eslestir.ts'tedir; burada yalnız portal ve
    // manifest satırları o modülün anahtarına çevrilir.
    const anahtarlar = evraklar.map((e) => portalAnahtari(e, anaEvraklar));
    const eslesme = evraklariEslestir(
      anahtarlar,
      manifest.evraklar.map((k) => ({ anahtar: kayitAnahtari(k), kayit: k })),
    );
    const ozet = grupOzeti(eslesme.gruplar);
    this.olay(is, "evrak", { asama: "kume-esleme", ...ozet, eslesen: eslesme.esler.size });
    // P19 — PORTALIN GRUP SAYIMI MANİFESTE YAZILIR. Denetim ve sadeleştirme
    // portala bakamaz; "manifestte 5 kayıt var" tek başına fazlalık kanıtı
    // DEĞİLDİR, çünkü portal aynı şablonu iki satır olarak bildiriyor
    // olabilir. Harita her listelemede BAŞTAN yazılır: portaldan düşen grubun
    // eski sayısı geride kalıp yanlış "fazlalık" doğurmasın.
    manifest.grupSayilari = Object.fromEntries(
      [...eslesme.gruplar].map(([anahtar, o]) => [anahtar, o.portal]),
    );
    // Eşleme BİR KEZ, indirme döngüsünden ÖNCE kurulur: döngü manifest
    // dizisini her evrakta yeniden yazıyor, sonradan hesaplanan bir eşleme
    // kendi yazdığı satırları "eski kayıt" sanardı.
    const esKayit = new Map<EvrakSatiri, ManifestEvrak>();
    for (const [i, kayit] of eslesme.esler) esKayit.set(evraklar[i]!, kayit);
    const oncekiAdaylar = (e: EvrakSatiri): ManifestEvrak[] => {
      const es = esKayit.get(e);
      return es === undefined ? [] : [es];
    };
    // ── P20 — BELİRSİZ GRUPTA ÜYE DEĞİŞİMİ ────────────────────────────────
    // Belirsiz grupta (portalda ya da manifestte birden çok satır) eşleşme bir
    // SIRA TAHMİNİDİR. O satırlarda "dosyanın hash'i kaydı tutuyor, atla"
    // kestirmesi kullanılmaz: kestirme, portalın GERÇEKTEN başka olan belgesini
    // eldeki bir kaydın üstüne düşürüp "korunan" sayıyor ve belge HİÇ inmiyordu
    // (ölçüldü; bkz. src/store/eslestir.ts).
    //
    // İndirmek YAZMAK DEĞİLDİR: inen içeriğin metni gruptaki bir kaydın
    // metnini birebir tutuyorsa o kayıt ve dosyası olduğu gibi KORUNUR.
    // Karar `src/store/tazeleme.ts`de; burada yalnız havuz kurulur ve satır
    // başına bağlam verilir.
    const belirsizGrup = new Set<string>();
    for (const [g, o] of eslesme.gruplar) if (o.portal > 1 || o.manifest > 1) belirsizGrup.add(g);
    const havuzGirisi = new Map<string, AdayKayit[]>();
    if (belirsizGrup.size > 0) {
      for (const k of manifest.evraklar) {
        const g = kayitAnahtari(k).grup;
        if (g === null || !belirsizGrup.has(g)) continue;
        const liste = havuzGirisi.get(g) ?? [];
        // `ezilebilir` TEMBELDİR: dosyayı okuyup özetlemek pahalı ve kayıtların
        // çoğu hiç kurban adayı olmaz. Sonuç tur boyunca memoize edilir
        // (`??=` yalnız undefined'da yeniden ölçer, `false` da hatırlanır).
        let ezilir: boolean | undefined;
        liste.push({
          kayit: k,
          metin: mdOzeti(klasor, k),
          bayt: typeof k.sha256 === "string" ? k.sha256 : "",
          ezilebilir: () => (ezilir ??= hamDosyaKaydiTutuyorMu(klasor, k)),
        });
        havuzGirisi.set(g, liste);
      }
    }
    const havuz = new BelirsizHavuz(havuzGirisi);
    // KİMLİKLE eşleşen satırın kaydı havuza GİRMEZ: o satır yeniden
    // indirilmeyecek, yani kaydı bu turda zaten sahiplidir. Havuzda bırakılsa
    // başka bir satır onu sahiplenir ve iki satır tek kayda düşerdi.
    for (const [i, kayit] of eslesme.esler) if (!eslesme.tazele.has(i)) havuz.sahiplen(kayit);
    // Satır → belirsizlik bağlamı. YALNIZ bu turda gerçekten inecek satırlara
    // verilir: tahminle eşleşenler (`tazele`) ve hiç eşleşmemiş satırlar.
    // Eşleşmemiş satır da havuza sorar — grubun bir kaydı gerçekte O olabilir
    // (eşleştirici yalnız slot kalmadığı için boşta bırakmıştır) ve sormazsa
    // aynı belge ikinci kez kaydedilir (ölçüldü: KABUL 3b).
    const belirsizSatir = new Map<EvrakSatiri, string>();
    evraklar.forEach((e, i) => {
      const g = anahtarlar[i]!.grup;
      if (g === null || !belirsizGrup.has(g)) return;
      if (eslesme.tazele.has(i) || !eslesme.esler.has(i)) belirsizSatir.set(e, g);
    });
    // Satır → AYNI GRUPTA bu satırdan SONRA inecek satır sayısı. `tazeleme.ts`
    // "üzerine mi yazayım, yeni yol mu açayım" kararını bu sayıyla verir.
    // Ana evrak ve ek evrak ayrı döngülerde işleniyor ama bir grup ya bütünüyle
    // ana ya bütünüyle ektir (anahtar "ana"/"ek" ile başlar), yani grup içi
    // işlem sırası `evraklar` sırasıdır.
    const kalanSatir = new Map<EvrakSatiri, number>();
    {
      const sayac = new Map<string, number>();
      for (const g of belirsizSatir.values()) sayac.set(g, (sayac.get(g) ?? 0) + 1);
      const gorulen = new Map<string, number>();
      for (const [e, g] of belirsizSatir) {
        const n = (gorulen.get(g) ?? 0) + 1;
        gorulen.set(g, n);
        kalanSatir.set(e, sayac.get(g)! - n);
      }
    }
    if (belirsizSatir.size > 0)
      this.olay(is, "evrak", { asama: "belirsiz-grup", tazelenen: belirsizSatir.size });

    for (const e of anaEvraklar) {
      const kesme = this.kesmeDurumu(is);
      if (kesme === "iptal") throw new Hata(KODLAR.INTERNAL, "iptal edildi");
      if (kesme === "duraklat") {
        this.durumKoy(is, "duraklatildi");
        return { yeni, yenilenen, atlandi, hatali, duraklatildi: true };
      }
      const r = await this.evrakIndir(klasor, e, dosyaId, undefined, oncekiAdaylar(e), belirsizSatir.get(e), havuz, kalanSatir.get(e) ?? 0);
      if (r !== null) {
        manifest.evraklar = manifest.evraklar.filter((x) => x.evrakId !== e.evrakId && x !== r.onceki);
        damgala(manifest, r, esitlemeId);
        manifest.evraklar.push(r.kayit);
        new ManifestDepo(join(klasor, "uyap-project.json")).yaz(manifest);
        if (r.yeniIndirildi) { if (r.onceki) yenilenen++; else yeni++; }
        else atlandi++;
      } else {
        hatali++;
      }
      is.ilerleme.biten++;
      ilerlemeyiKaydet();
      if (is.ilerleme.biten % 5 === 0 || is.ilerleme.biten === is.ilerleme.toplam) {
        this.olay(is, "evrak", {
          asama: "ilerleme",
          biten: is.ilerleme.biten,
          toplam: is.ilerleme.toplam,
        });
      }
    }
    for (const e of ekler) {
      const kesme = this.kesmeDurumu(is);
      if (kesme === "iptal") throw new Hata(KODLAR.INTERNAL, "iptal edildi");
      if (kesme === "duraklat") {
        this.durumKoy(is, "duraklatildi");
        return { yeni, yenilenen, atlandi, hatali, duraklatildi: true };
      }
      const ana = anaEvraklar.find((a) => a.evrakId === anaEvrakId(e));
      const r = await this.evrakIndir(klasor, e, dosyaId, ana, oncekiAdaylar(e), belirsizSatir.get(e), havuz, kalanSatir.get(e) ?? 0);
      if (r !== null) {
        manifest.evraklar = manifest.evraklar.filter((x) => x.evrakId !== e.evrakId && x !== r.onceki);
        damgala(manifest, r, esitlemeId);
        manifest.evraklar.push(r.kayit);
        new ManifestDepo(join(klasor, "uyap-project.json")).yaz(manifest);
        if (r.yeniIndirildi) { if (r.onceki) yenilenen++; else yeni++; }
        else atlandi++;
      } else {
        hatali++;
      }
      is.ilerleme.biten++;
      ilerlemeyiKaydet();
    }
    return { yeni, yenilenen, atlandi, hatali, duraklatildi: false };
  }

  private async evrakIndir(
    klasor: string,
    e: EvrakSatiri,
    dosyaId: string,
    anaEvrak: EvrakSatiri | undefined,
    kayitlar: ManifestEvrak[],
    /**
     * P20 — satır BELİRSİZ bir gruba düşüyorsa o grubun anahtarı. Dolu olması
     * iki şey demektir: (1) "baytı tutuyor, atla" kestirmesi GEÇERSİZDİR,
     * içerik gerçekten inecek; (2) inen içerik yazılmadan ÖNCE havuza sorulur.
     */
    belirsizGrup: string | undefined,
    havuz: BelirsizHavuz | undefined,
    /** Aynı belirsiz grupta bu satırdan SONRA inecek satır sayısı. */
    kalanSatir = 0
  ): Promise<{ kayit: ManifestEvrak; yeniIndirildi: boolean; onceki?: ManifestEvrak } | null> {
    const onceki = oncekiEvrakBul(kayitlar, e, anaEvrak);
    const { kat, hedefDizin, tabanAd: ilkTabanAd } = evrakKonumu(klasor, e, anaEvrak);
    let tabanAd = ilkTabanAd;
    kapsamKontrol(this.sec.kok, join(hedefDizin, tabanAd));

    // Resume only a manifest-owned file whose identity and bytes agree.
    // A basename alone is not evidence that two portal documents are the same.
    // `belirsizGrup` bu dalı KAPATIR: belirsiz grupta eşleşme sıra tahminidir
    // ve "kaydın hash'i tutuyor" cümlesi "portalın bu SATIRI zaten bende" demek
    // DEĞİLDİR — tahmin yanlışsa portalın başka olan belgesi hiç inmez
    // (ölçüldü). Orada "zaten elimde mi" sorusu indirmeden SONRA, metinle
    // yanıtlanır (aşağıda).
    if (onceki !== undefined && belirsizGrup === undefined) {
      const mevcut = join(klasor, onceki.path);
      kapsamKontrol(this.sec.kok, mevcut);
      if (existsSync(mevcut) && statSync(mevcut).isFile()) {
        const baytlar = readFileSync(mevcut);
        const sha = createHash("sha256").update(baytlar).digest("hex");
        if (sha === onceki.sha256) {
          const kayit = manifestKaydiYap(e, klasor, mevcut, baytlar, kat, anaEvrak, true);
          // manifestKaydiYap kaydı SIFIRDAN kurar; elle taşınmayan alan bir
          // sonraki eşitlemede sessizce silinir. Korunan evrak yeni damga
          // ALMAZ (indirme olmadı) ama eskisini kaybetmemeli — yoksa rozet
          // "bazen kayboluyor" diye görünür, hata vermez.
          if (onceki.indirmeDamgasi !== undefined) kayit.indirmeDamgasi = onceki.indirmeDamgasi;
          if (onceki.mdStatus === "ok" && onceki.mdPath !== undefined) {
            const md = join(klasor, onceki.mdPath);
            kapsamKontrol(this.sec.kok, md);
            if (existsSync(md)) {
              kayit.mdStatus = "ok";
              kayit.mdPath = onceki.mdPath;
            }
          }
          // Evrak yerinde ve baytları doğrulandı: bu evrağa ait AÇIK indirme
          // kaydı artık gerçeği anlatmıyor. Portale istek gitmemiş olması
          // önemli değil — kayıt "evrak inmedi" der, evrak inmiş durumda.
          this.sorunCozuldu(this.klasorCaseKey.get(klasor) ?? klasor, e.evrakId, "indirme");
          return { kayit, yeniIndirildi: false, onceki };
        }
      }
    }
    // 2) İNDİR
    //
    // Hedef dosya adı indirmeden SONRA seçilir (eskiden burada seçiliyordu):
    // belirsiz grupta yol kararı inen İÇERİĞE bağlıdır — tanınan içerik hiçbir
    // yere yazılmaz, tanınmayan içerik eşleşen kaydın YOLUNA yazılır. Ad
    // ayırma indirmeden önce yapılsaydı her tur yeni bir ad rezerve edilir ve
    // disk şişerdi (ölçüldü: eşitleme başına +4 dosya).
    let yanit;
    try {
      yanit = await this.sec.api.istemci.baytlar(e.evrakId, dosyaId);
    } catch (err) {
      if (this.kapanis || this.depoHatasi) throw err;
      // oturum öldüyse işi DURDUR — sürmeye devam anlamsız (doğrulanmış davranış)
      if (err instanceof Hata && err.code === KODLAR.OTURUM_BITTI) throw err;
      this.sec.olaylar.bas("evrak:indirme-hatasi", {
        evrakId: e.evrakId,
        tur: e.tur,
        hata: err instanceof Error ? err.message : String(err),
      });
      this.sorunEkle(klasor, e, "indirme", err instanceof Error ? err.message : String(err));
      return null;
    }
    if (yanit.durum >= 400) {
      this.sec.olaylar.bas("evrak:indirme-hatasi", { evrakId: e.evrakId, durum: yanit.durum, tur: e.tur });
      this.sorunEkle(klasor, e, "indirme", `portal ${yanit.durum} döndü`);
      return null;
    }
    // 3) SESSİZ BOZULMA: text/plain asla belge değildir (doğrulanmış davranış)
    const ct = (yanit.basliklar["content-type"] ?? "").split(";")[0]!.trim();
    if (evrakYuklenmemisMi(yanit.baytlar, yanit.basliklar["content-type"] ?? "")) {
      this.sec.olaylar.bas("evrak:yuklenmemis", {
        evrakId: e.evrakId,
        tur: e.tur,
        mesaj: yuklenmemisMesaji(yanit.baytlar),
      });
      this.sorunEkle(klasor, e, "yuklenmemis", yuklenmemisMesaji(yanit.baytlar) || "Evrak UYAP sistemine yüklenmemiş");
      return null;
    }
    // 4) Uzantı: content-type'tan türet (evrak adından DEĞİL); belirsizse UDF kokla
    const uzanti = contentTipiUzanti(ct, yanit.baytlar);

    // ── P20 — "BU ZATEN ELİMDEKİ BELGE Mİ?" ─────────────────────────────────
    // Yanıt yazmadan ÖNCE verilir; yazdıktan sonra karşılaştırmak, ölçütün
    // dayandığı eski .md'yi aynı yola yazarak ezer.
    let yazilacakKayit: ManifestEvrak | undefined = onceki;
    let tanidikKayit: ManifestEvrak | undefined;
    /** Açılacak YENİ YOL, tanınamayan içerik için yedek kopya mı? */
    let yedekKopya = false;
    if (belirsizGrup !== undefined && havuz !== undefined) {
      const olcum = this.icerikOlcumu(yanit.baytlar, uzanti);
      tanidikKayit = havuz.esle(belirsizGrup, olcum);
      if (tanidikKayit !== undefined) {
        const korunan = this.korunanKayit(klasor, e, tanidikKayit, kat, anaEvrak);
        // Kaydın DOSYASI yerinde değilse "korundu" denemez: baytlar o kaydın
        // yoluna yazılır (onarım) ve satır "yenilenen" sayılır.
        if (korunan !== null) return korunan;
        yazilacakKayit = tanidikKayit;
      } else {
        const karar = havuz.kurban(belirsizGrup, olcum, onceki, kalanSatir);
        yazilacakKayit = karar.tur === "yaz" ? karar.kayit : undefined;
        yedekKopya = karar.tur === "yeni-yol" && karar.yedek;
      }
    }

    // Hedef yol: tanınmayan içerik EŞLEŞEN KAYDIN YOLUNA yazılır (yeni yol
    // açmak diski şişirir). Uzantı değiştiyse yol yeniden açılır — o dosya
    // artık başka türde bir belgedir ve eski adıyla anılamaz.
    let hedef: string | undefined;
    if (yazilacakKayit !== undefined && belirsizGrup !== undefined) {
      const yerinde = join(klasor, yazilacakKayit.path);
      if (kapsamIcindeMi(klasor, yerinde) && extname(yazilacakKayit.path).toLowerCase() === `.${uzanti}`) {
        hedef = yerinde;
      }
    }
    const yerindeYazildi = hedef !== undefined;
    if (hedef === undefined) hedef = bosHedefSec(hedefDizin, tabanAd, e, uzanti);
    kapsamKontrol(this.sec.kok, hedef);
    mkdirSync(dirname(hedef), { recursive: true });
    yazMetinAtomik(hedef, yanit.baytlar);
    // Önceki denemede düşen evrak bu turda indi: kaydı kapat.
    this.sorunCozuldu(this.klasorCaseKey.get(klasor) ?? klasor, e.evrakId, "indirme");
    const kayit = manifestKaydiYap(e, klasor, hedef, yanit.baytlar, kat, anaEvrak, false);
    // P20 (inceleme) — YEDEK KOPYA İŞARETİ. Yalnız belirsiz grupta, yalnız
    // içerik TANINMAMIŞKEN anlamlıdır: tanınan içerik zaten bir belgenin
    // karşılığıdır. Yeni yol açıldıysa bu kopyayı BİZ açtık; yerinde yazdıysak
    // işaret ancak ezilen kayıt da bizim kopyamızsa taşınır (gerçek bir belgeyi
    // yenilemek onu "kopya" yapmaz). Gerekçe: src/store/manifest.ts.
    if (belirsizGrup !== undefined && tanidikKayit === undefined) {
      if (!yerindeYazildi) {
        if (yedekKopya) kayit.belirsizKopya = true;
      } else if (yazilacakKayit?.belirsizKopya === true) kayit.belirsizKopya = true;
    }
    return { kayit, yeniIndirildi: true, onceki: yazilacakKayit };
  }

  /**
   * P20 — inen içeriğin iki ölçüsü: ÇIKARILAN METİN ve BAYT.
   *
   * Metin birinci ölçüttür (UYAP belgeyi her indirişte yeniden ürettiği için
   * bayt çoğu belgede tutmaz); bayt yalnız OLUMLU yönde ikinci ölçüttür.
   * Dönüşüm burada diske hiçbir şey yazmaz.
   */
  private icerikOlcumu(baytlar: Buffer, uzanti: string): IndirilenOlcum {
    const bayt = createHash("sha256").update(baytlar).digest("hex");
    let metin: string | null = null;
    try {
      const son = baytlardanMetin(baytlar, `.${uzanti}`);
      if (son.mdStatus === "ok" && typeof son.md === "string" && son.md !== "") {
        metin = createHash("sha256").update(son.md).digest("hex");
      }
    } catch {
      metin = null; // ölçülemedi: "aynı" ilan edilmez, bayta düşülür
    }
    return { metin, bayt };
  }

  /**
   * P20 — havuzun tanıdığı kayıt gerçekten yerinde mi? Yerindeyse kayıt
   * DOSYASIYLA BİRLİKTE korunur ve tek bayt yazılmaz; değilse `null` döner ve
   * çağıran baytları o kaydın yoluna yazar.
   *
   * `manifestKaydiYap` kaydı SIFIRDAN kurar; elle taşınmayan alan bir sonraki
   * eşitlemede sessizce silinir. Korunan evrak yeni damga ALMAZ (indirme
   * "yeni" değildi) ama eskisini kaybetmemeli.
   */
  private korunanKayit(
    klasor: string,
    e: EvrakSatiri,
    tanidik: ManifestEvrak,
    kat: { yon: "Gelen" | "Giden" | "Dosya"; klasor: string },
    anaEvrak: EvrakSatiri | undefined,
  ): { kayit: ManifestEvrak; yeniIndirildi: false; onceki: ManifestEvrak } | null {
    const mevcut = join(klasor, tanidik.path);
    if (!kapsamIcindeMi(klasor, mevcut)) return null;
    let baytlar: Buffer;
    try {
      if (!statSync(mevcut).isFile()) return null;
      baytlar = readFileSync(mevcut);
    } catch {
      return null;
    }
    const kayit = manifestKaydiYap(e, klasor, mevcut, baytlar, kat, anaEvrak, true);
    if (tanidik.indirmeDamgasi !== undefined) kayit.indirmeDamgasi = tanidik.indirmeDamgasi;
    // Kaydın kökeni değişmedi: yedek kopyaysa yedek kopya kalır.
    if (tanidik.belirsizKopya === true) kayit.belirsizKopya = true;
    if (tanidik.mdStatus === "ok" && tanidik.mdPath !== undefined) {
      const md = join(klasor, tanidik.mdPath);
      if (kapsamIcindeMi(klasor, md) && existsSync(md)) {
        kayit.mdStatus = "ok";
        kayit.mdPath = tanidik.mdPath;
      }
    }
    this.sorunCozuldu(this.klasorCaseKey.get(klasor) ?? klasor, e.evrakId, "indirme");
    return { kayit, yeniIndirildi: false, onceki: tanidik };
  }

  private sorunEkle(klasor: string, e: EvrakSatiri, tur: "indirme" | "donusum" | "yuklenmemis", hata: string): void {
    this.sec.sorunlar.ekle({
      caseKey: this.klasorCaseKey.get(klasor) ?? klasor,
      evrakId: e.evrakId,
      tur,
      hata,
    });
  }

  /**
   * `sorunEkle`in AYNASI: düzelen bir sorunun AÇIK kaydını `cozuldu` yapar.
   * Kimlik (dava + evrak + tür) kaydı açan yolla birebir aynı hesaplanır,
   * yoksa kapatma sessizce ıskalar. Kullanıcının YOKSAYDIĞI kayda dokunmaz —
   * `acikBul` yalnız `acik` kayıt döner, "bunu bana gösterme" kararı onundur.
   *
   * Bunsuz sayaç tek yönlü çalışırdı: sorun sayısı artar, hiç azalmazdı.
   * ROADMAP §14'ün "sayaç bir yapılacak iş göstergesidir" gerekçesi
   * (src/jobs/problems.ts) tam da bu kapanışa dayanıyor — `arac-yok` kaydı
   * sayaca "brew install poppler ile düzelir" diye alınıyor; kurulum sonrası
   * kayıt kendiliğinden kapanmazsa o gerekçe boşa çıkar.
   */
  private sorunCozuldu(caseKey: string, evrakId: string, tur: "indirme" | "donusum" | "yuklenmemis"): void {
    const s = this.sec.sorunlar.acikBul(caseKey, evrakId, tur);
    if (s !== undefined) this.sec.sorunlar.cozuldu(s.sorunId);
  }

  /** İndirilen her evrak için dönüşüm çalıştırır (senkron — dosya sayısı
   *  sınırlı; fren istekleri kısıtlar). */
  private async donusumleriTetikle(is: IsKaydi, klasor: string, manifest: Manifest): Promise<void> {
    this.olay(is, "donusum", { asama: "basliyor", adet: manifest.evraklar.length });
    for (const e of manifest.evraklar) {
      if (e.mdStatus === "ok" && e.mdPath !== undefined) continue;
      this.donusumUygula(is.caseKey, klasor, e);
      new ManifestDepo(join(klasor, MANIFEST_ADI)).yaz(manifest);
    }
    this.olay(is, "donusum", { asama: "bitti" });
  }

  /**
   * TEK BİR KAYDIN dönüşümü + sorun defteri. Manifest'e YAZMAZ (çağıran yazar).
   *
   * Eşitlemenin döngüsü ve P06b'nin seçili onarımı bu işlevi PAYLAŞIR: "hangi
   * dönüşüm sonucu bir sorundur" ölçütü iki yerde ayrı yazılsaydı onarım
   * rozeti kapatırken eşitleme yeniden açabilirdi.
   *
   * AÇIK LİSTE — olumsuzlama DEĞİL. Eski koşul `!== "ok" && !== "unsupported"`
   * idi; taksonomi ayrımından sonra aynen bırakılsaydı `gorsel` ve
   * `desteklenmiyor` sorun kaydı üretmeye BAŞLAR ve sorun rozeti kabarırdı.
   * Sorun = kullanıcının ya da ortamın düzeltebileceği durum:
   *   hata     dönüşüm fırlattı
   *   arac-yok pdftotext kurulu değil (eskiden bekliyor'a düşüp sorun üretiyordu)
   *   bekliyor dönüşüm hiç çalışmadı
   * gorsel/desteklenmiyor belge hakkındaki DOĞRU bilgidir, sorun değildir.
   * Bekçi: test/e2e.test.ts "açık sorun = 2" iddiası.
   */
  private donusumUygula(caseKey: string, klasor: string, e: ManifestEvrak): DonusumSonucu {
    const son = donustur(klasor, e.path);
    e.mdStatus = son.mdStatus;
    if (son.mdPath !== undefined) e.mdPath = son.mdPath;
    else delete e.mdPath;
    if (son.mdHata !== undefined) e.mdHata = son.mdHata;
    else delete e.mdHata;
    if (son.mdStatus === "hata" || son.mdStatus === "arac-yok" || son.mdStatus === "bekliyor") {
      this.sec.sorunlar.ekle({
        caseKey,
        evrakId: e.evrakId,
        tur: "donusum",
        hata: son.mdHata ?? `mdStatus=${son.mdStatus}`,
      });
    } else if (son.mdStatus === "ok") {
      // Dönüşüm bu turda BAŞARILI: varsa eski kaydı kapat. Kilit senaryo
      // `arac-yok` → `brew install poppler` → yeniden dönüşüm; kayıt burada
      // kapanmazsa kullanıcı sorunu gerçekten çözmüşken rozet yanmaya devam
      // eder. Kimlik `ekle` ile birebir aynı (caseKey + evrakId).
      // `gorsel`/`desteklenmiyor` KAPATMAZ: onlar dönüşümün başarısı değil,
      // belgenin sınıfıdır ve zaten hiç sorun kaydı üretmezler.
      this.sorunCozuldu(caseKey, e.evrakId, "donusum");
    }
    return son;
  }
}

// ── yardımcılar ───────────────────────────────────────────────────────

/**
 * P19 — portal satırının eşleşme anahtarı.
 *
 * Ana evrak grubu `(birimEvrakNo, tur, tarih)`; ek evrak grubu
 * `(anaStableKey, sıra, tur, tarih)`. İkisi de `oncekiEvrakBul`un ölçütüyle
 * BİREBİR aynıdır — ayrı bir ölçüt yazılsaydı eşleştirici bir kayıt seçer,
 * `oncekiEvrakBul` onu reddeder ve belge sessizce yeniden inerdi.
 *
 * NUMARASIZ ana evrak `grup: null` alır: orada "kaç tane olmalı" ölçülemez.
 * Numarası olmayan ana evrağın `stableKey`i zaten dönen `evrakId`den türüyor,
 * yani eski kod da onu eşleştiremiyordu; davranış AYNEN korunuyor.
 */
function portalAnahtari(e: EvrakSatiri, anaEvraklar: readonly EvrakSatiri[]): EsAnahtari {
  const ikincil = `${e.gonderen}\u0000${tipi(e) ?? ""}`;
  if (!ekEvrakMi(e)) {
    const no = e.birimEvrakNo;
    return {
      evrakId: e.evrakId,
      grup: no ? `ana\u0000${no}\u0000${e.tur}\u0000${e.tarih}` : null,
      ikincil,
    };
  }
  const ana = anaEvraklar.find((a) => a.evrakId === anaEvrakId(e));
  const sira = siraNo(e);
  if (ana === undefined || !ana.birimEvrakNo || sira === undefined)
    return { evrakId: e.evrakId, grup: null, ikincil };
  return {
    evrakId: e.evrakId,
    grup: `ek\u0000${stableKeyAna(ana.birimEvrakNo, ana.evrakId)}\u0000${Number(sira)}\u0000${e.tur}\u0000${e.tarih}`,
    ikincil,
  };
}

/**
 * P20 — bir manifest kaydının METİN özeti; ölçülemiyorsa null.
 *
 * Ölçüt denetimin (`src/store/denetim.ts` → `metinOzeti`) ölçütüyle AYNIDIR:
 * `.md` türevinin baytları. `donustur` md dosyasına dönüştürücünün döndürdüğü
 * dizeyi olduğu gibi yazdığı için bu özet, indirilen baytlardan çıkarılan
 * metnin özetiyle BİREBİR karşılaştırılabilir; ikisi ayrışırsa hiçbir kayıt
 * tanınmaz ve her belirsiz satır boşuna yenilenir.
 *
 * `mdStatus !== "ok"` (görsel, araç yok, dönüşüm düştü) null döner: ölçülemeyen
 * şey "aynı" ilan edilmez. Maliyet YALNIZ belirsiz grupların üyeleri için
 * ödenir; sağlıklı, tekil kayıtlı arşivde bu okuma hiç yapılmaz.
 */
function mdOzeti(klasor: string, k: ManifestEvrak): string | null {
  if (k.mdStatus !== "ok" || typeof k.mdPath !== "string" || k.mdPath === "") return null;
  const tam = join(klasor, k.mdPath);
  if (!kapsamIcindeMi(klasor, tam)) return null;
  try {
    const bilgi = statSync(tam);
    // 64 MB üstü bir .md dönüşümden çıkmaz; okumayı reddetmek ölçememekten
    // daha ucuzdur (o kayıt yalnız bayt ölçütüyle tanınabilir).
    if (!bilgi.isFile() || bilgi.size > 64 * 1024 * 1024) return null;
    return createHash("sha256").update(readFileSync(tam)).digest("hex");
  } catch {
    return null;
  }
}

/** Olay günlüğüne yalnız SAYI yazılır: hangi satırın ne olduğu değil. */
function ozetSayilari(satirlar: readonly OnarimIsSatiri[]): Record<string, number> {
  const sayac: Record<string, number> = {};
  for (const s of satirlar) sayac[s.durum] = (sayac[s.durum] ?? 0) + 1;
  return sayac;
}

/**
 * Bir evrakın SINIFI ve hedef klasörü/taban adı. Ölçüt tek yerdedir: indirme
 * (`evrakIndir`) ve seçili onarım (`onar`) aynı yolu üretmek ZORUNDADIR, yoksa
 * onarım belgeyi eşitlemenin bakmadığı bir klasöre yazar ve iki yüzey ayrışır.
 */
function evrakKonumu(
  klasor: string,
  e: EvrakSatiri,
  anaEvrak: EvrakSatiri | undefined,
): { kat: { yon: "Gelen" | "Giden" | "Dosya"; klasor: string }; hedefDizin: string; tabanAd: string } {
  const anaKat =
    anaEvrak !== undefined
      ? siniflandir({ tur: anaEvrak.tur, gonderen: anaEvrak.gonderen, tip: tipi(anaEvrak) })
      : undefined;
  const kat = anaKat ?? siniflandir({ tur: e.tur, gonderen: e.gonderen, tip: tipi(e) });
  if (anaEvrak !== undefined && anaKat !== undefined) {
    const anaNo = anaEvrak.birimEvrakNo ?? kisaOzet(anaEvrak.evrakId);
    const anaTarih = anaEvrak.tarih || e.tarih || "";
    return {
      kat,
      hedefDizin: join(
        klasor,
        "_kaynak",
        "evraklar",
        anaKat.yon,
        anaKat.klasor,
        `${evrakDosyaAdi(anaTarih, anaEvrak.tur, anaNo, "")}_ekler`,
      ),
      tabanAd: adTemizle(`Ek${siraNo(e) ?? "00"}_${e.tur}`, 80),
    };
  }
  return {
    kat,
    hedefDizin: join(klasor, "_kaynak", "evraklar", kat.yon, kat.klasor),
    tabanAd: evrakDosyaAdi(e.tarih || "", e.tur, e.birimEvrakNo, ""),
  };
}

/**
 * BOŞ bir hedef yolu seçer: var olan hiçbir dosyanın üstüne düşmez.
 * "Sahipsiz ya da yerelde değiştirilmiş kaynak olduğu gibi kalır" sözünün
 * ad tarafındaki karşılığıdır.
 */
function bosHedefSec(hedefDizin: string, tabanAd: string, e: EvrakSatiri, uzanti: string): string {
  let ad = tabanAd;
  const kimlik = createHash("sha256").update(e.evrakId).digest("hex").slice(0, 16);
  if (!e.birimEvrakNo || varOlanDosyaBul(hedefDizin, ad) !== null) ad += `_${kimlik}`;
  const taban = ad;
  for (let sira = 2; varOlanDosyaBul(hedefDizin, ad) !== null; sira++) ad = `${taban}_${sira}`;
  return join(hedefDizin, `${ad}.${uzanti}`);
}

/** Opaque IDs can rotate. Reuse numbered documents only on an unambiguous match. */
function oncekiEvrakBul(kayitlar: ManifestEvrak[], e: EvrakSatiri, ana: EvrakSatiri | undefined): ManifestEvrak | undefined {
  const tam = kayitlar.filter((x) => x.evrakId === e.evrakId);
  if (tam.length === 1) return tam[0];
  let adaylar: ManifestEvrak[];
  if (ana !== undefined && ana.birimEvrakNo && siraNo(e) !== undefined) {
    const anaKey = stableKeyAna(ana.birimEvrakNo, ana.evrakId);
    adaylar = kayitlar.filter((x) => x.isEkEvrak && x.anaStableKey === anaKey && x.stableKey.endsWith(`:${Number(siraNo(e))}`) && x.tur === e.tur && x.tarih === e.tarih);
  } else if (ana === undefined && e.birimEvrakNo) {
    adaylar = kayitlar.filter((x) => !x.isEkEvrak && x.birimEvrakNo === e.birimEvrakNo && x.tur === e.tur && x.tarih === e.tarih);
  } else return undefined;
  return adaylar.length === 1 ? adaylar[0] : undefined;
}

function tipi(e: EvrakSatiri): string | undefined {
  const v = e.ham["tip"] ?? e.ham["evrakTipi"];
  return typeof v === "string" ? v : undefined;
}

function ekEvrakMi(e: EvrakSatiri): boolean {
  const ana = e.ham["anaEvrakId"] ?? e.ham["anaEvrakID"] ?? e.ham["parentEvrakId"];
  return typeof ana === "string" && ana.length > 0;
}

function anaEvrakId(e: EvrakSatiri): string {
  const ana = e.ham["anaEvrakId"] ?? e.ham["anaEvrakID"] ?? e.ham["parentEvrakId"];
  return typeof ana === "string" ? ana : "";
}

function siraNo(e: EvrakSatiri): string | undefined {
  const s = e.ham["ekSira"] ?? e.ham["siraNo"] ?? e.ham["sira"];
  return s !== undefined ? String(s).padStart(2, "0") : undefined;
}

const CT_UZANTI: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/tiff": "tif",
  "text/html": "html",
  "application/zip": "zip",
};

/** Uzantıyı content-type'tan türet; application/octet-stream'de UDF kokla
 *  (UYAP dilekçeleri UDF'tir ve sık octet-stream ile gelir). */
function contentTipiUzanti(ct: string, baytlar: Buffer): string {
  const bilinen = CT_UZANTI[ct];
  if (bilinen !== undefined) return bilinen;
  if (udfMu(baytlar)) return "udf";
  return "bin";
}

/** Aynı taban adla (uzantısı ne olursa) dosya var mı? — devam ettirilebilirlik. */
function varOlanDosyaBul(dizin: string, tabanAd: string): string | null {
  let liste: string[];
  try {
    liste = readdirSync(dizin);
  } catch {
    return null;
  }
  const eslesen = liste.filter((ad) => {
    if (!ad.startsWith(tabanAd)) return false;
    const kalan = ad.slice(tabanAd.length);
    return kalan.startsWith(".") && !kalan.includes("/");
  });
  return eslesen.length > 0 ? join(dizin, eslesen[0]!) : null;
}

/**
 * P15b — indirilen kayda damgayı basar ve denemeyi manifest'te "açık" işaretler.
 *
 * Damga YALNIZ gerçekten portalden inen evraka yazılır: hash doğrulamasıyla
 * korunan evrak (`yeniIndirildi === false`) damga almaz, eskisini evrakIndir'de
 * aynen taşır. Tür ayrımı indirme sayaçlarıyla AYNI ölçüttür (`onceki` var mı):
 * yerinde kayıt varsa "yenilenen", yoksa "yeni".
 *
 * `acikEsitleme` aynı nesneye, aynı yazımda konur — çağıran hemen ardından
 * manifest'i diske yazar, yani damga ile işaretçi atomik olarak birlikte iner.
 * Süreç burada ölürse ikisi de diskte ya vardır ya yoktur; asla ayrışmaz.
 */
function damgala(
  manifest: Manifest,
  r: { kayit: ManifestEvrak; yeniIndirildi: boolean; onceki?: ManifestEvrak },
  esitlemeId: string,
): void {
  if (!r.yeniIndirildi) return;
  r.kayit.indirmeDamgasi = {
    esitlemeId,
    at: new Date().toISOString(),
    tur: r.onceki ? "yenilenen" : "yeni",
  };
  manifest.acikEsitleme = { esitlemeId, at: manifest.acikEsitleme?.at ?? r.kayit.indirmeDamgasi.at };
}

/**
 * P15b — COMMIT NOKTASI. Yalnız duraklatma erken dönüşünden SONRA, `lastSyncedAt`
 * ile aynı yazımda çağrılır; duraklatılan/iptal edilen denemeden buraya
 * gelinmez, bu yüzden kısmi indirme rozet tetikleyemez.
 *
 * Sayaçlar manifest'ten SAYILIR, iş sayaçlarından kopyalanmaz: duraklatılıp
 * devam ettirilen eşitlemede iş sayacı yalnız son koşuyu görür, manifest ise
 * devralınan kimlik sayesinde denemenin tamamını görür. Böylece "rozetli satır
 * sayısı = sonEsitleme.yeni" eşitliği tanım gereği sağlanır.
 *
 * `acikEsitleme` silinir: bu kimlik artık commit edilmiştir, sıradaki deneme
 * onu DEVRALMAZ, yeni kimlik üretir.
 */
function esitlemeyiKapat(
  manifest: Manifest,
  esitlemeId: string,
  kaynak: SonEsitleme["kaynak"],
  ilkIndirme: boolean,
): void {
  const isaret = { esitlemeId, ilkIndirme };
  const { yeni, yenilenen } = esitlemeSayaci(manifest.evraklar, isaret);
  manifest.sonEsitleme = {
    esitlemeId,
    at: new Date().toISOString(),
    kaynak,
    ilkIndirme,
    yeni,
    yenilenen,
  };
  delete manifest.acikEsitleme;
}

function manifestKaydiYap(
  e: EvrakSatiri,
  klasor: string,
  hedef: string,
  baytlar: Buffer,
  kat: { yon: "Gelen" | "Giden" | "Dosya"; klasor: string },
  anaEvrak: EvrakSatiri | undefined,
  oncedenVardi: boolean
): ManifestEvrak {
  const sha = createHash("sha256").update(baytlar).digest("hex");
  const rel = hedef.slice(klasor.length + 1);
  const ekli = anaEvrak !== undefined;
  const kayit: ManifestEvrak = {
    evrakId: e.evrakId,
    stableKey: ekli
      ? stableKeyEk(anaEvrakId(e), Number(siraNo(e) ?? "0"))
      : stableKeyAna(e.birimEvrakNo, e.evrakId),
    path: rel,
    sha256: sha,
    isEkEvrak: ekli,
    category: kat.klasor,
    yon: kat.yon,
    tur: e.tur,
    tip: tipi(e),
    gonderen: e.gonderen,
    tarih: e.tarih,
    birimEvrakNo: e.birimEvrakNo,
    anaEvrakId: ekli ? anaEvrakId(e) : undefined,
    anaStableKey: ekli ? stableKeyAna(anaEvrak.birimEvrakNo, anaEvrak.evrakId) : undefined,
    dosyaKey: e.tarih,
    mdStatus: "bekliyor",
    boyut: oncedenVardi ? statSync(hedef).size : baytlar.length,
  };
  return kayit;
}

export function caseKeyCoz(caseKey: string): [string, string] {
  const i = caseKey.indexOf("\u0000");
  if (i < 0) return [caseKey, ""];
  return [caseKey.slice(0, i), caseKey.slice(i + 1)];
}

function isEksikSonuc(sonuc: unknown): boolean {
  return !!sonuc && typeof sonuc === "object" && Number((sonuc as { eksikEvrak?: unknown }).eksikEvrak) > 0;
}

/** dosyaTur/mahkeme adından grup */
export function turGrup(dosyaTur: string | undefined, birimAdi: string): string {
  const n = birimAdi.toLocaleLowerCase("tr-TR");
  if (n.includes("icra")) return "İcra";
  if (n.includes("idare") || n.includes("vergi")) return "İdari";
  if (n.includes("ceza") || n.includes("çocuk") || n.includes("cocuk")) return "Ceza";
  if (n.includes("hukuk") || n.includes("sulh") || n.includes("iş mahkemesi") || n.includes("aile")) return "Hukuk";
  if (dosyaTur !== undefined && dosyaTur.toLocaleLowerCase("tr-TR").includes("ceza")) return "Ceza";
  return "Hukuk";
}

/** mahkeme adından kod (taksonomi klasörü) */
export function turKod(birimAdi: string): string {
  const n = birimAdi.toLocaleLowerCase("tr-TR");
  if (n.includes("sulh hukuk")) return "SULH HUKUK MAHKEMESİ";
  if (n.includes("asliye hukuk")) return "ASLİYE HUKUK MAHKEMESİ";
  if (n.includes("iş mahkemesi")) return "İŞ MAHKEMESİ";
  if (n.includes("aile")) return "AİLE MAHKEMESİ";
  if (n.includes("ticaret")) return "TİCARET MAHKEMESİ";
  if (n.includes("kadastro")) return "KADASTRO MAHKEMESİ";
  if (n.includes("ağır ceza") || n.includes("agir ceza")) return "AĞIR CEZA MAHKEMESİ";
  if (n.includes("asliye ceza")) return "ASLİYE CEZA MAHKEMESİ";
  if (n.includes("çocuk") || n.includes("cocuk")) return "ÇOCUK MAHKEMESİ";
  if (n.includes("idare")) return "İDARE MAHKEMESİ";
  if (n.includes("vergi")) return "VERGİ MAHKEMESİ";
  if (n.includes("icra")) return "İCRA MAHKEMESİ";
  return adTemizle(birimAdi, 60);
}
