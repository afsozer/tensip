// P20 — "PORTALIN ŞU AN İNDİRDİĞİM SATIRI ZATEN ELİMDEKİ BELGE Mİ?"
//
// ── NİYE AYRI BİR MODÜL ─────────────────────────────────────────────────────
// `eslestir.ts` bu soruyu İNDİRMEDEN ÖNCE, yalnız metadata ile yanıtlar ve
// belirsiz grupta yanıtı bir TAHMİNDİR. Bu modül aynı soruyu İNDİRDİKTEN
// SONRA, içerikle yanıtlar. İkisi ayrı dosyada çünkü ölçütleri ayrı: biri
// numara/tür/tarih, öteki ÇIKARILAN METİN. Dosya sistemi, portal ve manifest
// yazımı buraya GİRMEZ — girdi ölçüm, çıktı kayıt seçimi.
//
// ── ÖLÇÜLMÜŞ KUSUR (13 Eylül, izole motor + sahte portal) ───────────────────
// Arşivde [ALFA, BETA], portal [ALFA, GAMA] veriyor. Grup BÜYÜMEDİĞİ için
// eski tazeleme koşulu tetiklenmiyordu; eşitleme "0 yeni, 0 eksik" diyor,
// denetim "0 bulgu" diyor ve GAMA HİÇ İNMİYORDU. Ürünün yapabileceği en kötü
// hata budur: portalda duran bir belge arşivde yok ve hiçbir yüzey söylemiyor.
//
// ── NEDEN METİN ─────────────────────────────────────────────────────────────
// Ölçülmüş kısıtlar (kullanıcının kendi dosyası, 12–13 Eylül):
//   • Portalın hiçbir kimliği kalıcı değil (`evrakId`, `ggEvrakId`: 0/113).
//   • `birimEvrakNo + tur + tarih` belirsiz grubun üyelerini ayırt etmiyor.
//   • BAYT karşılaştırması yanıtlamıyor: UYAP belgeyi her indirişte yeniden
//     üretiyor (34090/34092/34093 bayt, sha256 farklı).
//   • AMA ÇIKARILAN METİN birebir aynı kalıyor. Denetim (`sisme.ts`) bu ölçütü
//     zaten kullanıyor; ürün genelinde "aynı belge" tanımı TEKTİR.
//
// Bayt eşitliği yine de ikinci ölçüttür ve YALNIZ olumlu yönde kullanılır:
// iki dosyanın sha256'sı aynıysa aynı belgedir (yanlış pozitif yoktur), farklı
// olması hiçbir şey söylemez. Metni olmayan (`gorsel`, `arac-yok`) evrakta
// elimizdeki tek ölçüt budur.
//
// ── KÜME KORUNUR: İKİ BELGE TEK KAYDA İNDİRGENMEZ ──────────────────────────
// Her satır EN ÇOK BİR kayıt sahiplenir (`#sahipli`), sahiplenen kayıt havuzdan
// çıkar. Aynı metni taşıyan iki portal satırı (UYAP aynı şablonu iki kez
// gönderebiliyor — gerçek arşivde ölçüldü) bu yüzden iki AYRI kaydı sahiplenir.
// N portal satırı → N kayıt; birleşme tanım gereği imkânsızdır.
//
// ── ÜZERİNE YAZILACAK KAYDIN SEÇİMİ: SAYARAK ───────────────────────────────
// Metni tanınmayan satır gerçekten başka bir içeriktir ve bir yere yazılmalıdır.
// İki seçenek de bedelli:
//   • Eşleşen kaydın YOLUNA yazmak (üzerine yazmak) diski şişirmez ama o yolda
//     duran belgeyi YOK EDER.
//   • Yeni bir yol açmak hiçbir belgeyi yok etmez ama arşivde portalın artık
//     bildirmediği bir kayıt bırakır.
// Karar TAHMİNLE değil SAYIYLA verilir. B = gruptaki BOŞTA kayıt sayısı,
// K = bu satırdan SONRA aynı grupta inecek satır sayısı:
//
//   B == K + 1  → ÜZERİNE YAZ. Boş kayıtlar, ev arayan satırları (bu satır
//                 dahil) tam olarak karşılıyor; birini almak kardeş satırları
//                 evsiz bırakmaz ve arşivde portalın bildirmediği kayıt yoktur.
//   B >  K + 1  → YENİ YOL. Grupta FAZLA kayıt var; bunlar portalın artık
//                 bildirmediği ama arşivde duran belgelerdir (KABUL 4: portal
//                 satırı düşürünce kayıt SİLİNMEZ). Onları ezmek, silmenin
//                 daha sinsi biçimidir.
//   B <  K + 1  → YENİ YOL. Grup BÜYÜYOR; boş kayıtlar kardeş satırlara
//                 yetmiyor. Bu satır birini alırsa kardeşi metniyle tanıyacağı
//                 kaydı bulamaz ve zincirleme yeniden yazma başlar.
//   B == 0      → YENİ YOL (yukarıdakinin sınır hâli).
//
// METNİ ÖLÇÜLEMEYEN İÇERİĞİN İSTİSNASI — VE ONUN SINIRI (inceleme, 13 Eylül)
// Metni ölçülemeyen içerik (`gorsel`, `arac-yok`, `desteklenmiyor`) yeni yola
// yazılırsa bir daha ASLA tanınamaz (metni yok, baytı her indirişte değişiyor)
// ve her eşitleme bir kayıt daha ekler — ölçüldü: 8 → 9 kayıt, 15 → 16 dosya,
// sınırsız. Bu yüzden `B < K + 1` (grup büyüyor) hâlinde sayma kuralının
// dışında tutulur ve boşta bir kaydın üzerine yazar; orada zaten fazla kayıt
// yoktur, yazılan her kayıt bir portal satırının karşılığıdır.
//
// AMA `B > K + 1` HÂLİNDE İSTİSNA YOKTUR. İstisna oraya da uzatılınca ölçülen
// sonuç (izole motor + sahte portal, sentetik veri): arşivde üç görsel belge
// [ALFA, BETA, CEM] varken portal yalnız CEM'i bildirirse birinci eşitleme
// ALFA'nın, ikincisi BETA'nın belgesini YOK EDİYORDU — kayıt sayısı ve dosya
// sayısı 3'te SABİT kaldığı için hiçbir yüzey bunu göstermiyor, denetim
// "0 bulgu" diyordu. Sinsi silmenin tarifi budur (bkz. ROADMAP §15c karar 4).
//
// Şişme kaygısı istisnayı daraltınca geri gelmez, çünkü fazlalık hâlinde
// açılan yeni yol KAYIT OLARAK İŞARETLENİR (`ManifestEvrak.belirsizKopya`):
// o kayıt bir belgenin arşivdeki tek kopyası değil, tanınamayan içerik için
// BU MEKANİZMANIN açtığı yedektir. Bir sonraki turda fazlalık yine fazlalıktır
// ve metni ölçülemeyen satır kendi açtığımız yedeği yeniden kullanır — grup
// bir kez büyür, sonra sabitlenir. Portalın düşürdüğü GERÇEK belgeler ise
// hiçbir turda ezilmez.
//
// ÖLÇÜLDÜ — sayma kuralı olmadan (her tanınmayan satır kendi eşleşen kaydını
// ezerken): portal grubun BAŞINA yeni bir belge koyduğunda üç satırın üçü de
// yeniden yazılıyor ve sayaç "2 yenilenen" diyor, oysa değişen tek belge var.
// Kuralla: 1 yeni dosya, 0 yeniden yazma, iki eski belge KORUNAN.
//
// Üzerine yazılacaksa kurban üç kuralla daraltılır:
//   0. HAM DOSYASI YERELDE DEĞİŞMİŞ kayıt hiçbir dalda kurban seçilmez
//      (`ezilebilir`). README'nin sözü budur: "Yerelde değişmiş kaynak üzerine
//      yazılmaz, yeni indirme ayrı dosyaya kaydedilir." Ölçüm yapan taraf
//      çağırandır (dosya sistemi bu modüle girmez); ölçemeyen taraf "ezilemez"
//      der — ölçülemeyen şey yok edilmez. Kaydın dosyası HİÇ YOKSA o yola
//      yazmak onarımdır ve serbesttir.
//   1. İndirilen içeriğin metni ÖLÇÜLEMİYORSA (görsel evrak), kurban öncelikle
//      metni ölçülemeyen bir kayıttır. Metinli kayıtları görsel bir satıra
//      kurban etmek, o metni bekleyen kardeş satırın da yazmasına yol açar ve
//      grup her eşitlemede kendi içinde yer değiştirir.
//   2. Aksi hâlde eşleştiricinin verdiği kayıt (`tercih`) yeğlenir; o
//      sahiplenilmişse gruptaki başka bir boş kayıt alınır.

import type { ManifestEvrak } from "./manifest.js";

/** Havuzdaki bir kaydın ölçümü. */
export interface AdayKayit {
  kayit: ManifestEvrak;
  /**
   * Kaydın `.md` türevinin özeti; ÖLÇÜLEMEDİYSE null. Görsel evrakta,
   * dönüşümü düşmüş evrakta ve `.md`si silinmiş kayıtta null olur — null bir
   * kayıt metinle ASLA eşleşmez (ölçülemeyen şey "aynı" ilan edilmez).
   */
  metin: string | null;
  /** Kaydın ham dosyasının sha256'sı (manifestten); bilinmiyorsa boş dize. */
  bayt: string;
  /**
   * Bu kaydın DOSYASI üzerine yazılabilir mi? `false` = ham dosya diskte
   * duruyor ama artık manifestin bildirdiği belge değil (kullanıcı elle
   * değiştirmiş ya da dosya ölçülemedi) — o belge yok edilmez, çağıran yeni
   * yol açar. Verilmezse "yazılabilir" sayılır (birim testleri ve dosya
   * sistemine bakmayan çağıranlar için).
   *
   * FONKSİYON, çünkü ölçüm pahalıdır (dosyayı okuyup özetlemek gerekir) ve
   * çoğu kayıt hiç kurban adayı olmaz; çağıran memoize eder.
   */
  ezilebilir?: () => boolean;
}

/** İndirilen içeriğin aynı iki ölçüsü. */
export interface IndirilenOlcum {
  metin: string | null;
  bayt: string;
}

/**
 * `kurban`ın kararı. "Yeni yol" tek bir şey değildir; çağıranın açtığı yolu
 * YEDEK KOPYA olarak işaretleyip işaretlemeyeceği buna bağlıdır:
 *
 *   • `yedek: false` — grupta korunacak bir şey yoktu (havuz boş: belgenin İLK
 *     evi) ya da açılan yol gerçekten yeni bir belgenin evi (grup büyüyor,
 *     metinli fazlalık). Bu kayıt bir daha "kopya" diye ezilemez.
 *   • `yedek: true` — metni ölçülemeyen içerik, EZMEYİ REDDETTİĞİMİZ için yeni
 *     yola indi. Bir sonraki turda yine tanınamayacağı için o yolu yeniden
 *     kullanmak şişmeyi durdurur; hiçbir gerçek belge yok olmaz.
 */
export type KurbanKarari =
  | { tur: "yaz"; kayit: ManifestEvrak }
  | { tur: "yeni-yol"; yedek: boolean };

/**
 * Belirsiz grupların kayıt havuzu. Tek eşitleme turuna aittir; tur bitince
 * atılır (bir sonraki tur manifesti yeniden okur).
 */
export class BelirsizHavuz {
  readonly #gruplar: Map<string, AdayKayit[]>;
  readonly #sahipli = new Set<ManifestEvrak>();

  constructor(gruplar: Map<string, AdayKayit[]>) {
    this.#gruplar = gruplar;
  }

  /**
   * Bir kaydı havuzdan ÇIKARIR. İki yerden çağrılır: kimlikle eşleşip yeniden
   * indirilmeyecek satırın tuttuğu kayıt (o kayıt zaten sahiplidir) ve
   * `esle`/`kurban`ın kendi seçimi.
   */
  sahiplen(kayit: ManifestEvrak): void {
    this.#sahipli.add(kayit);
  }

  #bosta(grup: string): AdayKayit[] {
    return (this.#gruplar.get(grup) ?? []).filter((a) => !this.#sahipli.has(a.kayit));
  }

  /**
   * İndirilen içeriğin ZATEN ELDE olan karşılığı. Bulunursa kayıt sahiplenilir
   * ve bir daha başka satıra verilmez; bulunmazsa `undefined`.
   *
   * Metin ölçütü ÖNCE denenir (UYAP baytları yeniden ürettiği için bayt
   * eşitliği çoğu belgede hiç tutmaz), sonra bayt ölçütü.
   */
  esle(grup: string, olcum: IndirilenOlcum): ManifestEvrak | undefined {
    const bosta = this.#bosta(grup);
    const metinle =
      olcum.metin === null ? undefined : bosta.find((a) => a.metin === olcum.metin);
    const secim =
      metinle ?? (olcum.bayt === "" ? undefined : bosta.find((a) => a.bayt === olcum.bayt));
    if (secim === undefined) return undefined;
    this.#sahipli.add(secim.kayit);
    return secim.kayit;
  }

  /**
   * Eşleşme yoksa baytların ÜZERİNE YAZILACAĞI kayıt. Seçilen kayıt
   * sahiplenilir. `yeni-yol` = üzerine yazılmaz, çağıran YENİ BİR YOL açar.
   *
   * `kalanSatir` bu satırdan SONRA aynı grupta inecek satır sayısıdır; sayma
   * kuralı ve gerekçesi dosya başındadır.
   */
  kurban(
    grup: string,
    olcum: IndirilenOlcum,
    tercih: ManifestEvrak | undefined,
    kalanSatir: number,
  ): KurbanKarari {
    const bosta = this.#bosta(grup);
    // Havuzda boşta kayıt YOKSA korunacak belge de yoktur: açılan yol bu
    // belgenin İLK evidir (klon turunun tamamı böyledir), yedek kopya değildir.
    if (bosta.length === 0) return { tur: "yeni-yol", yedek: false };
    // KURAL 0 — yerelde değişmiş kaynak hiçbir dalda ezilmez. Sayıya
    // (`bosta.length`) yine de girer: "grupta fazla kayıt var mı" sorusu
    // dosyanın elle değişip değişmediğinden bağımsızdır.
    const adaylar = bosta.filter((a) => a.ezilebilir === undefined || a.ezilebilir());
    if (bosta.length > kalanSatir + 1) {
      // FAZLA KAYIT: bunlar portalın artık bildirmediği ama arşivde duran
      // belgelerdir (P19 KABUL 4). Metni ölçülebilen içerik yeni yol açar ve
      // bir sonraki turda metniyle tanınır — şişme birde durur.
      if (olcum.metin !== null) return { tur: "yeni-yol", yedek: false };
      // Metni ölçülemeyen içerik bir daha tanınamaz; her turda yeni yol açmak
      // sınırsız şişmedir. Çözüm ezmek DEĞİL, kendi açtığımız yedeği yeniden
      // kullanmaktır: `belirsizKopya` taşıyan kayıt, tanınamayan içerik için
      // bu mekanizmanın yazdığı kopyadır, portalın düşürdüğü bir belge değil.
      const yedekler = adaylar.filter((a) => a.kayit.belirsizKopya === true);
      const yedek = yedekler.find((a) => a.kayit === tercih) ?? yedekler[0];
      if (yedek === undefined) return { tur: "yeni-yol", yedek: true };
      this.#sahipli.add(yedek.kayit);
      return { tur: "yaz", kayit: yedek.kayit };
    }
    // Buradan sonra `bosta.length <= kalanSatir + 1`. Metinli içerik yalnız
    // TAM denklikte yazar; metni ölçülemeyen içerik grup büyürken de yazar
    // (yeni yol açsaydı bir daha tanınamaz, dosya başı bir kayıt eklerdi).
    if (olcum.metin !== null && bosta.length !== kalanSatir + 1)
      return { tur: "yeni-yol", yedek: false };
    // Ezilebilir aday kalmadı: kaynak yerelde değişmiş. Yeni yol açılır; metni
    // ölçülemeyen içerikte o yol YEDEK sayılır, yoksa şişme birde durmaz.
    if (adaylar.length === 0) return { tur: "yeni-yol", yedek: olcum.metin === null };
    const tercihAday = adaylar.find((a) => a.kayit === tercih);
    let secim: AdayKayit | undefined;
    if (olcum.metin === null) {
      // Metni ölçülemeyen içerik, metni ölçülemeyen kaydı yeğler.
      secim =
        (tercihAday !== undefined && tercihAday.metin === null ? tercihAday : undefined) ??
        adaylar.find((a) => a.metin === null) ??
        tercihAday ??
        adaylar[0];
    } else {
      secim = tercihAday ?? adaylar[0];
    }
    if (secim === undefined) return { tur: "yeni-yol", yedek: false };
    this.#sahipli.add(secim.kayit);
    return { tur: "yaz", kayit: secim.kayit };
  }
}
