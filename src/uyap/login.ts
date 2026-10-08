// Giriş akışları.
//
//  1) CDP: UYAP girişini KULLANICI yapar (Chrome, e-Devlet/mobil imza);
//     uygulama tarayıcıyı kendi izole profiliyle açar, çerezleri CDP'den
//     yakalar. DavaTek'in yaklaşımı (harici Chrome + localhost CDP).
//  2) Manuel: kullanıcı DevTools'tan document.cookie çıktısını yapıştırır
//     (uyap skill akışı) ya da bir dosyaya yazar.

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync, mkdtempSync, rmSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CdpIstemci } from "./cdp.js";
import { PORTAL_KOK } from "./endpoints.js";
import { Hata, KODLAR } from "../core/errors.js";

const TARAYICI_ADAYLARI = [
  process.env["TENSIP_TARAYICI"], // öncelik: kullanıcı yönlendirmesi
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Arc.app/Contents/MacOS/Arc",
].filter((p): p is string => typeof p === "string" && p.length > 0);

export function tarayiciBul(): string | null {
  for (const yol of TARAYICI_ADAYLARI) {
    if (existsSync(yol)) return yol;
  }
  return null;
}

function serbestPort(): Promise<number> {
  return new Promise((coz, red) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      if (a === null || typeof a === "string") {
        red(new Error("port alınamadı"));
        return;
      }
      const port = a.port;
      s.close(() => coz(port));
    });
    s.on("error", red);
  });
}

export interface CdpGirisSonucu {
  cookie: string;
  yontem: "cdp";
  sureMs: number;
}

export interface CdpGirisSecenek {
  /** ms — kullanıcı girişi için süre. Varsayılan 15 dk: akış insan temposunda
   *  ilerler (mobil imza + SMS); yedek kriter de girişten sonra ~3 dk sessizlik
   *  istediği için kısa tavan, yaşayan oturumu öldürebilir (5 Eyl'de öldürdü). */
  zamanAsimiMs?: number;
  /** Test kancası: yedek kriterin URL-dwell süresi (ms; varsayılan 5 sn). */
  yedekBeklemeMs?: number;
  /** Portala gidilecek adres (varsayılan portal kök) */
  girisUrl?: string;
  /** Yaşayan güncelleme (CLI'ye stderr NDJSON) */
  ilerle?: (olay: Record<string, unknown>) => void;
  /** Test için: tarayıcı başlatma taklidi */
  sunucuKur?: (port: number) => Promise<{ wsUrl: string; temizle: () => void }>;
  /**
   * Üst yönetici (daemon) açık kaynak kaydı: bekleyen girişi iptal edebilmek
   * için temizleyiciyi kaydeder, akış bitince kaydı silmek için fonksiyon
   * döner. Temizleyici ASYNC'tir ve SIRALI çalışır: çocuğun ölmesi beklenir
   * (SIGTERM → 3 sn → SIGKILL), SONRA profil dizini silinir — aksi hâlde
   * canlı tarayıcı silinen dizine yeniden dosya yazar.
   */
  kaynakKaydet?: (temizle: () => Promise<void>) => () => void;
  /** Test kancası: gerçek tarayıcı yerine çalıştırılacak komut
   *  (ör. SIGTERM'i yutan sahte tarayıcı). Verilmezse tarayiciBul() kullanılır. */
  tarayiciKomutu?: string;
}

/** tmp'de kalmış eski profil dizinlerini (sahibi ölmüş süreç) temizler.
 *  Yarım saat taze dizinlere dokunmaz — sürmekte olan başka girişe ait olabilir. */
function bayatProfilleriTemizle(): void {
  const esik = Date.now() - 30 * 60 * 1000;
  try {
    for (const ad of readdirSync(tmpdir())) {
      if (!ad.startsWith("tensip-profil-")) continue;
      const yol = join(tmpdir(), ad);
      try {
        if (statSync(yol).mtimeMs < esik) {
          rmSync(yol, { recursive: true, force: true });
        }
      } catch {
        /* tek dizin: yok say */
      }
    }
  } catch {
    /* tmp okunamadı: yok say */
  }
}

/** Profil silinmeden önce çocuğun gerçekten çıkmasını bekler. */
async function tarayiciKapat(cocuk: ChildProcess | null): Promise<void> {
  if (!cocuk?.pid || cocuk.exitCode !== null || cocuk.signalCode !== null) return;
  await new Promise<void>((coz) => {
    const zamanlayici = setTimeout(() => cocuk.kill("SIGKILL"), 3000);
    cocuk.once("exit", () => {
      clearTimeout(zamanlayici);
      coz();
    });
    cocuk.kill("SIGTERM");
  });
}

/** stderr bir TCP/veri paketi sınırında bölünebilir; satırı biriktirir. */
function devtoolsAdresi(cocuk: ChildProcess): Promise<string> {
  return new Promise((coz, red) => {
    let tampon = "";
    const temizle = (): void => {
      clearTimeout(zamanlayici);
      cocuk.stderr?.off("data", veriGeldi);
      cocuk.off("exit", kapandi);
      cocuk.off("error", hata);
    };
    const hata = (e: Error): void => { temizle(); red(e); };
    const kapandi = (): void => hata(new Error("tarayıcı DevTools açılmadan kapandı"));
    const veriGeldi = (d: Buffer): void => {
      tampon += d.toString();
      const m = /DevTools listening on (ws:\/\/[^\r\n ]+)[\r\n ]/.exec(tampon);
      if (m) { temizle(); coz(m[1]!); }
      // Günlükler sınırsız büyümesin; DevTools satırı küçük bir URL'dir.
      if (tampon.length > 64_000) tampon = tampon.slice(-32_000);
    };
    const zamanlayici = setTimeout(() => hata(new Error("DevTools uç noktası bulunamadı")), 15_000);
    cocuk.stderr?.on("data", veriGeldi);
    cocuk.once("exit", kapandi);
    cocuk.once("error", hata);
  });
}

/**
 * Chrome'u izole profille aç, kullanıcı girişini bekle, çerezleri yakala.
 * Tarayıcı kendimiz kapatırız — kullanıcının açık pencerelerine dokunmayız.
 * Profil dizini akışın sonunda (iptal dahil) silinir.
 */
export async function cdpGirisi(sec: CdpGirisSecenek = {}): Promise<CdpGirisSonucu> {
  bayatProfilleriTemizle();
  const baslangic = Date.now();
  const zamanAsimi = sec.zamanAsimiMs ?? 15 * 60 * 1000;
  const tarayici = sec.tarayiciKomutu ?? tarayiciBul();
  if (!tarayici) {
    throw new Hata(
      KODLAR.LOGIN_REQUIRED,
      "Chrome/Brave/Edge bulunamadı; manuel çerez girişi kullanın (`tensip giris --cerez \"document.cookie çıktısı\"`)"
    );
  }
  const port = await serbestPort();
  const profil = mkdtempSync(join(tmpdir(), "tensip-profil-"));
  let cocuk: ChildProcess | null = null;
  let cdp: CdpIstemci | undefined;
  let temizleyici: (() => void) | undefined;
  let kaydiSil: (() => void) | undefined;
  let iptalEdildi = false;
  let temizlik: Promise<void> | undefined;
  const tamTemizle = (): Promise<void> => {
    iptalEdildi = true;
    return temizlik ??= (async () => {
      try {
        cdp?.kapat();
        await tarayiciKapat(cocuk);
      } finally {
        try { rmSync(profil, { recursive: true, force: true }); }
        finally {
          try { await temizleyici?.(); }
          finally { kaydiSil?.(); }
        }
      }
    })();
  };

  try {
    sec.ilerle?.({ tip: "giris", asama: "tarayici-baslatiliyor", port });
    kaydiSil = sec.kaynakKaydet?.(tamTemizle);
    if (iptalEdildi) throw new Hata(KODLAR.LOGIN_REQUIRED, "giriş iptal edildi");
    let wsUrl: string;
    if (sec.sunucuKur) {
      const mock = await sec.sunucuKur(port);
      wsUrl = mock.wsUrl;
      temizleyici = mock.temizle;
      if (iptalEdildi) {
        await temizleyici();
        throw new Hata(KODLAR.LOGIN_REQUIRED, "giriş iptal edildi");
      }
    } else {
      cocuk = spawn(tarayici, [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profil}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-features=ChromeWhatsNew",
        sec.girisUrl ?? PORTAL_KOK,
      ], { stdio: ["ignore", "ignore", "pipe"] });
      wsUrl = await devtoolsAdresi(cocuk);
    }
    if (iptalEdildi) throw new Hata(KODLAR.LOGIN_REQUIRED, "giriş iptal edildi");
    cdp = new CdpIstemci(wsUrl);
    await cdp.ac();
    sec.ilerle?.({ tip: "giris", asama: "giris-bekleniyor", mesaj: "Açılan pencerede UYAP'a giriş yapın (e-Devlet/mobil imza)." });
    const son = await cerezBekle(cdp, zamanAsimi, sec.ilerle, () => iptalEdildi, sec.yedekBeklemeMs);
    return { cookie: son, yontem: "cdp", sureMs: Date.now() - baslangic };
  } catch (e) {
    if (iptalEdildi) throw new Hata(KODLAR.LOGIN_REQUIRED, "giriş iptal edildi");
    throw e;
  } finally {
    await tamTemizle();
  }
}

/**
 * GİRİŞ TAMAMLANMA TESPİTİ — portala İSTEK ATILMADAN (5 Eyl gerçek portal
 * gözlemi: giriş sürerken ara oturumla Node'dan atılan probe sunucudaki
 * giriş oturumunu bozuyor: avukat.uyap.gov.tr/login.uyap?code=… akışı
 * "nosessionobject" ile düşüyor). Tamamlanma, tarayıcının KENDİ trafiğinden
 * okunur: avukat.uyap.gov.tr üzerinde bir *.ajx yanıtının `uyapfc_rc`
 * başlığı SUCCESS ise tarayıcının oturumu çalışıyor demektir.
 */
function portalBasarisiMi(url: string, basliklar: Record<string, string>, durum: number): boolean {
  try {
    const u = new URL(url);
    if (u.hostname !== "avukat.uyap.gov.tr") return false;
    if (!u.pathname.endsWith(".ajx")) return false;
    if (durum !== 200) return false; // gerçek gözlem: 401'de bile rc=SUCCESS gelebiliyor
    const rc = Object.entries(basliklar).find(([k]) => k.toLowerCase() === "uyapfc_rc")?.[1];
    return rc === "SUCCESS";
  } catch {
    return false;
  }
}

/** Yedek kriterde "tamamlanmış sayılmaz" yolları: /giris ve /login.uyap* —
 *  giriş AKIŞININ sayfaları. DİKKAT: "/" dışlanmaz — gerçek portal gözlemi
 *  (5 Eyl): oturumlu SPA tam `avukat.uyap.gov.tr/` üstünde oturuyor; "/"
 *  dışlanınca yedek kriter ölü doğuyor (oturum yakalanamıyordu). Yanlış
 *  yakalama riski yok: yakalama yine JSESSIONID varlığına bağlı ve koşul
 *  her turda yeniden değerlendirilir. */
function yedekKriterdeDegil(yol: string): boolean {
  return yol === "/giris" || yol.startsWith("/login.uyap");
}

async function cerezBekle(
  cdp: CdpIstemci,
  zamanAsimiMs: number,
  ilerle?: (o: Record<string, unknown>) => void,
  iptalMi?: () => boolean,
  yedekBeklemeMs = 5_000
): Promise<string> {
  const bitis = Date.now() + zamanAsimiMs;
  let sonBildirim = 0;
  let basariliYanit = false;
  const agIzlemeyiKapat = await cdp.aglariIzle((y) => {
    if (!basariliYanit && portalBasarisiMi(y.url, y.basliklar, y.durum)) {
      basariliYanit = true;
      ilerle?.({ tip: "giris", asama: "portal-basarili-yanit", url: y.url });
    }
  });
  try {
    let yedekTetik = 0;
    for (;;) {
      if (iptalMi?.() === true) {
        throw new Hata(KODLAR.LOGIN_REQUIRED, "giriş iptal edildi (daemon kapanıyor)");
      }
      if (!cdp.acik) {
        throw new Hata(KODLAR.LOGIN_REQUIRED, "giriş tarayıcısı bağlantısı kapandı");
      }
      if (Date.now() > bitis) {
        throw new Hata(KODLAR.LOGIN_REQUIRED, `giriş zaman aşımı (${Math.round(zamanAsimiMs / 60000)} dk)`);
      }
      // Birincil: tarayıcının kendi ajx yanıtında uyapfc_rc=SUCCESS.
      // Yedek: sayfa URL'i avukat.uyap.gov.tr'de ve akış sayfası DIŞINDA
      // ("." dahil) yedekBeklemeMs boyunca DURUYORSA yakala. Ağ sessizliği
      // şartı KOYULMAZ: SPA'nın arka plan trafiği önşartı sürekli bozup
      // yedek kriteri açlıkta öldürüyordu (5 Eyl gecesi canlı hata:
      // kullanıcının tamamlanmış girişi yakalanamadı). Güvenceler: yakalama
      // yine JSESSIONID varlığına bağlı; /giris ve /login.uyap* dışlanır;
      // oturumsuz "/" zaten /giris'e yönlenir. Oturumlu SPA "/" üstündedir.
      let yakalayabilir = basariliYanit;
      if (!basariliYanit) {
        try {
          const hedefler = await cdp.sayfaHedefleri();
          const uygun = hedefler.some((h) => {
            if (h.tip !== "page") return false;
            try {
              const u = new URL(h.url);
              return u.hostname === "avukat.uyap.gov.tr" && !yedekKriterdeDegil(u.pathname);
            } catch {
              return false;
            }
          });
          if (uygun) {
            if (yedekTetik === 0) {
              yedekTetik = Date.now();
              ilerle?.({
                tip: "giris",
                asama: "yedek-kriter-bekleme",
                mesaj: "Portal sayfası açık görünüyor; çerez kısa süre içinde alınır",
              });
            } else if (Date.now() - yedekTetik >= yedekBeklemeMs) {
              yakalayabilir = true;
            }
          } else {
            yedekTetik = 0;
          }
        } catch {
          /* hedef listesi okunamadı — döngü sürer */
        }
      }
      if (yakalayabilir) {
        try {
          const cerezler = await cdp.tumCerezler();
          const uyap = cerezler.filter((c) => {
            const alan = c.domain.replace(/^\./, "").toLowerCase();
            return alan === "uyap.gov.tr" || alan === "avukat.uyap.gov.tr";
          });
          const jsess = uyap.find((c) => /JSESSIONID/i.test(c.name));
          if (jsess) {
            // e-Devlet çerezleri karışmasın: yalnız uyap.gov.tr çerezleri
            const cerezDizi = uyap.map((c) => `${c.name}=${c.value}`);
            ilerle?.({ tip: "giris", asama: "cerez-yakalandi", adet: cerezDizi.length });
            return cerezDizi.join("; ");
          }
          // SUCCESS geldi ama çerez henüz görünmüyor — kısa süre sonra tekrar
        } catch {
          /* çerezler okunamadı — döngü sürer */
        }
      }
      const simdi = Date.now();
      if (simdi - sonBildirim > 30_000) {
        sonBildirim = simdi;
        ilerle?.({ tip: "giris", asama: "bekliyor", kalanSn: Math.round((bitis - simdi) / 1000) });
      }
      await new Promise((c) => setTimeout(c, 2000));
    }
  } finally {
    agIzlemeyiKapat();
  }
}

/** Manuel çerez kabulü: JSESSIONID var mı denetlenip temizlenir. */
export function manuelCerezAyrıştır(hammadde: string): string {
  const metin = hammadde.trim();
  if (!/JSESSIONID/i.test(metin)) {
    throw new Hata(
      KODLAR.INVALID_INPUT,
      "girilen değer JSESSIONID içermiyor. DevTools → Console → document.cookie çıktısını yapıştırın."
    );
  }
  // JSON çıktı vs düz dize: parça parça normalleştir
  const parcalar = metin
    .split(";")
    .map((p) => p.trim())
    .filter((p) => /^[A-Za-z0-9_\-]+=.+/.test(p));
  if (parcalar.length === 0) {
    throw new Hata(KODLAR.INVALID_INPUT, "çerez biçimi çözülemedi");
  }
  return parcalar.join("; ");
}

/** Dosyadan çerez okuma (`tensip giris --cerez-dosya x.txt`). */
export function dosyadanCerezOku(dosya: string): string {
  const icerik = readFileSync(dosya, "utf8").trim();
  return manuelCerezAyrıştır(icerik);
}
