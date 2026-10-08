// Tanılama — "hangi kod çalışıyor, neyim eksik?" sorusunun sırsız cevabı.
//
// SIR SÖZLEŞMESİ (testle sabitlenir, test/tani.test.ts):
//   • RPC token'ı, çerez, Authorization başlığı ÇIKTIYA GİRMEZ.
//   • Opak dosya/evrak kimliği, caseKey, taraf adı, dava bilgisi GİRMEZ —
//     bu yüzden tanılama registry'yi veya manifest'i HİÇ AÇMAZ, yalnız
//     `davaSayisi` gibi sayıları değil, hiçbir dava alanını okumaz.
//   • Kalan her dize `redakteEt` süzgecinden geçer (son savunma hattı).
//
// AĞ SÖZLEŞMESİ: portala ya da herhangi bir uzak adrese İSTEK ATMAZ. Oturum
// nesnesine dokunmaz, `probeTaze()` çağırmaz; oturumsuz çalışır.
//
// YAZMA SÖZLEŞMESİ: hiçbir dosya oluşturmaz/değiştirmez. Arşiv yazılabilirliği
// `access(W_OK)` ile ÖLÇÜLÜR, deneme dosyası yazılarak değil.

import { accessSync, constants, existsSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { delimiter, join } from "node:path";
import { redakteEt } from "../core/log.js";
import {
  derlemeDurumu,
  gitKimligi,
  kaynakKoku,
  surumBilgisi,
  type DerlemeDurumu,
} from "../core/surum.js";
import { pdftotextBul } from "../convert/pdftext.js";
import { KILIT_DOSYA } from "./surec-kilidi.js";

export interface TaniSecenekler {
  /** Daemon'ın başlatıldığı sürüm dizesi (varsa). */
  motorSurum?: string;
  kok?: string;
  ayarDizin?: string;
  instanceId?: string;
  /** Test kancası: bu sürecin başlangıç anı (ms). Verilmezse process.uptime(). */
  surecBaslangicMs?: number;
}

export interface Tani {
  surum: {
    paket: string;
    motor: string | null;
    uyusuyorMu: boolean | null;
    kaynak: "package.json" | "bilinmiyor";
  };
  kaynak: {
    calisanKok: string;
    dal: string | null;
    commit: string | null;
    gitBicim: string | null;
    derleme: DerlemeDurumu;
    kurulanKomut: { yol: string; cozulmus: string; ayniKokMu: boolean } | null;
  };
  calisma: {
    node: string;
    platform: string;
    arch: string;
    pid: number;
    calismaSuresiSn: number;
    /** Bu sürecin başlangıç anı (ISO). Derleme bundan yeniyse kod bayattır. */
    baslangicAt: string;
    instanceId: string | null;
  };
  bagimlilik: {
    python3: { var: boolean; fcntl: boolean; not: string };
    pdftotext: { var: boolean; yol: string | null; not: string };
  };
  arsiv: { kok: string | null; var: boolean; yazilabilir: boolean };
  ayar: { dizin: string | null; kilitDosyasiVar: boolean; kontrolDosyasiVar: boolean };
  uyarilar: string[];
  not: string;
}

const PAYLASIM_NOTU =
  "Bu çıktı bilgisayarınızdaki klasör yollarını içerir; paylaşacağınız loglara olduğu gibi kopyalamayın.";

interface AracDurumu {
  python3: { var: boolean; fcntl: boolean; not: string };
  pdftotext: { var: boolean; yol: string | null; not: string };
}

const ARAC_TTL_MS = 30_000;
let aracBellek: { at: number; deger: AracDurumu } | undefined;

/** Yalnız test kancası: alt süreç önbelleğini boşaltır. */
export function taniBellegiBosalt(): void {
  aracBellek = undefined;
}

function python3Olc(): AracDurumu["python3"] {
  // Süreç kilidi python3 + fcntl ile kurulur (src/server/surec-kilidi.ts).
  // Burada yalnız "var mı" ölçülür; kilit ALINMAZ, dosya AÇILMAZ.
  try {
    const r = spawnSync("python3", ["-c", "import fcntl; print('ok')"], {
      timeout: 3000,
      encoding: "utf8",
    });
    if (r.error !== undefined || r.status === null) {
      return {
        var: false,
        fcntl: false,
        not: "python3 bulunamadı. macOS'ta Xcode komut satırı araçlarıyla gelir: xcode-select --install",
      };
    }
    const ok = r.status === 0 && (r.stdout ?? "").includes("ok");
    return {
      var: true,
      fcntl: ok,
      not: ok
        ? "Tek örnek kilidi için gerekli olan her şey yerinde."
        : "python3 var ama fcntl modülü çalışmadı; uygulama ikinci bir kopyanın açılmasını engelleyemeyebilir.",
    };
  } catch {
    return { var: false, fcntl: false, not: "python3 çalıştırılamadı." };
  }
}

function pdftotextOlc(): AracDurumu["pdftotext"] {
  // bellekle=false ZORUNLU: pdftotextBul bulunan yolu süreç ömrü boyunca
  // saklar. Tanılamanın sorusu "şu anda var mı" olduğu için bayat pozitif
  // cevap kabul edilemez (poppler kaldırıldıysa hâlâ "var" derdi).
  const yol = pdftotextBul(false);
  return {
    var: yol !== null,
    yol,
    not:
      yol !== null
        ? "PDF'lerin metni çıkarılabiliyor."
        : "PDF metin çıkarımı kapalı. Kurmak için: brew install poppler — kurduktan sonra ilgili dosyaları yeniden eşitleyin.",
  };
}

function araclar(): AracDurumu {
  const simdi = Date.now();
  if (aracBellek !== undefined && simdi - aracBellek.at < ARAC_TTL_MS) return aracBellek.deger;
  const deger: AracDurumu = { python3: python3Olc(), pdftotext: pdftotextOlc() };
  aracBellek = { at: simdi, deger };
  return deger;
}

function gercekYol(yol: string): string {
  try {
    return realpathSync(yol);
  } catch {
    return yol;
  }
}

/**
 * Kurulu `tensipd` komutunun hangi checkout'a bağlandığı.
 *
 * PATH taranır ve bulunan giriş `realpath` ile çözülür — `git` ya da başka bir
 * komut ÇALIŞTIRILMAZ, yalnız dosya sistemi okunur. Bu ölçümün amacı bu
 * makinede ölçülen symlink zincirini görünür kılmaktır:
 *   /opt/homebrew/bin/tensipd → lib/node_modules/tensip → geliştirme kökü
 * Yani "çift tıkladığımda hangi kod açılıyor" sorusu ekrandan yanıtlanabilir.
 */
function kurulanKomut(calisanKok: string): Tani["kaynak"]["kurulanKomut"] {
  const yollar = (process.env["PATH"] ?? "").split(delimiter).filter((y) => y !== "");
  for (const dizin of yollar) {
    const aday = join(dizin, "tensipd");
    let varMi = false;
    try {
      varMi = existsSync(aday);
    } catch {
      varMi = false;
    }
    if (!varMi) continue;
    const cozulmus = gercekYol(aday);
    const kokIle = calisanKok.endsWith("/") ? calisanKok : `${calisanKok}/`;
    return { yol: aday, cozulmus, ayniKokMu: cozulmus.startsWith(kokIle) };
  }
  return null;
}

function yazilabilirMi(kok: string): boolean {
  try {
    accessSync(kok, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function suz<T>(deger: T): T {
  if (typeof deger === "string") return redakteEt(deger) as unknown as T;
  if (Array.isArray(deger)) return deger.map((d) => suz(d)) as unknown as T;
  if (deger !== null && typeof deger === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(deger as Record<string, unknown>)) out[k] = suz(v);
    return out as unknown as T;
  }
  return deger;
}

/**
 * Tanılama nesnesi. Argüman almaz (daemon işleyicisi gövdeyi yok sayar):
 * yol/caseKey/dosya argümanı kabul eden bir tanılama, belge işleyicilerindeki
 * yol sınırlarının dışında yeni bir okuma kapısı açardı.
 */
export function taniTopla(sec: TaniSecenekler = {}): Tani {
  const kok = kaynakKoku();
  const calisanKok = gercekYol(kok).replace(/\/$/, "");
  // TAZE okuma (bellek atlanır): motorun kimliği (`sec.motorSurum`) süreç
  // başında sabitlenmiştir; kıyas ancak diskin O ANKİ hâliyle anlamlıdır.
  // Bellekli okusaydık aşağıdaki `motor !== paket` kıyası aynı anda okunmuş iki
  // değeri karşılaştırır ve uyuşmazlık ASLA görünmezdi.
  const paketBilgi = surumBilgisi(kok, { bellek: false });
  const paket = paketBilgi.surum;
  const motor = sec.motorSurum ?? null;
  const git = gitKimligi(kok);
  const arac = araclar();
  const arsivKok = sec.kok ?? null;
  const arsivVar = arsivKok !== null && existsSync(arsivKok);
  const ayarDizin = sec.ayarDizin ?? null;
  const derleme = derlemeDurumu(kok);

  const uyarilar: string[] = [];
  if (motor !== null && motor !== paket) {
    uyarilar.push(
      `Çalışan motor ${motor} diyor, paket dosyası ${paket} diyor. Motor yeniden başlatılana kadar eski sürüm çalışmaya devam eder.`,
    );
  }
  if (paketBilgi.kaynak === "bilinmiyor") {
    uyarilar.push("Paket sürümü okunamadı; sürüm bilgisi güvenilir değil.");
  }
  if (derleme.taze === false) {
    uyarilar.push(
      "Kaynak dosyalar son derlemeden yeni. Kaydettiğiniz değişiklik henüz çalışmıyor olabilir: npm run build çalıştırıp motoru yeniden başlatın.",
    );
  }
  // "derlendi" ile "ÇALIŞIYOR" ayrı sorulardır. derleme.taze yalnız birincisini
  // ölçer (kaynak ↔ dist). Motor derlemeden ÖNCE başladıysa dist güncel olsa
  // bile çalışan kod eskidir — bu paketin var olma sebebi olan durum tam budur.
  // Yalnız motorun KENDİ ölçümünde anlamlı: CLI süreci az önce başladığı için
  // orada her zaman "taze" çıkar ve kullanıcıya yanlış güven verir.
  const surecBaslangicMs = sec.surecBaslangicMs ?? Date.now() - process.uptime() * 1000;
  const baslangicAt = new Date(surecBaslangicMs).toISOString();
  if (
    sec.instanceId !== undefined &&
    derleme.derlemeEnYeni !== null &&
    Date.parse(derleme.derlemeEnYeni) > surecBaslangicMs
  ) {
    uyarilar.push(
      "Derleme çalışan motordan yeni: dist güncel ama bu süreç onu yüklemedi. Açık iş yokken motoru yeniden başlatın.",
    );
  }
  if (!arac.python3.fcntl) uyarilar.push(arac.python3.not);
  if (!arac.pdftotext.var) uyarilar.push(arac.pdftotext.not);
  if (arsivKok !== null && !arsivVar) {
    uyarilar.push("Arşiv klasörü bulunamadı. Disk bağlı değilse bağlayın; klasör taşındıysa ayarı düzeltin.");
  }
  if (arsivVar && !yazilabilirMi(arsivKok!)) {
    uyarilar.push("Arşiv klasörüne yazma izni yok; yeni indirmeler kaydedilemez.");
  }
  const komut = kurulanKomut(calisanKok);
  if (komut !== null && !komut.ayniKokMu) {
    uyarilar.push(
      "Kurulu tensipd komutu şu anda çalışan koddan BAŞKA bir klasöre bağlı. Uygulamayı kapatıp yeniden açarsanız o klasördeki kod çalışır.",
    );
  }

  const tani: Tani = {
    surum: {
      paket,
      motor,
      uyusuyorMu: motor === null ? null : motor === paket,
      kaynak: paketBilgi.kaynak,
    },
    kaynak: {
      calisanKok,
      dal: git?.dal ?? null,
      commit: git?.commit ?? null,
      gitBicim: git?.bicim ?? null,
      derleme,
      kurulanKomut: komut,
    },
    calisma: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      calismaSuresiSn: Math.round(process.uptime()),
      baslangicAt,
      instanceId: sec.instanceId ?? null,
    },
    bagimlilik: arac,
    arsiv: {
      kok: arsivKok,
      var: arsivVar,
      yazilabilir: arsivVar ? yazilabilirMi(arsivKok!) : false,
    },
    ayar: {
      dizin: ayarDizin,
      kilitDosyasiVar: ayarDizin !== null && existsSync(join(ayarDizin, KILIT_DOSYA)),
      kontrolDosyasiVar: ayarDizin !== null && existsSync(join(ayarDizin, "control.json")),
    },
    uyarilar,
    not: PAYLASIM_NOTU,
  };
  return suz(tani);
}
