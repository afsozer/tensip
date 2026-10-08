import { listeKapsamlariniGetir, dosyaListeSayfasi, type ListeKapsami } from '../uyap/dosya-listesi.js';
import { SorguOnbellek } from "./onbellek.js";
// Daemon — kompozisyon kökü.
// Tüm modülleri birleştirir: oturum → istemci → api → orkestratör → RPC.
// Ayrıca insan arayüzü (web) sunar: salt-okunur durum panosu.

import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { OlayYayici, AppLog } from "../core/log.js";
import { TopluEsitle } from "../jobs/toplu.js";
import { Fren } from "../core/fren.js";
import { Hata, KODLAR } from "../core/errors.js";
import { UyapIstemci } from "../uyap/client.js";
import { BirimKatalog } from "../uyap/birimler.js";
import { UyapApi } from "../uyap/api.js";
import {
  OturumDepo,
  OturumYoneticisi,
  type OturumKaydi,
} from "../uyap/session.js";
import { cdpGirisi, manuelCerezAyrıştır, dosyadanCerezOku, type CdpGirisSecenek } from "../uyap/login.js";
import { PORTAL_BASE } from "../uyap/endpoints.js";
import { durusmalariSorgula, type DurusmaKaydi } from "../uyap/durusma.js";
import { RegistryDepo } from "../store/registry.js";
import { varsayilanArsiv } from "../store/paths.js";
import { ManifestDepo } from "../store/manifest.js";
import { kaynakOlcer } from "../store/fsops.js";
import { arsiviDenetle } from "../store/denetim.js";
import { sadelestir } from "../store/sadelestir.js";
import { kaynakOnarimPlani, metniYenidenUret } from "../store/onarim.js";
import { safahatiGetir, taraflariGetir, hesabiGetir, type DetaySatiri } from "../uyap/dosyadetay.js";
import { gorunumUret, safahatSirala } from "../uyap/detay-goster.js";
import { taraflariCoz, type TarafBilgisi } from "../uyap/taraf.js";
import { Orkestrator } from "../jobs/orchestrator.js";
import { SorunDepo, eylemeDonukMu, type Sorun } from "../jobs/problems.js";
import { IsDepo, gecerliOnarimHedefi } from "../jobs/depo.js";
import { RpcSunucu, type RpcIsleyici } from "./rpc.js";
import { paketSurumu } from "../core/surum.js";
import { taniTopla } from "./tani.js";

export interface DaemonSecenek {
  /** veri kökü; varsayılan ~/Documents/UYAPAsistan */
  kok?: string;
  /** yapılandırma dizini; varsayılan ~/.config/tensip */
  ayarDir?: string;
  /** portal kökü; testlerde mock */
  portalUrl?: string;
  appVersion?: string;
  /** fren ayarları (testlerde gevşetilir); varsayılanlar src/core/fren.ts */
  istekAralikMs?: number;
  istekSapmaMs?: number;
  gunlukTavan?: number;
  gunlukIstekTavan?: number;
  /** web panosu portu; 0 = kapalı (varsayılan 4747) */
  webPort?: number;
  /** Oturum canlı-tutma aralığı (ms; varsayılan 10 dk, 0 = kapalı).
   *  UYAP oturumu ~15-30 dk inaktiflikte düşer (5 Eyl gözlemi). */
  oturumYenileMs?: number;
  log?: AppLog;
  /** Test enjeksiyonu: cdpGirisi tarayıcı başlatma taklidi */
  cdpSunucuKur?: NonNullable<CdpGirisSecenek["sunucuKur"]>;
  /** Test kancası: gerçek tarayıcı yerine çalıştırılacak komut (sahte tarayıcı) */
  cdpTarayiciKomutu?: NonNullable<CdpGirisSecenek["tarayiciKomutu"]>;
  /** Test enjeksiyonu: safahat önbelleğinin saat kaynağı (varsayılan Date.now).
   *  60 dakikalık TTL'i gerçek zamanda beklemeden ölçmenin tek yolu budur. */
  safahatSaati?: () => number;
  /** Yetkili durdur RPC'si tamamlanınca CLI bekleyişini sonlandırır. */
  kapatildiginda?: () => void;
}

export interface Daemon {
  olaylar: OlayYayici;
  orkestrator: Orkestrator;
  oturum: OturumYoneticisi;
  sorunlar: SorunDepo;
  registry: RegistryDepo;
  rpc: RpcSunucu;
  /** Etkin ayar dizini. Web katmanı dışa aktarma konumunu buradan türetir
   *  (P07a); parametreyle geçirilse bir çağıranın unutması sessizce özelliği
   *  kaybettirirdi. */
  ayarDizin: string;
  webKapat: () => Promise<void>;
  kapat: () => Promise<void>;
  isleyiciler: Map<string, RpcIsleyici>;
}

export const SIRKET_YAPILANDIRMA = "~/.config/tensip";

export function ayarDizini(ust: string | undefined): string {
  if (ust !== undefined) return ust;
  const k = SIRKET_YAPILANDIRMA.replace("~", homedir());
  return k;
}

/** Daemon örneğini kurar (çalıştırmadan). Testler de bunu kullanır. */
export function daemonKur(sec: DaemonSecenek = {}): Daemon {
  const ayarDir = ayarDizini(sec.ayarDir);
  const kok = sec.kok ?? varsayilanArsiv();
  const olaylar = new OlayYayici();
  const log = sec.log ?? new AppLog({ dosya: join(ayarDir, "tensip.log") });
  const fren = new Fren({
    istekAralikMs: sec.istekAralikMs,
    istekSapmaMs: sec.istekSapmaMs,
    gunlukTavan: sec.gunlukTavan,
    gunlukIstekTavan: sec.gunlukIstekTavan,
    dosya: join(ayarDir, "fren.json"),
  });
  const oturumDepo = new OturumDepo(ayarDir);
  const acikGirisler = new Set<() => Promise<void>>();
  let girisSuruyor = false;
  let durdurmaIsteniyor = false;
  const kapanisIcinKontrol = () => {
    if (durdurmaIsteniyor) throw new Hata(KODLAR.IS_BUSY, "Daemon kapanıyor; yeni iş veya giriş başlatılamaz.");
  };

  const istemci = new UyapIstemci({
    baseUrl: sec.portalUrl ?? PORTAL_BASE,
    cookie: () => {
      const k = oturumDepo.oku();
      return k ? k.cookie : "";
    },
    fren,
    istekIzin: () => {
      if (durdurmaIsteniyor) throw new Hata(KODLAR.IS_BUSY, "Daemon kapanıyor");
      if (acikGirisler.size > 0) throw new Hata(KODLAR.IS_BUSY, "tarayıcı girişi sürüyor");
    },
    logla: (m) => log.write("uyap", m),
  });

  const birimler = new BirimKatalog(istemci, join(ayarDir, "birimler.json"));
  const api = new UyapApi(istemci, birimler);
  const registry = new RegistryDepo(join(ayarDir, "davalarim.json"));
  const sorunlar = new SorunDepo(join(ayarDir, "sorunlar.json"));
  const isDepo = new IsDepo(ayarDir);
  const orkestrator = new Orkestrator({
    api,
    registry,
    olaylar,
    fren,
    kok,
    sorunlar,
    isDepo,
  });
  const oturum = new OturumYoneticisi(oturumDepo, {
    json: async (yol, govde, cerez) => {
      const y = await istemci.talep(yol, {
        yontem: "POST",
        govde: JSON.stringify(govde),
        ...(cerez !== undefined ? { cerez } : {}),
      });
      return { durum: y.durum, rc: y.rc, govde: y.govde, contentType: y.basliklar["content-type"] };
    },
  });

  const toplu = new TopluEsitle(join(ayarDir, "toplu-isler.json"), orkestrator, () => {
    kapanisIcinKontrol();
    oturum.gerektigiGibi();
    if (girisSuruyor) throw new Hata(KODLAR.IS_BUSY, "Tarayıcı girişi sürüyor");
  });
  const tekIsKontrol = (isId?: string) => {
    if (toplu.aktifMi()) throw new Hata(KODLAR.IS_BUSY, "Toplu eşitleme sürüyor; önce toplu işi duraklatın.");
    if (isId && toplu.isiSahipleniyor(isId)) throw new Hata(KODLAR.INVALID_INPUT, "Bu dosyayı toplu işin düğmeleriyle yönetin.");
  };
  const isleyiciler = new Map<string, RpcIsleyici>();
  const h = isleyiciler;

  h.set("durum", async (g) => {
    // probeTaze: pano 5 sn'de bir çağırır — portalı rahatsız etmesin
    const oturumDurum = girisSuruyor || g["yerel"] === true ? oturum.durumBilgisi().durum : await oturum.probeTaze();
    return {
      appVersion: sec.appVersion ?? paketSurumu(),
      portal: sec.portalUrl ?? PORTAL_BASE,
      kok,
      oturum: oturum.durumBilgisi(),
      oturumDurum,
      girisSuruyor,
      fren: fren.durum(),
      isler: {
        calisiyor: orkestrator.islerHepsi().filter((i) => i.durum === "calisiyor").length,
        toplam: orkestrator.islerHepsi().length,
      },
      // P16 — rozet SAYILAN kayıtları sayar (kullanıcının düzeltebileceği
      // olanlar); `yuklenmemis` listede kalır, sayaçta kalmaz. Toplam ayrı
      // alanda dürüstçe durur, gizlenmez.
      sorunAcik: sorunlar.acikSayilan().length,
      sorunAcikToplam: sorunlar.acik().length,
      davaSayisi: registry.oku().davalar.length,
      isDepo: orkestrator.depoDurumu(),
    };
  });

  // P10a — salt-okunur tanılama. Gövdeyi BİLEREK yok sayar: yol/caseKey/dosya
  // argümanı kabul eden bir tanılama, belge işleyicilerindeki kök sınırlarının
  // dışında yeni bir okuma kapısı açardı. Oturuma dokunmaz, `probeTaze()`
  // ÇAĞIRMAZ, portala hiçbir istek atmaz; registry/manifest AÇMAZ.
  h.set("tani", async () =>
    taniTopla({
      motorSurum: sec.appVersion ?? paketSurumu(),
      kok,
      ayarDizin: ayarDir,
      instanceId: rpc.bilgiGetir()?.instanceId,
    }),
  );

  h.set("birimler", async () => birimler.yerelListe());

  const listeKapsamlari = new SorguOnbellek<ListeKapsami[]>(5 * 60_000);
  const listeSayfalari = new SorguOnbellek<Awaited<ReturnType<typeof dosyaListeSayfasi>>>(5 * 60_000);
  h.set("dosyalar-listele", async (g) => {
    oturum.gerektigiGibi();
    const surum = oturum.surum;
    if (g["surum"] !== undefined && g["surum"] !== surum)
      throw new Hata(KODLAR.LOGIN_REQUIRED, "Oturum değişti; listelemeyi yeniden başlatın");
    const index = g["kapsamIndex"] ?? 0, sayfa = g["sayfa"] ?? 1;
    if (!Number.isInteger(index) || Number(index) < 0 || !Number.isInteger(sayfa) || Number(sayfa) < 1 || Number(sayfa) > 50)
      throw new Hata(KODLAR.INVALID_INPUT, "Geçersiz liste sayfası veya kapsamı");
    const kapsamlar = await listeKapsamlari.getir(String(surum), () => listeKapsamlariniGetir(istemci));
    const kapsam = kapsamlar[Number(index)];
    if (!kapsam) throw new Hata(KODLAR.INVALID_INPUT, "Geçersiz liste kapsamı");
    const sonuc = await listeSayfalari.getir(`${surum}:${index}:${sayfa}`, () => dosyaListeSayfasi(istemci, kapsam, Number(sayfa)));
    if (oturum.surum !== surum) throw new Hata(KODLAR.LOGIN_REQUIRED, "Sorgu sırasında oturum değişti");
    const sinir = sonuc.devam && sayfa === 50;
    const sonraki = sinir ? null : sonuc.devam ? { kapsamIndex: index, sayfa: Number(sayfa) + 1, surum }
      : Number(index) + 1 < kapsamlar.length ? { kapsamIndex: Number(index) + 1, sayfa: 1, surum } : null;
    // P18 — `surum`: bu sayfadaki opak `dosyaId`lerin HANGİ OTURUMA ait olduğu.
    // İstemci bunu saklar ve `liste-taraflar` isteğiyle geri gönderir; oturum
    // değiştiyse sunucu isteği reddeder (yanlış dosyanın tarafı gösterilemez).
    return { davalar: sonuc.davalar, sonraki, sinir, surum, kapsam: kapsam.ad, kapsamIndex: index,
      kapsamSayisi: kapsamlar.length, sorguAt: new Date().toISOString(),
      destek: "Hukuk, ceza ve icra mahkeme tabloları; idari yargı, CBS, vatandaş ve yüksek mahkeme özel sorguları dahil değil." };
  });

  h.set("davalarim", async (g) => {
    oturum.gerektigiGibi();
    const birim = zorla(g, "birim");
    const yil = zorla(g, "yil");
    const sira = zorla(g, "sira");
    const kapsam = (g["kapsam"] as string | undefined) ?? "hepsi";
    // P18 — sorgudan ÖNCE ölçülür. Sorgu sırasında oturum değişirse dönen opak
    // kimlikler eski oturumundur; eski sürümle damgalamak `liste-taraflar`ın
    // isteği reddetmesini sağlar. Sonraki sürümle damgalamak, geçersiz bir
    // kimliği geçerli göstererek BAŞKA DOSYANIN tarafını getirebilirdi.
    const surum = oturum.surum;
    const sonuc = await api.davalarim({
      birimAdi: birim,
      esasYil: yil,
      esasSira: sira,
      kapsam: kapsam === "acik" ? "acik" : kapsam === "kapali" ? "kapali" : "hepsi",
    });
    return {
      birim,
      esas: `${yil}/${sira}`,
      adet: sonuc.length,
      surum,
      davalar: sonuc.map((d) => ({
        dosyaId: d.dosyaId,
        birimAdi: d.birimAdi,
        birimId: d.birimId,
        esasNo: d.esasNo,
        dosyaTur: d.dosyaTur,
        dosyaDurum: d.dosyaDurum,
      })),
    };
  });

  h.set("klonla", async (g) => {
    tekIsKontrol();
    kapanisIcinKontrol();
    oturum.gerektigiGibi();
    const birim = zorla(g, "birim");
    const esas = zorla(g, "esas");
    const kapsam = (g["kapsam"] as string | undefined) ?? "kapali";
    const avukat = (g["avukat"] as string | undefined) ?? "AVUKAT";
    const is = orkestrator.klonlaBaslat({
      birimAdi: birim,
      esasNo: esas,
      kapsam: kapsam === "acik" ? "acik" : kapsam === "hepsi" ? "hepsi" : "kapali",
      avukat,
    });
    return { isId: is.isId, durum: is.durum };
  });

  h.set("esitle", async (g) => {
    tekIsKontrol();
    kapanisIcinKontrol();
    const caseKey = zorla(g, "caseKey");
    oturum.gerektigiGibi(); // orkestratör taze aramayı iş kilidi içinde yapar
    const is = orkestrator.esitleBaslat(caseKey);
    return { isId: is.isId, durum: is.durum };
  });

  h.set("toplu-esitle", async (g) => {
    const keys = g["caseKeys"];
    if (!Array.isArray(keys) || keys.length < 1 || keys.length > 50 || keys.some(k => typeof k !== "string") || new Set(keys).size !== keys.length) {
      throw new Hata(KODLAR.INVALID_INPUT, "1–50 farklı arşiv dosyası seçin");
    }
    const arsiv = registry.oku().davalar;
    if (keys.some(k => !arsiv.some(d => d.caseKey === k && d.klonYolu))) throw new Hata(KODLAR.INVALID_INPUT, "Yalnız indirilmiş arşiv dosyaları eşitlenebilir");
    return toplu.baslat(keys as string[]);
  });
  h.set("toplu-devam", async g => toplu.devam(zorla(g, "id")));
  for (const eylem of ["duraklat", "iptal"] as const) {
    h.set(`toplu-${eylem}`, async g => { toplu.kes(zorla(g, "id"), eylem); return { ok: true }; });
  }

  h.set("davalar", async () => {
    return { davalar: registry.oku().davalar };
  });

  h.set("evraklar", async (g) => {
    const caseKey = zorla(g, "caseKey");
    const kayit = registry.oku().davalar.find((d) => d.caseKey === caseKey);
    if (!kayit?.klonYolu) throw new Hata(KODLAR.NOT_FOUND, "klonlanmamış dava");
    const m = new ManifestDepo(join(kayit.klonYolu, "uyap-project.json")).oku();
    if (!m) throw new Hata(KODLAR.NOT_FOUND, "manifest yok");
    const kategori = g["kategori"] as string | undefined;
    const liste = kategori !== undefined ? m.evraklar.filter((e) => e.category === kategori) : m.evraklar;
    // P15c — satır başına `kaynakDurum`: TÜRETİLMİŞ alan, istek anında ölçülür,
    // manifest'e GERİ YAZILMAZ (rozet hiçbir bayt değiştirmez). Ölçüm yalnız
    // yerel dosya sistemine bakar: portala sıfır istek, oturum gerekmez.
    // Bozuk satır listeyi düşürmez: `path` string değilse/boşsa hiç ölçüm
    // yapılmadan "bilinmiyor" yazılır (eskiden `resolve(klasor, undefined)`
    // TypeError'ı bütün evrak listesini 500'e çevirirdi).
    const olc = kaynakOlcer(kayit.klonYolu);
    const evraklar = liste.map((e) => ({
      ...e,
      kaynakDurum:
        typeof e.path === "string" && e.path !== ""
          ? olc(resolve(kayit.klonYolu!, e.path)).durum
          : "bilinmiyor",
    }));
    // P15b — `sonEsitleme` MANİFEST seviyesindedir, evrak seviyesinde değil;
    // "yeni" rozeti evrak damgasını bu işaretçiyle karşılaştırarak türetilir,
    // yani istemcinin ikisini de aynı yanıtta görmesi gerekir. `adet` ve
    // `evraklar` anlamı DEĞİŞMEZ; yanıt yalnız alan ekler.
    return { dava: `${kayit.birimAdi} ${kayit.dosyaNo}`, adet: evraklar.length, evraklar, sonEsitleme: m.sonEsitleme ?? null };
  });

  h.set("detay", async (g) => {
    const caseKey = zorla(g, "caseKey");
    const kayit = registry.oku().davalar.find((d) => d.caseKey === caseKey);
    if (!kayit?.klonYolu) throw new Hata(KODLAR.NOT_FOUND, "klonlanmamış dava");
    const m = new ManifestDepo(join(kayit.klonYolu, "uyap-project.json")).oku();
    return { kayit, manifest: m };
  });

  // ── dosya detay verileri (safahat / taraflar / hesap) ───────────────
  // caseKey → registry → klonYolu → manifest.dosyaId (opak token).
  // CANLI BULGU (5 Eyl): opak tokenlar OTURUMA BAĞLI — eski oturumun
  // tokenı yeni oturumda PRTL_GNL_10001-4 "Doğrulama hatası" verir.
  // Bu yüzden dosyaId HER KULLANIMDA taze aramayla yenilenir ve manifest
  // güncellenir. Eşitleme kendi iş kilidi içinde taze arama yapar.
  const klonluKayit = (caseKey: string) => {
    const kayit = registry.oku().davalar.find((d) => d.caseKey === caseKey);
    if (!kayit?.klonYolu) throw new Hata(KODLAR.NOT_FOUND, "klonlanmamış dava");
    const m = new ManifestDepo(join(kayit.klonYolu, "uyap-project.json")).oku();
    if (!m) throw new Hata(KODLAR.NOT_FOUND, "manifest yok");
    return { kayit, m };
  };
  const klonluDosyaId = async (caseKey: string): Promise<string> => {
    const { kayit } = klonluKayit(caseKey);
    const surum = oturum.surum;
    const [yil = "", sira = ""] = kayit.dosyaNo.split("/");
    const bulunan = await api.davalarim({
      birimAdi: kayit.birimAdi,
      esasYil: yil,
      esasSira: sira,
      kapsam: "hepsi",
    });
    const taze = bulunan.find((d) => d.esasNo === kayit.dosyaNo)?.dosyaId;
    if (!taze) {
      throw new Hata(KODLAR.NOT_FOUND, "portalden taze dosyaId alınamadı (arama boş döndü)");
    }
    if (oturum.surum !== surum) throw new Hata(KODLAR.LOGIN_REQUIRED, "sorgu sırasında oturum değişti");
    const { m } = klonluKayit(caseKey);
    if (taze !== m.dosyaId) {
      new ManifestDepo(join(kayit.klonYolu!, "uyap-project.json")).yaz({ ...m, dosyaId: taze });
    }
    return taze;
  };
  // P07b — yanıt VERİNİN YAŞINI taşır. Taraf/hesap önbelleksizdir: `sorguAt`
  // sorgunun BİTTİĞİ andır ve `onbellekten` her zaman false'tur; ekran bunu
  // yazınca avukat baktığı verinin ne kadar taze olduğunu bilir. Görünüm
  // (`gorunum`) motorda üretilir; arayüz ikinci bir başlık tablosu yazmaz.
  const detayGetir = (ad: string, cagir: (dosyaId: string) => Promise<DetaySatiri[]>) =>
    async (g: Record<string, unknown>) => {
      oturum.gerektigiGibi();
      const caseKey = zorla(g, "caseKey");
      const surum = oturum.surum;
      const dosyaId = await klonluDosyaId(caseKey);
      const satirlar = await cagir(dosyaId);
      // Geciken yanıt YENİ oturuma yazılmaz: `klonluDosyaId` kendi içinde bir
      // kez bakıyor, ama asıl sorgu ondan SONRA çalışıyor. Opak kimlikler
      // oturuma bağlıdır (README §8); eski oturumun yanıtını yeni oturumda
      // ekrana yazmak BAŞKA DOSYANIN taraflarını göstermek olabilirdi.
      if (surum !== oturum.surum)
        throw new Hata(
          KODLAR.LOGIN_REQUIRED,
          "yanıt geldiğinde oturum değişmişti; sonuç gösterilmedi",
        );
      return {
        caseKey,
        ad,
        adet: satirlar.length,
        satirlar,
        gorunum: gorunumUret(satirlar),
        sorguAt: new Date().toISOString(),
        onbellekten: false,
      };
    };
  // Safahat: UYAP KENDİ limiti — "Bu işlem 60 dakikada 1 defa" (PRTL_GNL_1-1,
  // önceki oturum kaydı). Burada dosya başına 60 dk önbellek kullanılır;
  // portal limitinin tam kapsamı bu denetimde canlı doğrulanmadı.
  const safahatOnbellek = new SorguOnbellek<DetaySatiri[]>(60 * 60_000, sec.safahatSaati);
  h.set("safahat", async (g) => {
    oturum.gerektigiGibi();
    const caseKey = zorla(g, "caseKey");
    klonluKayit(caseKey);
    const surum = oturum.surum;
    // P07b — `getirDamgali`: yanıt verinin ÖLÇÜLDÜĞÜ anı taşır. 60 dk'lık
    // önbellekten dönen safahat, tıklama anı kadar taze görünürse avukat bir
    // saatlik veriye baktığını FARK EDEMEZ (P07a kararı 9'un ikizi).
    const { deger: ham, at, onbellekten } = await safahatOnbellek.getirDamgali(
      `${surum}:${caseKey}`,
      async () => {
        const id = await klonluDosyaId(caseKey);
        try { return await safahatiGetir(istemci, id); }
        catch (e) {
          if (e instanceof Error && e.message.includes("PRTL_GNL_1-1")) {
            throw new Hata(KODLAR.OTOMASYON_BUTCESI, "UYAP safahat sorgusunu sınırladı — daha sonra tekrar deneyin");
          }
          throw e;
        }
      },
    );
    if (surum !== oturum.surum) throw new Hata(KODLAR.LOGIN_REQUIRED, "sorgu sırasında oturum değişti");
    // Kronolojik sıra motorda kurulur; sıralanamıyorsa portal sırası korunur
    // ve `sira` bunu SÖYLER (ekran "portal sırası" yazar, sessizce sıralamaz).
    const { satirlar, sira } = safahatSirala(ham);
    return {
      caseKey,
      ad: "safahat",
      adet: satirlar.length,
      satirlar,
      gorunum: gorunumUret(satirlar),
      sira,
      sorguAt: new Date(at).toISOString(),
      onbellekten,
    };
  });
  h.set("taraflar", detayGetir("taraf", (id) => taraflariGetir(istemci, id)));
  h.set("hesap", detayGetir("hesap", (id) => hesabiGetir(istemci, id)));

  // ── P18a — portal LİSTE satırının kendi dosyaId'siyle taraf sorgusu ───────
  // Neden ayrı işlem: yukarıdaki `taraflar` caseKey alır ve `klonluDosyaId`
  // üzerinden KLONLANMIŞ dava şartı arar. Portal listesindeki dosyaların çoğu
  // henüz indirilmemiştir — kullanıcı zaten hangisini indireceğine karar
  // vermek için taraflara bakar. Bu yol registry'ye HİÇ bakmaz, diske HİÇ
  // yazmaz; sonuç yalnız o oturumda ekranda durur.
  //
  // OPAK KİMLİK KAPISI: liste satırının `dosyaId`si OTURUMA BAĞLIDIR (README
  // §8). İstemci listeyi aldığı oturum sürümünü göndermek ZORUNDADIR; sürüm
  // uyuşmuyorsa istek portala hiç gitmeden reddedilir. Yanlış dosyanın
  // taraflarını sessizce göstermek bu üründeki en kötü hatadır — o yüzden
  // burada "en iyi tahmin" yoktur, yalnız ret ve "listeyi yenileyin" vardır.
  const listeTaraflari = new SorguOnbellek<TarafBilgisi[]>(5 * 60_000);
  h.set("liste-taraflar", async (g) => {
    oturum.gerektigiGibi();
    const dosyaId = zorla(g, "dosyaId");
    const surum = oturum.surum;
    const istenen = g["surum"];
    if (!Number.isInteger(istenen))
      throw new Hata(KODLAR.INVALID_INPUT, '"surum" gerekli: taraf sorgusu listenin alındığı oturum sürümünü taşımalı');
    if (istenen !== surum)
      throw new Hata(KODLAR.LOGIN_REQUIRED, "Oturum değişti; dosya listesini yenileyin. Eski listedeki kimlikler başka bir dosyayı gösterebilir.");
    const taraflar = await listeTaraflari.getir(`${surum}:${dosyaId}`, async () =>
      taraflariCoz(await taraflariGetir(istemci, dosyaId)),
    );
    if (oturum.surum !== surum)
      throw new Hata(KODLAR.LOGIN_REQUIRED, "Sorgu sırasında oturum değişti; dosya listesini yenileyin.");
    // `dosyaId` yanıtta geri döner: istemci hangi satıra yazdığını doğrular.
    return { dosyaId, surum, adet: taraflar.length, taraflar };
  });

  h.set("yol", async (g) => {
    const caseKey = zorla(g, "caseKey");
    const kayit = registry.oku().davalar.find((d) => d.caseKey === caseKey);
    if (!kayit?.klonYolu) throw new Hata(KODLAR.NOT_FOUND, "klonlanmamış dava");
    return { yol: kayit.klonYolu, caseKey };
  });

  // P06a — YEREL ARŞİV DENETİMİ. Salt-okunur: hiçbir bayt yazılmaz, sorun
  // kaydı AÇILMAZ, portala TEK istek gitmez, oturum ARANMAZ (motorun oturum
  // nesnesine hiç dokunulmaz). `caseKey` opsiyoneldir: verilmezse tüm arşiv.
  // ONARIM YOKTUR — o P06b'dir; bu uç yalnız rapor döndürür.
  //
  // Meşguliyet ölçülerek verilir, tahmin edilmez: bir dava için orkestratörde
  // `calisiyor`/`bekliyor` iş varsa ya da ÇALIŞAN bir toplu sıra o davayı
  // taşıyorsa o dava atlanır ve rapor kısmi olur (eşitleme sürerken manifest
  // ile disk arasındaki geçici fark bozukluk DEĞİLDİR; onu bulgu diye
  // göstermek kullanıcıyı sahte alarma boğardı).
  // CANLI meşguliyet ölçümü — denetim (P06a) ve sadeleştirme (P19b) AYNI
  // ölçütü kullanır: iki yerde ayrı yazılsaydı biri "meşgul" derken öteki
  // yazmaya başlayabilirdi. Sıradaki "hâlâ bekliyor mu" ölçütü kuyruğun KENDİ
  // kuralıdır (src/jobs/toplu.ts `sira`: son denemesi `hazir` olan dosya
  // atlanır), yoksa 50 dosyalık bir sıra sürerken bitmiş dosyalar da meşgul
  // sayılır ve rapor bütünüyle kullanılamaz hâle gelirdi.
  const mesgul = (caseKey: string): boolean => {
    for (const is of orkestrator.islerHepsi())
      if (is.caseKey === caseKey && (is.durum === "calisiyor" || is.durum === "bekliyor"))
        return true;
    for (const sira of toplu.hepsi()) {
      if (sira.durum !== "calisiyor") continue;
      for (const d of sira.dosyalar) {
        if (d.caseKey !== caseKey) continue;
        const son = d.denemeler.at(-1);
        if (son === undefined || orkestrator.isGetir(son)?.durum !== "hazir") return true;
      }
    }
    return false;
  };

  h.set("arsiv-denetle", async (g) => {
    const istenen = g["caseKey"];
    if (istenen !== undefined && typeof istenen !== "string")
      throw new Hata(KODLAR.INVALID_INPUT, "caseKey metin olmalı.");
    const davalar = registry.oku().davalar;
    if (istenen !== undefined && istenen !== "") {
      const kayit = davalar.find((d) => d.caseKey === istenen);
      if (!kayit?.klonYolu) throw new Hata(KODLAR.NOT_FOUND, "klonlanmamış dava");
    }
    // CANLI ölçüm, anlık görüntü DEĞİL: denetim başladıktan sonra başlayan bir
    // eşitlemeyi de yakalayabilmesi için `mesgul` her çağrıldığında yeniden
    // ölçer (denetim motoru bir davayı bitirdikten sonra ikinci kez sorar).
    // Sıradaki "hâlâ bekliyor mu" ölçütü kuyruğun KENDİ kuralıdır
    // (src/jobs/toplu.ts `sira`: son denemesi `hazir` olan dosya atlanır),
    // yoksa 50 dosyalık bir sıra sürerken bitmiş dosyalar da meşgul sayılır ve
    // rapor bütünüyle kullanılamaz hâle gelirdi.
    return arsiviDenetle({
      kok,
      davalar,
      caseKey: typeof istenen === "string" && istenen !== "" ? istenen : null,
      mesgul,
    });
  });

  /**
   * P19b — BİRİKMİŞ ŞİŞKİNLİĞİ SADELEŞTİR. Kendiliğinden ÇALIŞMAZ.
   *
   * `onay` gelmeden tek bayt değişmez: yalnız plan döner (hangi kayıt kalıyor,
   * hangileri düşüyor). `onay: true` ile manifest önce yedeklenir, sonra
   * fazlalık SATIRLAR düşer — BELGE DOSYASINA DOKUNULMAZ (gerekçe:
   * src/store/sadelestir.ts). Eşitlemesi süren dosyada REDDEDİLİR: yarı
   * yazılmış bir manifest üzerinde sadeleştirme yanlış satırı düşürebilir.
   *
   * ── KAPSAM: `yol` VARSA YALNIZ O GRUP (P06b incelemesi) ────────────────
   * Denetim satırındaki düğme tek satırın sözünü verir ve o satırın yolunu
   * gönderir; Evraklar ekranının dava geneli düğmesi `yol` göndermez.
   * İstemciden gelen rasgele disk yolu KABUL EDİLMEZ: `onar` ile aynı ölçüt.
   */
  h.set("sadelestir", async (g) => {
    const caseKey = zorla(g, "caseKey");
    const onay = g["onay"];
    if (onay !== undefined && typeof onay !== "boolean")
      throw new Hata(KODLAR.INVALID_INPUT, "onay mantıksal (true/false) olmalı.");
    const yol = g["yol"];
    if (yol !== undefined && !gecerliOnarimHedefi(yol))
      throw new Hata(
        KODLAR.INVALID_INPUT,
        "Sadeleştirme hedefi dava klasörüne göreli bir yol olmalı.",
      );
    const kayit = registry.oku().davalar.find((d) => d.caseKey === caseKey);
    if (!kayit?.klonYolu) throw new Hata(KODLAR.NOT_FOUND, "klonlanmamış dava");
    if (mesgul(caseKey))
      throw new Hata(KODLAR.IS_BUSY, "Bu dosya için eşitleme sürüyor; sadeleştirme reddedildi.");
    const plan = await sadelestir(kok, kayit.klonYolu, onay === true, {
      ...(typeof yol === "string" ? { yol } : {}),
    });
    if (plan.uygulandi) {
      kayit.sonEvrakSayisi = plan.sonra;
      registry.koy(kayit);
    }
    return { caseKey, ...plan };
  });

  /**
   * P06b — SEÇİLİ ONARIM. Denetimin bulduğu TEK satırı düzeltir.
   *
   * ── ONAY KALIBI `sadelestir` İLE AYNI ──────────────────────────────────
   * `onay` gelmeden TEK BAYT değişmez: yalnız YENİDEN ÖLÇÜLMÜŞ plan döner
   * (bayat rapordan onarım yapılmaz). Onaylı çağrı manifesti önce yedekler ve
   * hiçbir dalda belge dosyası silmez ya da ezmez.
   *
   * ── İKİ EYLEM, İKİ AYRI YOL ────────────────────────────────────────────
   *   metin  — SENKRON ve AĞSIZ. Oturum ARANMAZ (motorun oturum nesnesine hiç
   *            dokunulmaz), portala TEK istek gitmez ve GÜNLÜK PORTAL İŞ
   *            SAYACI ARTMAZ: `fren.isBaslamadan()` yalnız orkestratör işinde
   *            çağrılır, bu yol oraya hiç uğramaz. Karar açıktır — ağ
   *            kullanmayan bir dönüşümü portal isteği gibi saymak, kullanıcının
   *            günlük bütçesini boşa yakmak olurdu.
   *   kaynak — ORKESTRATÖR İŞİ (`onar`). Oturum gerekir, frenden geçer,
   *            duraklatılabilir/iptal edilebilir ve iş geçmişinde görünür.
   *            Kimlik BU TURDA çözülür; belirsizse iş hiçbir şey indirmeden
   *            durur.
   *
   * Eşitlemesi süren dosyada REDDEDİLİR: yarı yazılmış bir manifest üzerinde
   * onarım yanlış satırı hedefleyebilir (denetim ve sadeleştirmeyle AYNI
   * `mesgul` ölçütü).
   */
  h.set("onar", async (g) => {
    const caseKey = zorla(g, "caseKey");
    const eylem = g["eylem"];
    if (eylem !== "metin" && eylem !== "kaynak")
      throw new Hata(KODLAR.INVALID_INPUT, 'eylem "metin" ya da "kaynak" olmalı.');
    const yol = zorla(g, "yol");
    // İstemciden gelen rasgele disk yolu KABUL EDİLMEZ: yol dava klasörüne
    // göreli olmalı (ROADMAP §4 P06b madde 5).
    if (!gecerliOnarimHedefi(yol))
      throw new Hata(KODLAR.INVALID_INPUT, "Onarım hedefi dava klasörüne göreli bir yol olmalı.");
    const onay = g["onay"];
    if (onay !== undefined && typeof onay !== "boolean")
      throw new Hata(KODLAR.INVALID_INPUT, "onay mantıksal (true/false) olmalı.");
    const kayit = registry.oku().davalar.find((d) => d.caseKey === caseKey);
    if (!kayit?.klonYolu) throw new Hata(KODLAR.NOT_FOUND, "klonlanmamış dava");
    if (mesgul(caseKey))
      throw new Hata(KODLAR.IS_BUSY, "Bu dosya için eşitleme sürüyor; onarım reddedildi.");
    if (eylem === "metin") {
      return {
        caseKey,
        ...metniYenidenUret(kok, kayit.klonYolu, yol, onay === true, {
          // YALNIZ gerçekten düzelen sorun kapanır ve kullanıcının YOKSAYDIĞI
          // kayıt geri açılmaz: `acikBul` yalnız açık kayıt döndürür.
          duzeldi: (evrakId) => {
            const s = sorunlar.acikBul(caseKey, evrakId, "donusum");
            if (s !== undefined) sorunlar.cozuldu(s.sorunId);
          },
        }),
      };
    }
    const plan = kaynakOnarimPlani(kok, kayit.klonYolu, yol);
    if (onay !== true || !plan.yapilabilir) return { caseKey, ...plan };
    tekIsKontrol();
    kapanisIcinKontrol();
    oturum.gerektigiGibi();
    const is = orkestrator.onarBaslat(caseKey, [yol]);
    return {
      caseKey,
      ...plan,
      isId: is.isId,
      isDurum: is.durum,
      aciklama: `${plan.aciklama} Onarım işi başlatıldı; sonucu İşlemler ekranında görünür.`,
    };
  });

  h.set("sorunlar", async (g) => {
    const islem = g["islem"] as string | undefined;
    const id = g["sorunId"] as string | undefined;
    if (islem === "yoksay" && id !== undefined) {
      const ok = sorunlar.yokSay(id);
      if (!ok) throw new Hata(KODLAR.NOT_FOUND, `sorun yok: ${id}`);
      return { ok: true };
    }
    if (islem === "vazgec" && id !== undefined) {
      const ok = sorunlar.yokSayVazgec(id);
      if (!ok) throw new Hata(KODLAR.NOT_FOUND, `sorun yok: ${id}`);
      return { ok: true };
    }
    // Sınıflama SUNUCUDA yapılır ve satır başına `sayilir` olarak döner (P15c
    // `kaynakDurum` kalıbı): web yalnız gelen bayrağı etikete çevirir, ikinci
    // bir türetme ikizi doğmaz. Kayıtlar KOPYALANARAK işaretlenir; `sayilir`
    // sorunlar.json'a asla yazılmaz.
    const isaretle = (l: Sorun[]) => l.map((x) => ({ ...x, sayilir: eylemeDonukMu(x) }));
    return {
      acik: isaretle(sorunlar.acik()),
      hepsi: isaretle(sorunlar.hepsi()),
      hepsiAdet: sorunlar.hepsi().length,
      acikAdet: sorunlar.acik().length,
      sayilanAdet: sorunlar.acikSayilan().length,
    };
  });

  h.set("isler", async () => {
    return { isler: orkestrator.islerHepsi(), topluIsler: toplu.hepsi() };
  });

  h.set("is", async (g) => {
    const isId = zorla(g, "isId");
    const is = orkestrator.isGetir(isId);
    if (!is) throw new Hata(KODLAR.NOT_FOUND, `iş yok: ${isId}`);
    return is;
  });

  h.set("iptal", async (g) => {
    const isId = zorla(g, "isId");
    if (toplu.isiSahipleniyor(isId)) throw new Hata(KODLAR.INVALID_INPUT, "Bu dosyayı toplu işin düğmeleriyle yönetin.");
    const ok = orkestrator.iptal(isId);
    return { ok, isId };
  });

  h.set("duraklat", async (g) => {
    const isId = zorla(g, "isId");
    if (toplu.isiSahipleniyor(isId)) throw new Hata(KODLAR.INVALID_INPUT, "Bu dosyayı toplu işin düğmeleriyle yönetin.");
    const ok = orkestrator.duraklat(isId);
    return { ok, isId };
  });

  h.set("devam", async (g) => {
    kapanisIcinKontrol();
    oturum.gerektigiGibi();
    const isId = zorla(g, "isId");
    tekIsKontrol(isId);
    const yeni = orkestrator.devamEt(isId);
    if (!yeni) throw new Hata(KODLAR.NOT_FOUND, `duraklatılmış iş yok: ${isId}`);
    return { isId: yeni.isId, durum: yeni.durum };
  });

  h.set("giris", async (g) => {
    kapanisIcinKontrol();
    if (girisSuruyor) throw new Hata(KODLAR.IS_BUSY, "Giriş zaten sürüyor; açık tarayıcıda tamamlayın.");
    if (toplu.aktifMi() || orkestrator.islerHepsi().some(i => i.durum === "calisiyor")) {
      throw new Hata(KODLAR.IS_BUSY, "Girişten önce çalışan indirmeyi duraklatın.");
    }
    girisSuruyor = true;
    try {
    const cerez = g["cerez"] as string | undefined;
    const cerezDosya = g["cerezDosya"] as string | undefined;
    const cdp = g["cdp"] === true;
    const cdpZamanAsimi = g["cdpZamanAsimi"] as number | undefined;
    if (cdp) {
      const sonuc = await cdpGirisi({
        zamanAsimiMs: cdpZamanAsimi,
        ilerle: (o) => olaylar.bas("giris", o),
        // daemon kapanırken bekleyen girişi iptal edebilmek için (madde: açık kaynaklar)
        kaynakKaydet: (temizle) => {
          acikGirisler.add(temizle);
          return () => {
            acikGirisler.delete(temizle);
          };
        },
        ...(sec.cdpTarayiciKomutu !== undefined ? { tarayiciKomutu: sec.cdpTarayiciKomutu } : {}),
        ...(sec.cdpSunucuKur !== undefined ? { sunucuKur: sec.cdpSunucuKur } : {}),
      });
      // Tek probe, yakalamadan SONRA (tarayıcı kapanmış, oturum tamamlanmış).
      // Giriş sürerken portala istek atmak ara oturumu bozuyor (5 Eyl gözlemi:
      // nosessionobject) — o yüzden doğrulama burada, tek seferlik.
      await oturum.girisiDogrula(sonuc.cookie, "cdp");
      return { yontem: "cdp", sureMs: sonuc.sureMs };
    }
    if (cerez !== undefined) {
      const temiz = manuelCerezAyrıştır(cerez);
      await oturum.girisiDogrula(temiz, "manuel");
      return { yontem: "manuel" };
    }
    if (cerezDosya !== undefined) {
      const temiz = dosyadanCerezOku(cerezDosya);
      await oturum.girisiDogrula(temiz, "dosya");
      return { yontem: "dosya" };
    }
    throw new Hata(KODLAR.INVALID_INPUT, "giris: cerez | cerezDosya | cdp=true gerekli");
    } finally { girisSuruyor = false; }
  });

  h.set("giris-iptal", async () => {
    if (girisSuruyor) {
      oturum.cikis(); // devam eden doğrulamanın geç dönen sonucunu geçersiz kılar
      await Promise.all([...acikGirisler].map(temizle => temizle()));
    }
    return { ok: true };
  });

  h.set("cikis", async () => {
    if (girisSuruyor || toplu.aktifMi() || orkestrator.islerHepsi().some(i => i.durum === "calisiyor")) {
      throw new Hata(KODLAR.IS_BUSY, "Çıkıştan önce giriş veya indirme işlemini durdurun.");
    }
    oturum.cikis();
    return { ok: true };
  });

  // ── duruşma takvimi (10 dk önbellek) ────────────────────────────────
  // Pano 5 sn'de bir yoklamasa da çağırabilir; portal yükü önbellekle
  // sınırlı kalır. Oturum yoksa LOGIN_REQUIRED (davalarim ile aynı).
  const durusmaOnbellek = new SorguOnbellek<{ adet: number; durusmalar: DurusmaKaydi[] }>(10 * 60_000);
  h.set("durusmalar", async (g) => {
    oturum.gerektigiGibi();
    const gun = Math.min(31, Math.max(1, Math.round(Number(g["gun"] ?? 7) || 7)));
    const tarih = new Date().toDateString();
    const surum = oturum.surum;
    // Yanıt verinin YAŞINI taşır: ekran "son sorgu" diye tıklama anını değil,
    // ÖLÇÜM anını yazsın. Önbellekten dönen 10 dk'lık liste, tıklama anı kadar
    // taze görünürse avukat son dakikada eklenen duruşmayı görmediğini fark
    // edemez.
    const { deger, at, onbellekten } = await durusmaOnbellek.getirDamgali(
      `${surum}:${tarih}:${gun}`,
      async () => {
        const satirlar = await durusmalariSorgula(istemci, gun);
        return { adet: satirlar.length, durusmalar: satirlar };
      },
    );
    if (surum !== oturum.surum) throw new Hata(KODLAR.LOGIN_REQUIRED, "sorgu sırasında oturum değişti");
    return { ...deger, olcumAt: new Date(at).toISOString(), onbellekten };
  });

  const rpc = new RpcSunucu({
    olaylar,
    isleyiciler,
    appVersion: sec.appVersion ?? paketSurumu(),
    dizin: ayarDir,
    baslatildi: () => { fren.yukle(); orkestrator.depoYukle(); toplu.yukle(); },
    durdurOnay: async (g) => {
      if (g["instanceId"] !== rpc.bilgiGetir()?.instanceId) {
        throw new Hata(KODLAR.APP_GONE, "daemon kimliği değişti; durdurma isteği reddedildi");
      }
      if (girisSuruyor || toplu.aktifMi() || orkestrator.islerHepsi().some((i) => ["calisiyor", "bekliyor"].includes(i.durum))) {
        throw new Hata(KODLAR.IS_BUSY, "Giriş veya indirme işlemi sürüyor; güvenli kapatma için önce durdurun.");
      }
      durdurmaIsteniyor = true;
      return { pid: rpc.bilgiGetir()?.pid, instanceId: rpc.bilgiGetir()?.instanceId };
    },
    durdurSonrasi: () => {
      void daemon.kapat().then(() => sec.kapatildiginda?.());
    },
    kilitKaybi: () => {
      void daemon.kapat().then(() => sec.kapatildiginda?.());
    },
  });

  let webSunucu: { kapat: () => Promise<void> } | null = null;
  /** Bekleyen CDP giriş akışlarının temizleyicileri (tarayıcı çocuk süreci +
   *  profil dizini). daemon.kapat() önce bunları iptal eder. */

  // ── oturum canlı-tutma (keep-alive) ─────────────────────────────────
  // Kural: oturum.json VARSA ve CDP girişi SÜRMÜYORKEN aralıklı olarak
  // probe at. Önceki oturumda yaklaşık dört saat sonra düşüş gözlenmiş;
  // bunun sabit bir sunucu sınırı olduğu henüz doğrulanmış değil.
  // • Giriş sürerken portala SIFIR istek (sıfır-istek kuralı).
  // • oturum.json YOKKEN hiçbir istek.
  // • "2 bitti → sil" sayacı probe()'un İÇİNDE: hangi aktör probe attıysa
  //   etsin (pano/keep-alive) gerçek başarısızlık sayılır; önbellek
  //   okumaları sayılmaz (tek 401 iki kez sayılıp oturum yanlışlıkla
  //   silinmesin).
  const oturumYenileMs = sec.oturumYenileMs ?? 10 * 60_000;
  let oturumYenileT: NodeJS.Timeout | null = null;
  let oncekiTickDosyaVar = false;
  let sonBilinenLoginAt = "";
  const oturumYenile = async (): Promise<void> => {
    if (acikGirisler.size > 0) return;
    const kayit = oturumDepo.oku();
    if (kayit === null) {
      // dosya yok: önceki tick'te VARDIYSA bu bir düşüştür — oturum yaşını
      // kaydet (mutlak sınır hipotezini gelecekteki her ölümle test ederiz)
      if (oncekiTickDosyaVar) {
        oncekiTickDosyaVar = false;
        const yasDk = sonBilinenLoginAt
          ? Math.round((Date.now() - Date.parse(sonBilinenLoginAt)) / 60000)
          : undefined;
        olaylar.bas("oturum", {
          tip: "oturum",
          asama: "oturum-dustu",
          oturumYasDk: yasDk,
          mesaj: `oturum düşmüş${yasDk !== undefined ? ` (yaş ${yasDk} dk)` : ""} — yeniden giriş gerekli (tensip giris --cdp)`,
        });
      }
      return;
    }
    sonBilinenLoginAt = kayit.loginAt;
    oncekiTickDosyaVar = true;
    if (oturum.durumBilgisi().durum === "giris_gerekiyor") return;
    await oturum.probeTaze(oturumYenileMs / 1000); // önbellek penceresi = aralık: tek kadran
    if (oturumDepo.oku() === null) {
      oncekiTickDosyaVar = false;
      const yasDk = sonBilinenLoginAt
        ? Math.round((Date.now() - Date.parse(sonBilinenLoginAt)) / 60000)
        : undefined;
      olaylar.bas("oturum", {
        tip: "oturum",
        asama: "oturum-dustu",
        oturumYasDk: yasDk,
        mesaj: `oturum düşmüş${yasDk !== undefined ? ` (yaş ${yasDk} dk)` : ""} — yeniden giriş gerekli (tensip giris --cdp)`,
      });
    }
  };
  if (oturumYenileMs > 0) {
    oturumYenileT = setInterval(() => {
      void oturumYenile();
    }, oturumYenileMs);
    // unref: süreci ZAMANLAYICI tutmasın — daemon'u RPC sunucusu ayakta
    // tutar; IS_BUSY gibi erken çıkışlarda loop boşalıp süreç doğal çıkar.
    oturumYenileT.unref();
  }

  let kapanma: Promise<void> | undefined;
  const daemon: Daemon = {
    olaylar,
    orkestrator,
    oturum,
    sorunlar,
    registry,
    rpc,
    ayarDizin: ayarDir,
    isleyiciler,
    webKapat: async () => {
      await webSunucu?.kapat();
      webSunucu = null;
    },
    kapat: () => kapanma ??= (async () => {
      durdurmaIsteniyor = true;
      toplu.kapanisiBaslat();
      await orkestrator.kapanisiBekle().catch((e: unknown) => {
        log.write("kapanis", e instanceof Error ? e.message : String(e));
      });
      try { toplu.kapanisiBitir(); } catch (e) { log.write("kapanis", (e as Error).message); }
      if (oturumYenileT !== null) {
        clearInterval(oturumYenileT);
        oturumYenileT = null;
      }
      // RPC'yi kapatmadan ÖNCE bekleyen giriş(ler)i iptal et: tarayıcı çocuk
      // sürecini öldür + profil dizinini sil — süreci arkada bırakma.
      const bekleyen = [...acikGirisler];
      acikGirisler.clear();
      await Promise.all(
        bekleyen.map((t) =>
          Promise.resolve(t()).catch(() => undefined)
        )
      );
      // webKapat'i DİNAMİK çağır: webPanosuBaslat bu metni yeniden atar
      // (kapanış zincirini koruyarak)
      await daemon.webKapat();
      await rpc.durdur();
    })(),
  };
  return daemon;

  function zorla(g: Record<string, unknown>, anahtar: string): string {
    const v = g[anahtar];
    if (typeof v !== "string" || v.length === 0) {
      throw new Hata(KODLAR.INVALID_INPUT, `"${anahtar}" gerekli (dize)`);
    }
    return v;
  }
}

/** Web panosunu başlat (salt-okunur, localhost). */
export async function webPanosuBaslat(
  daemon: Daemon,
  port: number,
  appVersion: string,
  portalUrl: string,
  kokYolu: string
): Promise<string> {
  const { panoSunucu } = await import("./web.js");
  const sunucu = panoSunucu(daemon, appVersion, portalUrl, kokYolu);
  const adres = await new Promise<number>((coz, red) => {
    sunucu.once("error", red);
    sunucu.listen(port, "127.0.0.1", () => {
      const a = sunucu.address();
      if (a === null || typeof a === "string") {
        red(new Error("pano portu alınamadı"));
        return;
      }
      coz(a.port);
    });
  });
  const eski = daemon.webKapat;
  daemon.webKapat = async () => {
    await new Promise<void>((c) => sunucu.close(() => c()));
    await eski();
  };
  return `http://127.0.0.1:${adres}`;
}

/** Çerez dosyası yardımcısı (dosyadan çerez akışı için). */
export function cerezDosyasindanOku(ayarDir: string): string | null {
  const dosya = join(ayarDir, "cerez.txt");
  if (!existsSync(dosya)) return null;
  const icerik = readFileSync(dosya, "utf8").trim();
  return icerik.length > 0 ? icerik : null;
}
