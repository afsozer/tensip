// Uygulama günlüğü: NDJSON satırları, sırlar redakte edilerek yazılır.
// Hedef dosya yoksa / açılamazsa sessizce düşer (log asla işi bozmaz).

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Log'da asla görünmemesi gereken desenler → REDACTED
const REDAKTE_DESENLER: [RegExp, string][] = [
  // çerezler: JSESSIONID=..., ya da key=value çifti
  [/(JSESSIONID|JSESSIONIDSSO|SESSION|cookie|Cookie)\s*[=:]\s*[^\s"';,]+/gi, "$1=REDACTED"],
  [/(authorization|Authorization)\s*[=:]\s*Bearer\s+\S+/g, "$1: Bearer REDACTED"],
  [/(token|Token|TOKEN)\s*[=:]\s*["']?[A-Za-z0-9_\-+/=]{16,}["']?/g, "$1=REDACTED"],
  // opak UYAP token'ları (uzun base64 benzeri dizeler)
  [/["'][A-Za-z0-9@+]{60,}["']/g, '"REDACTED"'],
  // T.C. kimlik (11 hane)
  [/\b\d{11}\b/g, "REDACTED_TC"],
];

export function redakteEt(metin: string): string {
  let out = metin;
  for (const [re, rep] of REDAKTE_DESENLER) out = out.replace(re, rep);
  return out;
}

export interface LogSecenekler {
  dosya?: string;
  ayrintili?: boolean;
}

export class AppLog {
  private dosya?: string;
  private ayrintili: boolean;
  constructor(sec: LogSecenekler = {}) {
    this.dosya = sec.dosya;
    this.ayrintili = sec.ayrintili ?? false;
    if (this.dosya) {
      try {
        mkdirSync(dirname(this.dosya), { recursive: true });
      } catch {
        /* yok say */
      }
    }
  }
  write(kaynak: string, mesaj: string): void {
    const satir = `${new Date().toISOString()} [${kaynak}] ${redakteEt(mesaj)}\n`;
    if (this.dosya) {
      try {
        appendFileSync(this.dosya, satir);
      } catch {
        /* dosya yazılamadı: sessiz düş */
      }
    }
    if (this.ayrintili) process.stderr.write(satir);
  }
}

// RPC sunucusunun olay kanalına basılacak olay yapısı
export interface Olay {
  tip: string;
  veri?: unknown;
  at?: string;
}

// Abone tabanlı olay yayıcısı — daemon içi her modül olay basabilir
export class OlayYayici {
  private aboneler = new Set<(o: Olay) => void>();
  aboneOl(fn: (o: Olay) => void): () => void {
    this.aboneler.add(fn);
    return () => {
      this.aboneler.delete(fn);
    };
  }
  bas(tip: string, veri?: unknown): void {
    const o: Olay = { tip, veri, at: new Date().toISOString() };
    for (const fn of this.aboneler) {
      try {
        fn(o);
      } catch {
        /* abone hatası işi bozmasın */
      }
    }
  }
}
