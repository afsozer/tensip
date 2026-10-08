// Masaüstü belge erişimi: yalnız kayıtlı dava ve manifest'teki dosya.
import { readFileSync, statSync, realpathSync } from "node:fs";
import { basename, extname, resolve, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Daemon } from "./daemon.js";
import type { RpcIsleyici } from "./rpc.js";
import { ManifestDepo } from "../store/manifest.js";
import { kapsamKontrol, kaynakDurumu, type KaynakOlcum } from "../store/fsops.js";
import { hazirlikCoz, hazirlikOzet } from "../store/hazirlik.js";
import { esitlemeSayaci } from "../store/esitleme.js";
import { Hata, KODLAR } from "../core/errors.js";

export type DosyaAc = (yol: string) => Promise<void>;
const exec = promisify(execFile);
/** Varsayılan açıcı: macOS `open`. Web katmanı testte bunu enjekte
 *  edilen bir kancayla değiştirir (P07a dışa aktarması da kullanır). */
export const varsayilanDosyaAc: DosyaAc = async (yol) => {
  if (process.platform !== "darwin")
    throw new Hata(
      "INVALID_INPUT",
      "Dosya açma yalnız macOS üzerinde kullanılabilir.",
    );
  await exec("/usr/bin/open", [yol], { timeout: 10_000 });
};
// macOS `open` ile hangi biçimin kendi uygulamasında açılacağı. Bu küme bir
// GÜVENLİK sınırı değildir (sınır: registry kaydı + kapsamKontrol + manifest
// üyeliği + realpath), ama hangi işleyicinin ayağa kalkacağını belirler.
//
// .html/.htm, .zip ve .bin BİLEREK DIŞARIDA:
//   .html → `file://` ile varsayılan tarayıcıda açılır ve UYAP HTML'i uzak
//           kaynak çekebilir; README'deki "HTML belge doğrudan uygulama içinde
//           çalıştırılmaz" kuralı delinir. Metni zaten önizlemede hazır.
//   .zip  → Archive Utility dava klasörünün içine takip edilmeyen dosyalar açar.
//   .bin  → LaunchServices'in seçtiği rastgele uygulamaya gider.
// Bunların yerine aşağıdaki `acilmazSebep` gerçek nedeni ve çözümü söyler.
const BELGELER = new Set([
  ".pdf",
  ".udf",
  ".txt",
  ".md",
  ".jpg",
  ".jpeg",
  ".png",
  ".tif",
  ".tiff",
  ".docx",
  ".xlsx",
  ".rtf",
]);

// P15c — kullanıcıya çıkan üç AYRI cevap. Eskiden ikisi ham `ENOENT: no such
// file or directory, stat '/mutlak/yol/...'` olarak (İngilizce + tam arşiv yolu,
// HTTP 500), biri de yanlışlıkla "kök dışına engellendi" olarak çıkıyordu.
// Mutlak yol hiçbirinde YOKTUR: kullanıcıya bir şey anlatmıyor, log'a ve
// yanıt gövdesine arşiv düzenini sızdırıyordu.
const KAPSAM_DISI = "Bu yol arşiv kökünün dışına çıkıyor; erişim engellendi.";
const erisilemedi = (ne: string) =>
  new Hata(
    KODLAR.KAYNAK_ERISILEMEDI,
    `${ne} erişilemedi (izin ya da bağlı olmayan bir disk olabilir); silinmiş olduğu anlamına gelmez.`,
  );

export function belgeIsleyicileri(
  daemon: Daemon,
  kok: string,
  dosyaAc: DosyaAc = varsayilanDosyaAc,
): Map<string, RpcIsleyici> {
  /**
   * Kapsam GÜVENLİK sınırıdır: kök dışına çıkan yol hiç işlenmez, hiç stat
   * edilmez. "yok" ve "erisilemiyor" ise ERİŞİLEBİLİRLİK bilgisidir — kararı
   * çağıran verir, çünkü evrak-oku kaynağı eksik olsa da türetilmiş metni
   * göstermeye devam eder (README §9).
   */
  const kapsamDenetimi = (kokDizin: string, hedef: string): KaynakOlcum => {
    const olcum = kaynakDurumu(kokDizin, hedef);
    if (olcum.durum === "kapsamDisi")
      throw new Hata(KODLAR.PATH_FORBIDDEN, KAPSAM_DISI);
    return olcum;
  };
  const klasorBul = (g: Record<string, unknown>) => {
    const kayit = daemon.registry
      .oku()
      .davalar.find((d) => d.caseKey === g["caseKey"]);
    if (!kayit?.klonYolu)
      throw new Hata("NOT_FOUND", "İndirilmiş dava bulunamadı.");
    const olcum = kapsamDenetimi(kok, kayit.klonYolu);
    if (olcum.durum === "erisilemiyor") throw erisilemedi("Dava klasörüne");
    if (olcum.tur !== "dizin")
      throw new Hata(
        "NOT_FOUND",
        "Dava klasörü arşivde bulunamadı; dosyayı yeniden indirin.",
      );
    return kayit.klonYolu;
  };
  const evrakBul = (g: Record<string, unknown>) => {
    const klasor = klasorBul(g);
    const manifest = join(klasor, "uyap-project.json");
    // Manifest de ÖLÇÜLÜR, yalnız kapsam denetimi yapılmaz. Burası P15c'de
    // gözden kaçan tek eski yoldu: `kapsamKontrol` çağrılıyordu ve dava klasörü
    // erişilemez olduğunda (izin kapalı, disk bağlı değil) `kapsamIcindeMi`
    // EACCES'i yutup false döndüğü için cevap "yazma kök dışına engellendi:
    // <tam arşiv yolu>" oluyordu — hem YANLIŞ kod (PATH_FORBIDDEN, oysa yol kök
    // içindeydi) hem de yanıt gövdesine mutlak arşiv yolu sızıntısı. Üç dalın
    // üçü de artık klasörünkiyle aynı cümleleri kullanır.
    const kayitOlcum = kapsamDenetimi(klasor, manifest);
    if (kayitOlcum.durum === "erisilemiyor") throw erisilemedi("Dava kaydına");
    if (kayitOlcum.tur !== "dosya")
      throw new Hata(
        "NOT_FOUND",
        "Dava kaydı arşivde bulunamadı; dosyayı yeniden indirin.",
      );
    const e = new ManifestDepo(manifest)
      .oku()
      ?.evraklar.find((e) => e.path === g["path"]);
    if (!e) throw new Hata("NOT_FOUND", "Evrak kaydı bulunamadı.");
    const yol = resolve(klasor, e.path);
    // Kaynak dosyanın durumu ÖLÇÜLÜR ama burada karar verilmez.
    const kaynak = kapsamDenetimi(klasor, yol);
    return { klasor, e, yol, kaynak };
  };
  return new Map<string, RpcIsleyici>([
    [
      "evrak-oku",
      async (g) => {
        const { klasor, e, yol, kaynak } = evrakBul(g);
        let metin: string | null = null;
        if (e.mdStatus === "ok" && e.mdPath) {
          const md = resolve(klasor, e.mdPath);
          const olcum = kapsamDenetimi(klasor, md);
          if (olcum.durum === "erisilemiyor")
            throw erisilemedi("Bu evrakın hazır metnine");
          if (olcum.tur !== "dosya")
            throw new Hata(
              "NOT_FOUND",
              "Bu evrakın hazır metni arşivde bulunamadı; dosyayı yeniden eşitleyin.",
            );
          const bilgi = statSync(md, { throwIfNoEntry: false });
          if (!bilgi)
            throw new Hata(
              "NOT_FOUND",
              "Bu evrakın hazır metni arşivde bulunamadı; dosyayı yeniden eşitleyin.",
            );
          if (bilgi.size > 4 * 1024 * 1024)
            throw new Hata(
              "INVALID_INPUT",
              "Bu belge önizleme sınırını aşıyor; aslını açın.",
            );
          metin = readFileSync(md, "utf8");
        }
        return {
          ad: basename(yol),
          metin,
          mdStatus: e.mdStatus,
          // TÜRETİLMİŞ alan: manifest'e geri YAZILMAZ. Eski `unsupported`
          // kayıtlar burada uzantıdan çözülür (src/store/hazirlik.ts).
          hazirlik: hazirlikCoz(e.mdStatus, e.path),
          // P15c — KAYNAK dosyanın durumu; `hazirlik` TÜRETİLMİŞ metni anlatır,
          // bu alan asıl belgeyi. İkisi AYRI eksendir ve birbirinin yerine
          // geçmez: kaynağı silinmiş bir evrakın metni hâlâ "ok" olabilir.
          // KARAR (Eksik 3): kaynak yoksa da önizleme AÇIK kalır — daha önce
          // üretilmiş metin kullanıcının belgeye kalan tek erişimidir; kapatmak
          // güvenlik kazandırmaz, yalnız veri kaybettirir. Yanına durumu koyar.
          kaynakDurum: kaynak.durum,
          tur: e.tur,
          tarih: e.tarih,
          category: e.category,
        };
      },
    ],
    [
      "evrak-ac",
      async (g) => {
        const { e, yol, kaynak } = evrakBul(g);
        const uz = extname(yol).toLowerCase();
        if (!BELGELER.has(uz)) throw new Hata("INVALID_INPUT", acilmazSebep(uz));
        if (kaynak.durum === "erisilemiyor") throw erisilemedi("Kaynak evraka");
        if (kaynak.tur !== "dosya")
          throw new Hata(
            "NOT_FOUND",
            "Bu evrakın kaynağı arşivde bulunamadı; dosyayı yeniden eşitleyin.",
          );
        await dosyaAc(realpathSync(yol));
        return { ok: true, ad: basename(e.path) };
      },
    ],
    [
      "hazirlik-ozet",
      // Dava satırındaki "kullanılabilir/toplam" özetinin TEK KAYNAĞI. Registry'deki
      // `sonEvrakSayisi` türetilmiş ve gecikmeli bir önbellektir (duraklamış işte
      // hiç yazılmaz), özet kaynağı olamaz — doğru kaynak manifest'tir.
      //
      // Bu işleyici yalnız YEREL manifest okur: portala sıfır istek, diske sıfır
      // yazma. Okunamayan tek bir manifest bütün çağrıyı düşürmez; o kayıt
      // `okunamadi:true` ile döner ve diğer davaların özeti korunur.
      //
      // P15b — dava satırındaki "N yeni" sayacı DA buradan gelir; ikinci bir RPC
      // EKLENMEDİ. Ölçüm: bu döngü zaten her davanın manifest'ini açıp parse
      // ediyor, sayaç aynı ayrıştırılmış diziden hesaplanıyor — ek dosya okuması
      // SIFIR. Alternatifler ölçülüp elendi: (a) `davalar` RPC'si registry
      // döndürüyor, registry'de damga yok ve `sonEvrakSayisi` bayat olabilen bir
      // önbellek (README §7) — oraya ayna alan koymak otoriteyi ikiye bölerdi;
      // (b) `evraklar` RPC'si tek dava döndürüyor, liste ekranı N davanın
      // sayacını tek çağrıda isteyemezdi.
      async () => {
        const ozetler = [];
        for (const kayit of daemon.registry.oku().davalar) {
          if (!kayit.klonYolu) continue;
          try {
            kapsamKontrol(kok, kayit.klonYolu);
            const manifest = join(kayit.klonYolu, "uyap-project.json");
            kapsamKontrol(kayit.klonYolu, manifest);
            const m = new ManifestDepo(manifest).oku();
            if (!m) {
              ozetler.push({ caseKey: kayit.caseKey, okunamadi: true });
              continue;
            }
            ozetler.push({
              caseKey: kayit.caseKey,
              ...hazirlikOzet(m.evraklar),
              ...esitlemeSayaci(m.evraklar, m.sonEsitleme),
            });
          } catch {
            ozetler.push({ caseKey: kayit.caseKey, okunamadi: true });
          }
        }
        return { ozetler };
      },
    ],
    [
      "klasor-ac",
      async (g) => {
        // Varlık ve "dizin mi" denetimi klasorBul'da, tek yerde.
        await dosyaAc(realpathSync(klasorBul(g)));
        return { ok: true };
      },
    ],
  ]);
}

/** Uzantı reddi: teknik bir cümle değil, gerçek sebep + yapılacak şey. */
function acilmazSebep(uz: string): string {
  if (uz === ".html" || uz === ".htm")
    return "Bu evrak bir HTML sayfası. Metni önizlemede hazır; aslını görmek için “Klasörü aç” ile dava klasöründen açın. HTML belge güvenlik gereği uygulama içinden çalıştırılmaz.";
  if (uz === ".zip")
    return "Bu evrak bir arşiv dosyası (.zip). İçindekileri görmek için “Klasörü aç” ile dava klasöründen açın; arşiv üyeleri henüz ayrı ayrı listelenmiyor.";
  if (uz === ".bin")
    return "Bu evrak portaldan tanınmayan bir biçimde indi (.bin). Kaynak dosya arşivde duruyor; “Klasörü aç” ile inceleyin.";
  if (uz === "")
    return "Bu evrakın dosya uzantısı yok; hangi uygulamayla açılacağı belirlenemedi. “Klasörü aç” ile dava klasöründen inceleyin.";
  return `Bu biçim (${uz}) doğrudan açılamıyor; “Klasörü aç” ile dava klasöründen inceleyin.`;
}
