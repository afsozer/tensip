// P06b — SEÇİLİ ONARIM. Denetimin (P06a) bulduğu TEK bir satırı, kullanıcının
// açık onayıyla düzeltir.
//
// ── NEDEN VAR ───────────────────────────────────────────────────────────────
// P06a 21 bulgu türü üretiyor ama hiçbirini düzeltemiyordu: kullanıcı "belgen
// yok" ya da "metin çıkarılamadı" satırını görüyor, elinden bir şey gelmiyor
// ve tek çare bütün davayı eşitlemek oluyordu. Bu modül o boşluğu iki eylemle
// kapatır ve İKİSİNİN DE KARARINI TEK YERDE tutar.
//
// ── İKİ EYLEM ───────────────────────────────────────────────────────────────
//   metin   — AĞSIZ. Kaynak sağlamsa `.md` türevi yeniden üretilir. Oturum
//             İSTEMEZ, portala TEK istek atmaz, kaynağın sha256'sını
//             DEĞİŞTİRMEZ (kabul ölçütü 1). En sık sebebi: `pdftotext` kurulu
//             değildi (`arac-yok`), sonradan kuruldu.
//   kaynak  — AĞ. Eksik/bozuk kaynak portaldan geri getirilir. Bu modül yalnız
//             YEREL planı üretir; indirmeyi orkestratör yapar (`onar` işi),
//             çünkü fren, oturum, duraklat/iptal ve iş geçmişi oradadır.
//
// ── BULGU → EYLEM EŞLEMESİ MOTORDA, TEK YERDE ───────────────────────────────
// `ONARIM_TABLOSU` bir `Record<BulguTuru, …>`dur: yeni bir bulgu türü açıp
// eşlemeyi unutmak DERLEME HATASIDIR. Arayüz ikinci bir tablo YAZMAZ, satırla
// birlikte gelen kararı gösterir (P16'nın `sayilir`, P15c'nin `kaynakDurum`
// kalıbı). Onarılamayan bulguda düğme ÇİZİLMEZ ve sebebi yazılır — onarılamayanı
// onarılabilir göstermek P06a'nın açık kararının ihlalidir.
//
// ── BAYAT RAPORDAN ONARIM YAPILMAZ ──────────────────────────────────────────
// Denetim raporu bir ANLIK GÖRÜNTÜDÜR; arada dosya değişmiş olabilir. Buradaki
// her giriş noktası manifesti ve kaynağı YENİDEN ÖLÇER; rapora bakarak iş
// yapmaz. Ölçüm eskimişse eylem "yapılamaz" döner ve tek bayt değişmez.
//
// ── ONAY KALIBI `sadelestir` (P19b) İLE AYNI ────────────────────────────────
// Onaysız çağrı TEK BAYT değiştirmez, yalnız planı döndürür. Onaylı çağrı önce
// manifesti yedekler (`manifestiYedekle`), sonra yazar. Hiçbir dalda belge
// dosyası SİLİNMEZ ve üzerine YAZILMAZ.

import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { donustur } from "../convert/run.js";
import { kapsamIcindeMi, kapsamKontrol, kaynakOlcer } from "./fsops.js";
import { kayitAnahtari } from "./eslestir.js";
import {
  MANIFEST_ADI,
  ManifestDepo,
  hamDosyaKaydiTutuyorMu,
  manifestiYedekle,
  yolaGoreTekKayit,
  type ManifestEvrak,
} from "./manifest.js";
import { kayitGruplari } from "./sisme.js";
import type { BulguTuru } from "./denetim.js";

/** Kullanıcının seçebileceği onarım eylemleri. */
export type OnarimEylemi = "metin" | "kaynak" | "sadelestir";

export interface OnarimBilgisi {
  /** `null` = bu bulgu bu sürümde onarılamaz; arayüz düğme ÇİZMEZ. */
  eylem: OnarimEylemi | null;
  /** Eylem portala istek atar mı? Ağsız onarım oturum istemez. */
  ag: boolean;
  /** Düğme metni; `eylem` null ise boş dize. */
  etiket: string;
  /** Onarılabiliyorsa ne yapılacağı, onarılamıyorsa NEDEN — tek cümle. */
  sebep: string;
}

const YOK = (sebep: string): OnarimBilgisi => ({ eylem: null, ag: false, etiket: "", sebep });

/**
 * BULGU TÜRÜ → EYLEM. Ürünün tek eşleme tablosu.
 *
 * `Record<BulguTuru, …>` bilerek: motorda yeni bulgu türü açan biri burayı
 * doldurmadan derleyemez. Onarılamayan türlerde sebep BOŞ BIRAKILMAZ —
 * kullanıcı "neden düğme yok" sorusunun yanıtını satırda görür.
 */
export const ONARIM_TABLOSU: Record<BulguTuru, OnarimBilgisi> = {
  // ── kayıt ekseni ──────────────────────────────────────────────────────────
  "manifest-yok": YOK(
    "Dosya kaydının kendisi yok; onarım tek bir evrakı hedefler, kaydı sıfırdan kurmaz. Bu dosyayı yeniden indirin.",
  ),
  "manifest-bozuk": YOK(
    "Dosya kaydı okunamıyor; hangi evrakın nerede olduğu bilinmeden hiçbir satır güvenle onarılamaz.",
  ),
  "manifest-erisilemiyor": YOK(
    "Dosya kaydı okunamadı (izin ya da bağlı olmayan disk); onarım okuyamadığı bir kayda yazmaz.",
  ),
  "kayit-bozuk": YOK(
    "Bu satırda yol ya da geçerli bir içerik özeti yok; neyin doğru olduğu ölçülemediği için onarım hedefi belirsizdir.",
  ),
  "kayitlar-eksik": YOK(
    "Kayıtta hiç evrak yok; klasördeki dosyaları kayda bağlamak manifest yeniden kurmaktır ve bu sürümde yoktur.",
  ),
  "mukerrer-kayit": YOK(
    "Arıza değildir: portal iki kimliği de döndürdüğü sürece iki kayıt da saklanır. Düşürülecek bir şey yok.",
  ),
  "yol-cakismasi": YOK(
    "İki kayıt aynı dosyayı gösteriyor ama içerikleri farklı; hangisinin doğru olduğu ölçülemiyor, tahminle kayıt düzeltilmez.",
  ),
  "grup-sismis": {
    eylem: "sadelestir",
    ag: false,
    etiket: "Fazlalığı sadeleştir",
    // KAPSAM CÜMLEDE YAZILI: bu düğme YALNIZ bu satırın grubunu sadeleştirir
    // (`sadelestir` çağrısı satırın yolunu taşır). Davanın tamamını
    // sadeleştiren düğme Evraklar ekranındadır.
    sebep:
      "Bu satırın grubunda, portalın bildirdiği sayının üstündeki mükerrer kayıtlar manifestten düşer; belge dosyalarına dokunulmaz.",
  },
  // ÖLÇÜLDÜ (test/p06b.test.ts): `sadelestir` yalnız manifest > portal olan
  // grupta satır düşürür. İkiz kayıtta sayı portalınkine EŞİTTİR, yani
  // sadeleştirme boş plan döndürür — düğme çizilseydi hiçbir şey yapmayan bir
  // düğme olurdu. Doğru iş yeniden eşitlemedir ve o bütün davayı ilgilendirir.
  "grup-ikiz": YOK(
    "Kayıt sayısı doğru ama iki kayıt aynı indirmenin kopyası: grubun BAŞKA bir belgesi eksik olabilir. Seçili onarım hangisinin eksik olduğunu ölçemez; bu dosyayı yeniden eşitleyin.",
  ),
  "grup-olculemez": YOK(
    "Numarasız evrakta portalın kaç satır bildirdiği ölçülemiyor; iki farklı belgeyi karıştırma riski alınmaz.",
  ),
  // ── klasör ekseni ─────────────────────────────────────────────────────────
  "klasor-yok": YOK(
    "Dava klasörü yerinde değil; klasör taşıma ve yeniden kurma bu sürümde yoktur.",
  ),
  "klasor-erisilemiyor": YOK(
    "Klasör okunamadı (izin ya da bağlı olmayan disk); erişim düzelmeden hiçbir onarım güvenli değildir.",
  ),
  "kayitsiz-klasor": YOK(
    "Klasör diskte ama uygulamanın listesinde yok; kayda bağlamak arşiv düzenini değiştirir, seçili onarımın işi değildir.",
  ),
  // ── kaynak ekseni ─────────────────────────────────────────────────────────
  "kaynak-yok": {
    eylem: "kaynak",
    ag: true,
    etiket: "Kaynağı yeniden indir",
    sebep: "Belge portaldan yeniden indirilip kayıtlı yoluna yazılır; oturum gerekir.",
  },
  "kaynak-erisilemiyor": {
    eylem: "kaynak",
    ag: true,
    etiket: "Kaynağı yeniden indir",
    sebep:
      "Belge portaldan yeniden indirilir; okunamayan dosya EZİLMEZ, yeni kopya ayrı bir yola yazılır. Oturum gerekir.",
  },
  "hash-uyusmuyor": {
    eylem: "kaynak",
    ag: true,
    etiket: "Kaynağı yeniden indir",
    sebep:
      "Belge portaldan yeniden indirilir; yerelde değişmiş dosya EZİLMEZ, yeni kopya ayrı bir yola yazılır. Oturum gerekir.",
  },
  "olculmedi-buyuk": YOK(
    "Bu bir arıza değil, ölçümün sınırı: belge denetimin dosya sınırından büyük olduğu için özeti hesaplanmadı.",
  ),
  "kapsam-disi": YOK(
    "Kayıtlı yol arşivin dışını gösteriyor; onarım kök dışına tek bayt yazmaz.",
  ),
  // ── türev ekseni ──────────────────────────────────────────────────────────
  "turev-yok": {
    eylem: "metin",
    ag: false,
    etiket: "Metni yeniden üret",
    sebep: "Hazır metin yerel kaynaktan yeniden üretilir; portala istek gitmez, kaynak değişmez.",
  },
  "turev-erisilemiyor": {
    eylem: "metin",
    ag: false,
    etiket: "Metni yeniden üret",
    sebep: "Hazır metin yerel kaynaktan yeniden üretilir; portala istek gitmez, kaynak değişmez.",
  },
  // ── yarım kalmış yazım ────────────────────────────────────────────────────
  // P06c — ONARIM DÜĞMESİ BİLEREK ÇİZİLMEZ. Artık dosyayı silmek kolay olurdu
  // ama kurtarma "kullanıcının kararını bekleyen şeyi GÖSTERİR, kendiliğinden
  // düzeltmez" kuralının altındayız: bu satırın asıl bilgisi artığın kendisi
  // değil, HEDEF belgenin durumudur ve onu yeniden eşitleme düzeltir. Silme
  // eylemi eklenseydi ürün ilk kez bir belge dosyasını silen düğmeye sahip
  // olurdu; kazanç bir kaç kilobayt, bedel geri alınamaz bir tık.
  "yarim-yazim": YOK(
    "Yarım kalmış yazımın geçici dosyası bir belge değildir ve hiçbir kaydı onarmaz; denetim onu silmez. Hedef belgenin durumu kendi satırında görünür — o dosyayı yeniden eşitleyin; artığı isterseniz elle silebilirsiniz.",
  ),
  // P06c (inceleme) — DÜĞME YİNE ÇİZİLMEZ ama SEBEP BAŞKADIR. Yukarıdaki
  // cümle "o dosyayı yeniden eşitleyin" der; hedef sağlam geldikten sonra bu
  // öneri yanlıştır — kullanıcı eşitlemeyi zaten yapmıştır ve tekrarı hiçbir
  // şeyi değiştirmez. Tek tür kullanılsaydı arayüz kapanmış bir kesinti için
  // bitmeyen bir iş önermeye devam ederdi.
  // CÜMLE ARAYÜZDEKİ ÖNEKİN ARDINA OKUNARAK YAZILDI ("Bu bulgu onarılamaz: …");
  // ekranda ölçüldü, kendi başına bir cümle gibi kurulunca iki üst üste iki
  // nokta çıkıyordu.
  "yarim-yazim-artigi": YOK(
    "hedef belge yerinde ve kayıtlı içerik özetiyle birebir; onarılacak bir şey kalmadı. Geriye kalan geçici dosya bir belge değildir — denetim onu silmez, isterseniz elle silebilirsiniz.",
  ),
  // ── yetim ─────────────────────────────────────────────────────────────────
  "yetim-dosya": YOK(
    "Kayıtsız dosya ÇÖP DEĞİLDİR — korunmuş eski bir kaynak olabilir. Silme ve kayda bağlama bu sürümde yoktur.",
  ),
};

/** Bir bulgu türünün onarım kararı. Bilinmeyen tür "onarılamaz" sayılır. */
export function onarimBilgisi(tur: BulguTuru): OnarimBilgisi {
  return (
    ONARIM_TABLOSU[tur] ??
    YOK("Bu bulgu türü için tanımlı bir onarım yok.")
  );
}

// ── hedef çözümü ────────────────────────────────────────────────────────────

/** Onarım hedefinin sonucu; her dal tek cümlelik bir sebep taşır. */
export type OnarimDurumu =
  /** Yapıldı ve sorun gerçekten düzeldi. */
  | "onarildi"
  /** Çalıştı ama sonuç hâlâ hazır metin değil (örn. pdftotext hâlâ yok). */
  | "duzelmedi"
  /** Ölçüm eskimiş: ortada onarılacak bir şey yok. */
  | "zaten-yerinde"
  /** Manifestte bu yolu gösteren tek bir kayıt bulunamadı. */
  | "kayit-belirsiz"
  /** Kaynak yerinde değil ya da kaydını tutmuyor: metin ondan üretilemez. */
  | "kaynak-saglam-degil"
  /** Portal satırı bu kayda tekil olarak bağlanamıyor (P20 dersi). */
  | "kimlik-belirsiz"
  /** Onay verilmedi: yalnız plan. */
  | "plan";

export interface OnarimSatiri {
  eylem: OnarimEylemi;
  /** Dava klasörüne göreli hedef yol. */
  yol: string;
  durum: OnarimDurumu;
  /** Onay verilirse (ya da verildiyse) iş yapılabilir mi? */
  yapilabilir: boolean;
  /** Diske yazıldı mı? Onaysız çağrıda HER ZAMAN false. */
  uygulandi: boolean;
  /** Kullanıcıya gösterilecek tek cümle. */
  aciklama: string;
  /** Eylem portala istek atar mı? */
  ag: boolean;
  mdStatus?: string;
  mdPath?: string;
  mdHata?: string;
  /** Onarım sonrası kaynağın özeti — metin onarımında DEĞİŞMEMİŞ olmalıdır. */
  kaynakSha?: string;
  /** Uygulandıysa manifest yedeğinin adı. */
  yedek?: string;
  /** Ağ onarımında: dosya yerinde yok, kayıtlı yola yazılabilir mi? */
  yerindeYazilir?: boolean;
}

/**
 * Manifestte verilen yolu gösteren TEK kayıt; yoksa/çoksa null.
 *
 * Kural bu modülde DEĞİL, `src/store/manifest.ts` `yolaGoreTekKayit` içinde:
 * denetim raporu türev bulgusunda `mdPath` yazar, kaynak bulgusunda `path`.
 * İkisi de aynı kaydı bulmalı, yoksa raporun kendi satırıyla çağrılan onarım
 * düşer (ÖLÇÜLDÜ — bkz. o işlevin başlığı).
 */
const tekKayitBul = yolaGoreTekKayit;

/**
 * Kaynağın ŞU ANKİ durumu — denetimle AYNI yardımcıyla ölçülür
 * (`src/store/fsops.ts` `kaynakOlcer`), ikinci bir "eksik" tanımı yazılmaz.
 */
function kaynakDurumu(
  klasor: string,
  kayit: ManifestEvrak,
): { tur: "saglam" | "yok" | "erisilemiyor" | "kapsamDisi" | "degismis"; aciklama: string } {
  const mutlak = resolve(klasor, kayit.path);
  const olcum = kaynakOlcer(klasor)(mutlak);
  if (olcum.durum === "kapsamDisi")
    return { tur: "kapsamDisi", aciklama: "Kayıtlı yol dava klasörünün dışına çıkıyor." };
  if (olcum.durum === "erisilemiyor")
    return {
      tur: "erisilemiyor",
      aciklama: `Kaynak belge okunamadı${olcum.errno !== undefined ? ` (${olcum.errno})` : ""}.`,
    };
  if (olcum.durum === "yok" || olcum.tur !== "dosya")
    return { tur: "yok", aciklama: "Kaynak belge kayıtlı yolda yok." };
  if (!hamDosyaKaydiTutuyorMu(klasor, kayit))
    return {
      tur: "degismis",
      aciklama: "Kaynak belge yerinde ama içeriği kayıtlı özetiyle uyuşmuyor.",
    };
  return { tur: "saglam", aciklama: "Kaynak belge yerinde ve içeriği kayıtlı özetiyle birebir." };
}

/** Türev dosyası şu anda diskte duruyor mu? */
function turevYerindeMi(klasor: string, kayit: ManifestEvrak): boolean {
  const md = typeof kayit.mdPath === "string" ? kayit.mdPath : "";
  if (md === "" || kayit.mdStatus !== "ok") return false;
  const mutlak = resolve(klasor, md);
  if (!kapsamIcindeMi(klasor, mutlak)) return false;
  try {
    return statSync(mutlak).isFile();
  } catch {
    return false;
  }
}

// ── (a) METNİ YENİDEN ÜRET — AĞSIZ ──────────────────────────────────────────

/**
 * Tek bir kaydın `.md` türevini yeniden üretir.
 *
 * KAYNAĞA TEK BAYT YAZILMAZ ve PORTALA TEK İSTEK GİTMEZ: bu işlev portal
 * istemcisini hiç görmez. Kaynak sağlam DEĞİLSE iş YAPILMAZ — bozuk bir
 * dosyadan üretilen metin, kullanıcının "hazır metin" sandığı bir yalandır.
 *
 * Yeni dönüştürücü YAZILMADI: `donustur(kok, relHam)` zaten var
 * (src/convert/run.ts) ve eşitlemenin kullandığı dağıtımın AYNISIDIR.
 */
export function metniYenidenUret(
  kok: string,
  klasor: string,
  rel: string,
  onay: boolean,
  /**
   * Sorun defteri kancası. Bu modül `SorunDepo` görmez ve OPAK PORTAL TOKENI
   * DIŞARI VERMEZ: `evrakId` yalnız bu geri çağrıya geçer, RPC yanıtına
   * girmez. Yalnız GERÇEKTEN düzelen satırda çağrılır — düzelmeyen bir işi
   * "çözüldü" saymak sayacı yalancı yapar.
   */
  sec: { duzeldi?: (evrakId: string) => void } = {},
): OnarimSatiri {
  kapsamKontrol(kok, klasor);
  const taban: OnarimSatiri = {
    eylem: "metin",
    yol: rel,
    durum: "plan",
    yapilabilir: false,
    uygulandi: false,
    ag: false,
    aciklama: "",
  };
  const depo = new ManifestDepo(join(klasor, MANIFEST_ADI));
  const manifest = depo.oku();
  if (manifest === null) {
    return { ...taban, durum: "kayit-belirsiz", aciklama: "Dosya kaydı (manifest) okunamadı." };
  }
  const kayit = tekKayitBul(manifest.evraklar, rel);
  if (kayit === null) {
    return {
      ...taban,
      durum: "kayit-belirsiz",
      aciklama:
        "Bu yolu gösteren tek bir kayıt bulunamadı; rapor alındıktan sonra kayıt değişmiş olabilir.",
    };
  }
  kapsamKontrol(klasor, resolve(klasor, kayit.path));
  // BAYAT RAPOR KAPISI: kaynak ŞİMDİ ölçülür.
  const kaynak = kaynakDurumu(klasor, kayit);
  if (kaynak.tur !== "saglam") {
    return {
      ...taban,
      durum: "kaynak-saglam-degil",
      aciklama: `${kaynak.aciklama} Metin ancak sağlam bir kaynaktan üretilir; önce kaynağı onarın.`,
    };
  }
  if (turevYerindeMi(klasor, kayit)) {
    return {
      ...taban,
      durum: "zaten-yerinde",
      kaynakSha: kayit.sha256,
      aciklama: "Hazır metin şu anda yerinde; yapılacak bir iş yok (rapor bu satırda eskimiş).",
    };
  }
  if (!onay) {
    return {
      ...taban,
      yapilabilir: true,
      kaynakSha: kayit.sha256,
      aciklama:
        "Hazır metin yerel kaynaktan yeniden üretilecek. Portala istek gitmez, kaynak dosya ve içerik özeti değişmez.",
    };
  }
  // ONAY VAR: önce yedek, sonra yazım (sadelestir ile aynı sıra).
  const yedek = manifestiYedekle(klasor);
  const son = donustur(klasor, kayit.path);
  kayit.mdStatus = son.mdStatus;
  if (son.mdPath !== undefined) kayit.mdPath = son.mdPath;
  else delete kayit.mdPath;
  if (son.mdHata !== undefined) kayit.mdHata = son.mdHata;
  else delete kayit.mdHata;
  depo.yaz(manifest);
  // Kaynak DEĞİŞMEDİ mi? İddia değil ölçüm: dönüşümden SONRA yeniden bakılır.
  const sonrasi = kaynakDurumu(klasor, kayit);
  const duzeldi = son.mdStatus === "ok" && son.mdPath !== undefined;
  if (duzeldi && typeof kayit.evrakId === "string") sec.duzeldi?.(kayit.evrakId);
  return {
    ...taban,
    durum: duzeldi ? "onarildi" : "duzelmedi",
    yapilabilir: true,
    uygulandi: true,
    yedek,
    mdStatus: son.mdStatus,
    ...(son.mdPath !== undefined ? { mdPath: son.mdPath } : {}),
    ...(son.mdHata !== undefined ? { mdHata: son.mdHata } : {}),
    ...(sonrasi.tur === "saglam" ? { kaynakSha: kayit.sha256 } : {}),
    aciklama: duzeldi
      ? "Hazır metin yeniden üretildi; kaynak dosyaya dokunulmadı."
      : `Metin üretilemedi (${son.mdStatus}${son.mdHata !== undefined ? `: ${son.mdHata}` : ""}). Kayıt bu ölçümle güncellendi, kaynak dosyaya dokunulmadı.`,
  };
}

// ── (b) KAYNAĞI YENİDEN EDİN — YEREL PLAN ───────────────────────────────────

/**
 * Ağ onarımının YEREL planı: indirmeden önce ölçülebilen her şey.
 *
 * Oturum İSTEMEZ ve portala BAKMAZ — kullanıcı oturum açmadan da neyin
 * yapılacağını görebilmeli. Kimliğin portal tarafındaki tekilliği ancak
 * indirme turunda ölçülür; burada MANİFEST tarafındaki belirsizlik ölçülür ve
 * belirsizse plan "yapılamaz" der: P20'de öğrenildi, kimlik belirsizse işlem
 * DURUR, "en iyi tahminle" başka bir belge indirilmez.
 */
export function kaynakOnarimPlani(kok: string, klasor: string, rel: string): OnarimSatiri {
  kapsamKontrol(kok, klasor);
  const taban: OnarimSatiri = {
    eylem: "kaynak",
    yol: rel,
    durum: "plan",
    yapilabilir: false,
    uygulandi: false,
    ag: true,
    aciklama: "",
  };
  const depo = new ManifestDepo(join(klasor, MANIFEST_ADI));
  const manifest = depo.oku();
  if (manifest === null) {
    return { ...taban, durum: "kayit-belirsiz", aciklama: "Dosya kaydı (manifest) okunamadı." };
  }
  const kayit = tekKayitBul(manifest.evraklar, rel);
  if (kayit === null) {
    return {
      ...taban,
      durum: "kayit-belirsiz",
      aciklama:
        "Bu yolu gösteren tek bir kayıt bulunamadı; rapor alındıktan sonra kayıt değişmiş olabilir.",
    };
  }
  const belirsiz = kimlikBelirsizligi(manifest.evraklar, kayit);
  if (belirsiz !== null) return { ...taban, durum: "kimlik-belirsiz", aciklama: belirsiz };
  const kaynak = kaynakDurumu(klasor, kayit);
  if (kaynak.tur === "saglam") {
    return {
      ...taban,
      durum: "zaten-yerinde",
      kaynakSha: kayit.sha256,
      aciklama: `${kaynak.aciklama} Yapılacak bir iş yok (rapor bu satırda eskimiş).`,
    };
  }
  if (kaynak.tur === "kapsamDisi") {
    return { ...taban, durum: "kimlik-belirsiz", aciklama: `${kaynak.aciklama} Onarım kök dışına yazmaz.` };
  }
  const yerinde = hamDosyaKaydiTutuyorMu(klasor, kayit);
  return {
    ...taban,
    yapilabilir: true,
    yerindeYazilir: yerinde,
    aciklama:
      `${kaynak.aciklama} Portalın güncel listesinden bu evrakın kimliği yeniden çözülecek; ` +
      (yerinde
        ? "belge kayıtlı yoluna yazılacak (o yolda ezilecek bir dosya yok)."
        : "yerindeki dosya EZİLMEYECEK, yeni kopya ayrı bir yola yazılacak.") +
      " Kimlik bu turda tekil olarak çözülemezse işlem durur ve hiçbir şey indirilmez.",
  };
}

/**
 * P20 DERSİ — KİMLİK BELİRSİZSE İŞLEM DURUR.
 *
 * Portalın hiçbir kimliği kalıcı değil (`evrakId`, `ggEvrakId` her istekte
 * değişiyor), yani "bu kayıt portalda hangi satır" sorusu ancak GRUP üzerinden
 * yanıtlanır. Grup tanımı ürün genelinde tektir (`src/store/eslestir.ts`
 * `kayitAnahtari`). Manifest tarafında grupta birden çok kayıt varsa hangisinin
 * hangi satır olduğu TAHMİNDİR; onarım tahminle indirmez.
 *
 * Dönüş: engel yoksa null, varsa tek cümlelik sebep.
 */
export function kimlikBelirsizligi(
  kayitlar: readonly ManifestEvrak[],
  kayit: ManifestEvrak,
): string | null {
  const grup = kayitAnahtari(kayit).grup;
  if (grup === null) {
    return (
      "Bu evrakın evrak numarası yok; portal satırıyla tekil olarak eşleştirilemiyor. " +
      "Yanlış belgeyi indirmemek için onarım durdu."
    );
  }
  const uyeler = kayitGruplari(kayitlar).get(grup) ?? [];
  if (uyeler.length > 1) {
    return (
      `Aynı evrak numarası, türü ve tarihi altında ${uyeler.length} kayıt var; portalın hangi satırının ` +
      "bu kayıt olduğu ölçülemiyor. Yanlış belgeyi indirmemek için onarım durdu."
    );
  }
  return null;
}
