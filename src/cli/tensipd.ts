// `tensipd` — daemon girişi.
// Uzun ömürlü süreç: RPC sunucusu + oturum + iş orkestratörü.
// SIGTERM/SIGINT: RPC kapat → control.json sil → çıkış 0.

import { daemonKur, webPanosuBaslat, cerezDosyasindanOku } from "../server/daemon.js";
import { AppLog } from "../core/log.js";
import { Hata, cikisKodu } from "../core/errors.js";
import { argAyristir } from "./argumanlar.js";
import { ayarDizini } from "../server/daemon.js";
import { PORTAL_BASE } from "../uyap/endpoints.js";
import { varsayilanArsiv } from "../store/paths.js";
import { paketSurumu } from "../core/surum.js";
import { join } from "node:path";

const cik = (v: unknown) => process.stdout.write(`${JSON.stringify(v)}\n`);
const logYaz = (v: unknown) => process.stderr.write(`${JSON.stringify(v)}\n`);

// P10a — sürümün tek yazılı kaynağı package.json'dur; burada sabit TUTULMAZ.
// Ad korundu, değeri artık çalışma anında okunuyor.
const SUFFIX_APPVERSION = paketSurumu();

async function main(): Promise<number> {
  const [komut, ...kalan] = process.argv.slice(2);
  const arg = argAyristir(kalan);

  if (komut === undefined || komut === "yardim" || komut === "--yardim" || komut === "--help") {
    cik({
      komutlar: ["baslat", "durdur", "durum", "tani"],
      kullanım: {
        baslat: "tensipd baslat [--kok DIZIN] [--portal URL] [--ayar DIZIN] [--web PORT|false] [--istek-aralik MS] [--gunluk-tavan N]",
        durdur: "tensipd durdur [--ayar DIZIN]",
        durum: "tensipd durum [--ayar DIZIN] — çalışan motorun yerel durumu; portala istek atmaz",
        tani: "tensipd tani [--ayar DIZIN] — sürüm, çalışan kaynak, bağımlılık ve arşiv tanılaması; motor kapalıyken de çalışır",
      },
      cikisKodlari: "0 ok, 1 hata, 2 girdi, 3 daemon yok, 4 kota, 5 giriş, 6 meşgul, 7 port dolu",
    });
    return komut === undefined ? 2 : 0;
  }

  const ayarDir = typeof arg.bayrak["ayar"] === "string" ? arg.bayrak["ayar"] : undefined;

  // T04 — yardımda listelenen `durum` bugüne kadar işleyicisizdi ve
  // `bilinmeyen komut` verip çıkış 2 dönüyordu. `{yerel:true}` ZORUNLU:
  // tanılama amaçlı bir durum sorgusu portal oturumunu yoklamamalıdır
  // (src/server/daemon.ts `durum` işleyicisi bu bayrağı okur).
  if (komut === "durum") {
    try {
      const { istemciYap } = await import("./istemci.js");
      cik(await istemciYap(ayarDir).cagir("durum", { yerel: true }));
      return 0;
    } catch (e) {
      const hata = e as { code?: string; message?: string };
      logYaz({ hata: { code: hata.code ?? "APP_GONE", message: hata.message ?? String(e) } });
      return cikisKodu(hata.code ?? "APP_GONE");
    }
  }

  // `tani` motor kapalıyken de anlamlıdır ("hangi kod açılacak?" sorusu en çok
  // o zaman sorulur). Motora ulaşılırsa ÇALIŞAN sürecin ölçümü, ulaşılamazsa
  // bu CLI sürecinin ölçümü döner; hangisi olduğu `olcum` alanında yazar.
  if (komut === "tani") {
    try {
      const { istemciYap } = await import("./istemci.js");
      const t = (await istemciYap(ayarDir).cagir("tani", {})) as Record<string, unknown>;
      cik({ ...t, olcum: "motor" });
      return 0;
    } catch (e) {
      // Kör catch YANLIŞ cevap verir: APP_GONE gerçekten "motora ulaşılamadı"
      // demektir, ama NOT_FOUND "motor AYAKTA, yalnız `tani` ucunu tanımıyor"
      // (P10a öncesi bir motor) demektir. İkisini aynı kefeye koymak, bu
      // paketin var olma sebebi olan senaryoda — kurulu komut eski koda bağlı —
      // kullanıcıya "motor yok" dedirtir.
      const kod = (e as { code?: string }).code;
      const motorDurumu =
        kod === "APP_GONE" || kod === undefined
          ? "ulaşılamadı"
          : kod === "NOT_FOUND"
            ? "ulaşıldı, tani ucu desteklenmiyor (motor eski — yeniden başlatın)"
            : `ulaşıldı, tani çağrısı başarısız (${kod})`;
      const { taniTopla } = await import("../server/tani.js");
      // Arşiv kökü motordan gelir. Motor kapalıyken TAHMİN EDİLMEZ: varsayılan
      // konumu yoklamak "hangi kök ayarlı" sorusunu yanlış yanıtlayabilir
      // (kalıcı kök ayarı P10b'nindir). İsteyen `--kok` ile açıkça verir.
      const kokArgumani = typeof arg.bayrak["kok"] === "string" ? arg.bayrak["kok"] : undefined;
      const yerel = taniTopla({
        ayarDizin: ayarDizini(ayarDir),
        ...(kokArgumani !== undefined ? { kok: kokArgumani } : {}),
      });
      cik({ ...yerel, olcum: "yerel", motorDurumu });
      return 0;
    }
  }

  if (komut === "durdur") {
    const { kontrolOku } = await import("./istemci.js");
    try {
      const k = kontrolOku(ayarDir);
      const { istemciYap } = await import("./istemci.js");
      const sonuc = await istemciYap(ayarDir).cagir("durdur", { instanceId: k.instanceId });
      cik(sonuc);
      return 0;
    } catch (e) {
      const hata = e as { code?: string; message?: string };
      logYaz({ hata: { code: hata.code ?? "APP_GONE", message: hata.message ?? String(e) } });
      return cikisKodu(hata.code ?? "APP_GONE");
    }
  }

  if (komut !== "baslat") {
    logYaz({ hata: `bilinmeyen komut: ${komut}` });
    return 2;
  }

  const d = ayarDir !== undefined ? ayarDir : undefined;
  const etkiliAyar = ayarDizini(d);
  // MADDE: çift log — baslatici.sh stderr'i aynı dosyaya yönlendirir.
  // ayrintili (stderr yansıması) yalnız gerçek Terminal'de (TTY) açılır;
  // nohup/.app akışında AppLog dosyaya bir kez yazar, stderr yalnız
  // logYaz NDJSON'u ve çökme izlerini taşır.
  const ayrintili = process.stderr.isTTY === true;
  const appLog = new AppLog({ dosya: join(etkiliAyar, "tensip.log"), ayrintili });
  appLog.write("tensipd", `başlıyor v${SUFFIX_APPVERSION} ${process.platform}`);

  const portalUrl = typeof arg.bayrak["portal"] === "string" ? (arg.bayrak["portal"] as string) : PORTAL_BASE;
  const kokArg = typeof arg.bayrak["kok"] === "string" ? (arg.bayrak["kok"] as string) : undefined;
  const kokYolu = kokArg ?? varsayilanArsiv();
  const istekAralik = typeof arg.bayrak["istek-aralik"] === "string" ? Number(arg.bayrak["istek-aralik"]) : undefined;
  const gunlukTavan = typeof arg.bayrak["gunluk-tavan"] === "string" ? Number(arg.bayrak["gunluk-tavan"]) : undefined;

  let kapaniyor = false;
  let kapandi = false;
  let kapanmaCoz: (() => void) | undefined;
  const kapanmaBildir = () => {
    kapandi = true;
    kapanmaCoz?.();
  };

  const daemon = daemonKur({
    ayarDir,
    kok: kokYolu,
    portalUrl,
    appVersion: SUFFIX_APPVERSION,
    istekAralikMs: istekAralik,
    gunlukTavan,
    log: appLog,
    kapatildiginda: kapanmaBildir,
  });

  const kapan = (sinyal: string) => {
    if (kapaniyor) return;
    kapaniyor = true;
    logYaz({ tip: "kapaniyor", sinyal });
    void daemon
      .kapat()
      .catch(() => undefined)
      .then(() => {
        appLog.write("tensipd", "kapandı");
        kapanmaBildir();
        process.exit(0);
      });
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGTERM", () => kapan("SIGTERM"));
  process.on("SIGINT", () => kapan("SIGINT"));

  let b;
  try {
    // Kilit ve RPC, otomatik girişten önce alınır: eşzamanlı iki başlatma
    // portal oturumuna veya çerez deposuna dokunmadan tek örnekte birleşir.
    b = await daemon.rpc.baslat();
  } catch (e) {
    const kod = e instanceof Hata ? e.code : "INTERNAL";
    logYaz({ hata: { code: kod, message: e instanceof Error ? e.message : String(e) } });
    return cikisKodu(kod);
  }

  // web panosu RPC hazırlandıktan hemen sonra açılır; başlatıcı health
  // kontrolünü otomatik girişin süresinden bağımsız yapabilir.
  // `--web` çözümü AÇIKÇA yazılır. Eskiden burada `web === false` dalı vardı;
  // ölü koddu — argAyristir değersiz bayrak için yalnız `true` üretir, `false`
  // ASLA üretmez. `--web=false` sayı olmayan değere düşüyor, Number("false")
  // NaN oluyor ve web "kazara" kapanıyordu. Kapatma artık kasıtlıdır ve
  // tanınmayan değer sessizce web'i kapatmak yerine girdi hatası verir
  // (uygulama/baslatici.sh `--web=false` gönderiyor: davranış korunuyor).
  const KAPALI = new Set(["false", "0", "kapali", "hayir", "yok"]);
  const web = arg.bayrak["web"];
  let webPort = 4747;
  if (typeof web === "string" && web !== "") {
    if (KAPALI.has(web.trim().toLowerCase())) webPort = 0;
    else if (/^\d+$/.test(web.trim())) webPort = Number(web.trim());
    else {
      logYaz({
        hata: {
          code: "INVALID_INPUT",
          message: `--web değeri anlaşılmadı: ${web}. Port numarası ya da 'false' verin.`,
        },
      });
      await daemon.kapat().catch(() => undefined);
      return cikisKodu("INVALID_INPUT");
    }
  }
  if (webPort > 0) {
    try {
      const adres = await webPanosuBaslat(daemon, webPort, SUFFIX_APPVERSION, portalUrl, kokYolu);
      logYaz({ tip: "web", adres });
    } catch (e) {
      logYaz({ tip: "web-hatasi", hata: e instanceof Error ? e.message : String(e) });
      await daemon.kapat().catch(() => undefined);
      return cikisKodu("PORT_IN_USE");
    }
  }

  logYaz({ tip: "hazir", port: b.port, pid: b.pid });

  // başlatma sırasında çerez dosyası varsa otomatik gir — DOĞRULAMALI:
  // portal oturumu doğrulamazsa çerez depoya yazılmaz, giris_gerekiyor kalır
  const hamCerez = cerezDosyasindanOku(etkiliAyar);
  if (hamCerez !== null) {
    try {
      await daemon.isleyiciler.get("giris")!({ cerezDosya: join(etkiliAyar, "cerez.txt") });
      logYaz({ tip: "giris", yontem: "dosya" });
    } catch (e) {
      logYaz({ tip: "giris-hatasi", hata: e instanceof Error ? e.message : String(e) });
    }
  }

  // ana süreç çalışmaya devam etsin
  await new Promise<void>((resolve) => {
    if (kapandi) {
      resolve();
      return;
    }
    kapanmaCoz = resolve;
  });
  return 0;
}

const kod = await main();
process.exitCode = kod;
