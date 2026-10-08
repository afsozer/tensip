// Doğrulanmış UYAP Avukat Portalı uç yüzü.
//
// KAYNAK: `tensip` skill (kullanıcı tarafından gerçek portala karşı
// doğrulanmıştır). Uydurma uç YOK; yeni uç eklenmeden önce gerçek
// portala karşı doğrulanmalıdır.

export const PORTAL_BASE = "https://avukat.uyap.gov.tr";

/** Portal kök adresi — SPA deep-link 404 verdiği için her zaman kökten girilir. */
export const PORTAL_KOK = PORTAL_BASE + "/";

export interface UcTanım {
  ad: string;
  yol: string;
  yontem: "POST" | "GET";
  aciklama: string;
}

export const UCLAR = {
  /** Mahkeme türleri (yargi turu → tablo kodu). */
  yargiTurleri: {
    ad: "yargiTurleri",
    yol: "/yargiBirimleriSorgula_brd.ajx",
    yontem: "POST",
    aciklama: "{yargiTuru:'0'|'1'|'2'} → mahkeme türleri (tablo kodu)",
  },
  /** Bir yargi türündeki mahkemeler: birimAdi + birimId. */
  mahkemeler: {
    ad: "mahkemeler",
    yol: "/avukat_mahkemeleri_sorgula.ajx",
    yontem: "POST",
    aciklama: "{yargiBirimi:'<tablo>'} → [{birimAdi, birimId}]",
  },
  /** Dosya arama: iç içe dizi döner [[{dosyaId,...}]]. */
  dosyaAra: {
    ad: "dosyaAra",
    yol: "/search_phrase_detayli.ajx",
    yontem: "POST",
    aciklama:
      "{dosyaDurumKod,pageSize,pageNumber,dosyaYil,dosyaSira,birimId,birimTuru2,birimTuru3} → [[{dosyaId,...}]]",
  },
  /** Dosyanın evrakları (sayfalı). */
  evrakListele: {
    ad: "evrakListele",
    yol: "/list_dosya_evraklar.ajx",
    yontem: "POST",
    aciklama: "{dosyaId,pageNumber} → {tumEvraklar,son20Evrak,pageTotal}",
  },
  /** Belge baytları. evrakId/dosyaId opak token (tırnaklar içinde). */
  belge: {
    ad: "belge",
    yol: "/view_document_brd.uyap",
    yontem: "GET",
    aciklama: "?evrakId=<opak>&dosyaId=<opak> → baytlar",
  },
  /**
   * Duruşma/keşif takvimi. Sözleşme 5 Eyl 2026'da GERÇEK portalden
   * doğrulandı: SPA paketindeki çağrı (bugün → +7 gün penceresi) + tek
   * canlı doğrulama (200 + uyapfc_rc:SUCCESS). Tarih biçimi dd.MM.yyyy
   * (SPA dateFormat varsayılanı). Yanıt DÜZ DİZİ — sarmalayıcı yok.
   */
  durusmaSorgula: {
    ad: "durusmaSorgula",
    yol: "/avukat_durusma_sorgula_brd.ajx",
    yontem: "POST",
    aciklama:
      "{baslangicTarihi:'dd.MM.yyyy',bitisTarihi:'dd.MM.yyyy'} → [{kayitId,dosyaId,dosyaNo,birimId,yerelBirimAd,tarihSaat,islemTuru,islemTuruAciklama,islemSonucuAciklama,dosyaTaraflari[...]}]",
  },
  /**
   * Aşağıdaki üçü 5 Eyl'de CANLI DOĞRULANDI (2026/924 icra dosyasıyla):
   * hepsi {dosyaId} gövdesiyle POST. DİKKAT: opak tokenlar OTURUMA BAĞLI —
   * eski oturumun tokenı PRTL_GNL_10001-4 "Doğrulama hatası" verir; her
   * kullanımda taze aramayla yenile (daemon klonluDosyaId köprüsü).
   * Safahat üstelik UYAP'IN KENDİ hız sınırıyla gelir: "Bu işlem 60
   * dakikada 1 defa" (PRTL_GNL_1-1) — dosya başına önbellek zorunlu.
   */
  dosyaSafahat: {
    ad: "dosyaSafahat",
    yol: "/dosya_safahat_bilgileri_brd.ajx",
    yontem: "POST",
    aciklama: "{dosyaId} → {safahatlar:[{safahatTarihiSTR,safahatTuruAciklama,aciklama,safahatStatuKodAciklama,islemYapanBirim,...}]} — 60 dk/1 rate limitli",
  },
  dosyaTaraf: {
    ad: "dosyaTaraf",
    yol: "/dosya_taraf_bilgileri_brd.ajx",
    yontem: "POST",
    aciklama: "{dosyaId} → satırlar ({adi,rol,vekil,kisiKurum,...})",
  },
  dosyaHesap: {
    ad: "dosyaHesap",
    yol: "/dosya_hesap_bilgileri.ajx",
    yontem: "POST",
    aciklama: "{dosyaId} → satırlar ({textAlan,degerAlan,grupId,...})",
  },
} as const;

/** Sessiz bozulma tespiti: sistemde yüklenmemiş evrak işareti. */
export const EVRAK_YUKLENMEMIS_MESAJI = "Evrak UYAP sistemine yüklenmemiş.";

/** Portal oturumun bittiğini gösteren uç başlık değeri örnekleri. */
export const OTURUM_BITTIR = new Set([
  "PRTL_GNL_10000-2",
  "PRTL_GNL_10002",
]);

/** Yargi türleri — UYAP tablo kodları */
export const YARGI_TURLERI = {
  HUKUK: "0",
  CEZA: "1",
  IDARI: "2",
} as const;

/** Evrak yön kodları (uyap) — tip alanında görülür. */
export const EVRAK_TIP = {
  GLN: "GLN", // gelen
  GDN: "GDN", // giden
} as const;
