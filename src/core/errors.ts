// Hata kodları ve çıkış kodu tablosu.
//
// Sözleşme: ajan `if [ $? -eq 5 ]` ile
// dallanabilsin. Tablo TÜKENİŞLİ DEĞİLDİR — tanınmayan kod 1'e düşer;
// sunucu kodu asla yeniden yazmaz, sessizce yutulmaz.

export class Hata extends Error {
  code: string;
  details?: unknown;
  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = "Hata";
  }
}

// Çıkış kodu tablosu
export const KOD_TABLOSU: Record<string, number> = {
  INTERNAL: 1,
  INVALID_INPUT: 2,
  APP_GONE: 3,
  PORT_IN_USE: 7,
  QUOTA_EXCEEDED: 4,
  OTOMASYON_BUTCESI: 4,
  LOGIN_REQUIRED: 5,
  OTURUM_BITTI: 5,
  GIRIS_YAPILMADI: 5,
  BUSY: 6,
  IS_BUSY: 6,
  PATH_FORBIDDEN: 2,
  KAYNAK_ERISILEMEDI: 1,
  NOT_FOUND: 1,
};

export function cikisKodu(code: string): number {
  return KOD_TABLOSU[code] ?? 1;
}

// Sık kullanılan kodlar
export const KODLAR = {
  INTERNAL: "INTERNAL",
  INVALID_INPUT: "INVALID_INPUT",
  APP_GONE: "APP_GONE",
  PORT_IN_USE: "PORT_IN_USE",
  LOGIN_REQUIRED: "LOGIN_REQUIRED",
  OTURUM_BITTI: "OTURUM_BITTI",
  OTOMASYON_BUTCESI: "OTOMASYON_BUTCESI",
  IS_BUSY: "IS_BUSY",
  PATH_FORBIDDEN: "PATH_FORBIDDEN",
  // P15c — kayıtlı yol ÇÖZÜLEMEDİ (izin, bağlı olmayan disk, kırık symlink).
  // PATH_FORBIDDEN'dan ayrıdır: o "kök dışına çıkma" der, bu "okuyamadım" der;
  // ikisi de NOT_FOUND ("orada bir şey yok") DEĞİLDİR.
  KAYNAK_ERISILEMEDI: "KAYNAK_ERISILEMEDI",
  NOT_FOUND: "NOT_FOUND",
  PORTAL_YANIT_BILINMIYOR: "PORTAL_YANIT_BILINMIYOR",
  EVRAK_YUKLENMEMIS: "EVRAK_YUKLENMEMIS",
  DOWNLOAD_FAILED: "DOWNLOAD_FAILED",
  CONVERT_FAILED: "CONVERT_FAILED",
} as const;
