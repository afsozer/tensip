// Yerel masaüstü UI. CLI yetkisi/çerezleri sayfaya aktarılmaz.
import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Daemon } from "./daemon.js";
import { Hata } from "../core/errors.js";
import { redakteEt } from "../core/log.js";
import {
  belgeIsleyicileri,
  varsayilanDosyaAc,
  type DosyaAc,
} from "./belgeler.js";
import { takvimIsleyicileri } from "./takvim.js";

export function hostGecerliMi(host: string | undefined, port: number): boolean {
  if (!host) return false;
  const m = /^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.\-]+)(?::(\d+))?$/.exec(host);
  if (!m || !["127.0.0.1", "localhost", "[::1]"].includes(m[1]!.toLowerCase()))
    return false;
  return m[2] === undefined || Number(m[2]) === port;
}
const IZINLI = new Set([
  "durum",
  "birimler",
  "davalar",
  "evraklar",
  "detay",
  "davalarim",
  "dosyalar-listele",
  "klonla",
  "esitle",
  "toplu-esitle",
  "toplu-devam",
  "toplu-duraklat",
  "toplu-iptal",
  "isler",
  "is",
  "duraklat",
  "devam",
  "iptal",
  "sorunlar",
  // P06a — yerel arşiv denetimi. Salt-okunur, oturumsuz, portala sıfır istek.
  // Bu satır düşerse "Denetle" düğmesi NOT_FOUND alır ve sekme boş kalır.
  "arsiv-denetle",
  // P19b — birikmiş şişkinliği sadeleştirme. Onaysız çağrıda yalnız PLAN
  // döner, tek bayt değişmez; uygulama `onay: true` ister. Bu satır düşerse
  // uygulama penceresinden gelen istek NOT_FOUND alır.
  "sadelestir",
  // P06b — seçili onarım (metin yeniden üretme / kaynağı yeniden indirme).
  // Onaysız çağrı yalnız YENİDEN ÖLÇÜLMÜŞ plan döner. Bu satır düşerse denetim
  // ekranındaki onarım düğmesi NOT_FOUND alır ve bulgu satırı çalışmaz görünür.
  "onar",
  // P07a — ajandadaki duruşmaları .ics olarak dışa aktarır. Portala SIFIR
  // istek atar, oturum aramaz; girdisi ekrandaki satırlardır. Bu satır
  // düşerse "Takvime aktar" düğmesi NOT_FOUND alır.
  "takvime-aktar",
  "giris",
  "giris-iptal",
  "cikis",
  "durusmalar",
  "safahat",
  "taraflar",
  // P18a — portal LİSTE satırının kendi dosyaId'siyle taraf sorgusu. Yukarıdaki
  // `taraflar` klonlanmış dava ister; listedeki dosyaların çoğu henüz
  // indirilmemiştir. Bu satır düşerse düğme NOT_FOUND alır.
  "liste-taraflar",
  "hesap",
  "evrak-oku",
  "evrak-ac",
  "klasor-ac",
  "hazirlik-ozet",
  // P10a — salt-okunur tanılama; argüman almaz (gövdesi aşağıda boşaltılır).
  "tani",
]);
const HTTP: Record<string, number> = {
  INVALID_INPUT: 400,
  LOGIN_REQUIRED: 401,
  OTURUM_BITTI: 401,
  HOST_FORBIDDEN: 403,
  CSRF: 403,
  PATH_FORBIDDEN: 403,
  // P15c — dosya var olabilir ama okunamadı (izin/bağlı olmayan disk). 404
  // DEĞİL: "yok" demek yanlış olurdu; PATH_FORBIDDEN ile aynı HTTP sınıfında
  // kalır, ayrımı taşıyan şey gövdedeki `code` alanıdır.
  KAYNAK_ERISILEMEDI: 403,
  NOT_FOUND: 404,
  IS_BUSY: 409,
  OTOMASYON_BUTCESI: 429,
};
const BASLIKLAR = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
};
function json(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, {
    ...BASLIKLAR,
    "content-type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(body));
}
async function govdeOku(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  let boyut = 0;
  const parcalar: Buffer[] = [];
  for await (const p of req) {
    boyut += p.length;
    if (boyut > 32_768) throw new Hata("INVALID_INPUT", "İstek çok büyük.");
    parcalar.push(p);
  }
  let v: unknown;
  try {
    v = JSON.parse(Buffer.concat(parcalar).toString("utf8"));
  } catch {
    throw new Hata("INVALID_INPUT", "Geçerli JSON gerekli.");
  }
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new Hata("INVALID_INPUT", "JSON nesnesi gerekli.");
  return v as Record<string, unknown>;
}
export function panoSunucu(
  daemon: Daemon,
  appVersion: string,
  portal: string,
  kok: string,
  sec: { dosyaAc?: DosyaAc } = {},
): Server {
  const anahtar = randomBytes(32).toString("hex");
  // Derlenmiş modül: dist/src/server/web.js → proje/web/. Kaynak değişikliği
  // yeni process açılmadan da asset'lerde görülebilir; veri dosyası bu kökte sunulmaz.
  const varliklar = new Map([
    ["/", ["index.html", "text/html; charset=utf-8"]],
    ["/app.css", ["app.css", "text/css; charset=utf-8"]],
    ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
    ["/ortak.js", ["ortak.js", "text/javascript; charset=utf-8"]],
    ["/arsiv.js", ["arsiv.js", "text/javascript; charset=utf-8"]],
    ["/evrak-durum.js", ["evrak-durum.js", "text/javascript; charset=utf-8"]],
    ["/isler.js", ["isler.js", "text/javascript; charset=utf-8"]],
    // P16 — sorun listesinin tek modülü. Bu satır düşerse sorun sekmesi boş
    // açılır ve tarayıcı konsolunda 404 görünür.
    ["/sorunlar.js", ["sorunlar.js", "text/javascript; charset=utf-8"]],
    // P06a — denetim sekmesinin tek modülü. Bu satır düşerse üçüncü sekme
    // modül 404'ü yüzünden boş açılır (P16'da bir kez yaşandı).
    ["/denetim.js", ["denetim.js", "text/javascript; charset=utf-8"]],
    ["/ajanda.js", ["ajanda.js", "text/javascript; charset=utf-8"]],
    ["/toplu.js", ["toplu.js", "text/javascript; charset=utf-8"]],
    ["/portal.js", ["portal.js", "text/javascript; charset=utf-8"]],
    // P18 — taraf gösterim sözlüğü; hem Dosyalar hem İndirilenler kullanır.
    // Bu satır düşerse iki ekran da modül 404'ü yüzünden boş açılır.
    ["/taraf.js", ["taraf.js", "text/javascript; charset=utf-8"]],
    // P07b — safahat/taraflar/hesap sekmelerinin çizimi. Bu satır düşerse üç
    // sekme de modül 404'ü yüzünden boş açılır (P16'da bir kez yaşandı).
    ["/detay.js", ["detay.js", "text/javascript; charset=utf-8"]],
  ]);
  const belgeler = belgeIsleyicileri(daemon, kok, sec.dosyaAc);
  // P07a — dışa aktarma AYAR dizinine yazar (arşive değil); dosyayı açan
  // kanca belge işleyicileriyle aynıdır, testte enjekte edilir.
  const takvim = takvimIsleyicileri(
    daemon.ayarDizin,
    sec.dosyaAc ?? varsayilanDosyaAc,
  );
  const sunucu = createServer((req, res) => {
    void ele(req, res).catch((e) => {
      if (res.headersSent || res.destroyed) return;
      const code = e instanceof Hata ? e.code : "INTERNAL";
      const message =
        e instanceof Error ? redakteEt(e.message) : "İşlem tamamlanamadı.";
      json(res, HTTP[code] ?? 500, { ok: false, error: { code, message } });
    });
  });
  sunucu.requestTimeout = 30_000;
  sunucu.headersTimeout = 15_000;
  async function ele(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const a = sunucu.address();
    const port = a && typeof a !== "string" ? a.port : 0;
    if (!hostGecerliMi(req.headers.host, port))
      throw new Hata("HOST_FORBIDDEN", "Yabancı adres reddedildi.");
    const yol = (req.url ?? "/").split("?")[0]!;
    const origin = req.headers.origin;
    const yabanci =
      (origin !== undefined && origin !== `http://${req.headers.host}`) ||
      req.headers["sec-fetch-site"] === "cross-site";
    if (yabanci)
      throw new Hata("CSRF", "İstek uygulama penceresinden gelmeli.");
    if (yol === "/health" && req.method === "GET") {
      json(res, 200, {
        ok: true,
        app: "tensip",
        appVersion,
        apiVersion: 1,
        instanceId: daemon.rpc.bilgiGetir()?.instanceId,
      });
      return;
    }
    const asset = varliklar.get(yol);
    if (asset && req.method === "GET") {
      const dosya = new URL(`../../../web/${asset[0]}`, import.meta.url);
      let metin = readFileSync(dosya, "utf8");
      if (yol === "/") metin = metin.replaceAll("__CSRF_TOKEN__", anahtar);
      res.writeHead(200, { ...BASLIKLAR, "content-type": asset[1]! });
      res.end(metin);
      return;
    }
    if (yol.startsWith("/api/")) {
      if (req.method !== "POST") {
        json(res, 405, {
          ok: false,
          error: { code: "INVALID_INPUT", message: "POST gerekli." },
        });
        return;
      }
      const gelen = req.headers["x-csrf-token"];
      if (
        typeof gelen !== "string" ||
        Buffer.byteLength(gelen) !== Buffer.byteLength(anahtar) ||
        !timingSafeEqual(Buffer.from(gelen), Buffer.from(anahtar))
      )
        throw new Hata(
          "CSRF",
          "Uygulama bağlantısı yenilendi; pencereyi yenileyin.",
        );
      if (
        req.headers["content-type"]?.split(";")[0]?.trim() !==
        "application/json"
      )
        throw new Hata("INVALID_INPUT", "JSON içerik türü gerekli.");
      const ad = yol.slice(5);
      if (!IZINLI.has(ad)) throw new Hata("NOT_FOUND", "İşlem bulunamadı.");
      let g = await govdeOku(req);
      if (ad === "durum") g = { yerel: true }; // UI polling kesinlikle probe atmaz
    if (ad === "tani") g = {}; // tanılamaya web'den yol/kimlik argümanı geçirilemez
      if (ad === "giris") g = { cdp: true }; // web'den çerez/dosya yolu kabul edilmez
      if (
        ad === "davalarim" &&
        (!/^\d{4}$/.test(String(g["yil"])) ||
          !/^\d{1,12}$/.test(String(g["sira"])))
      ) {
        throw new Hata(
          "INVALID_INPUT",
          "Dört haneli yıl ve dosya sıra numarası gerekli.",
        );
      }
      let islem = ad;
      if (ad === "klonla") {
        const kayit = daemon.registry
          .oku()
          .davalar.find(
            (d) => d.birimAdi === g["birim"] && d.dosyaNo === g["esas"],
          );
        if (kayit?.klonYolu) {
          islem = "esitle";
          g = { caseKey: kayit.caseKey };
        }
      }
      const h =
        belgeler.get(islem) ?? takvim.get(islem) ?? daemon.isleyiciler.get(islem);
      if (!h) throw new Hata("NOT_FOUND", "İşlem bulunamadı.");
      const data = await h(g);
      json(res, 200, { ok: true, data });
      return;
    }
    // Eski salt-okunur GET sözleşmesi (/durum, /davalar, /durusmalar, /isler,
    // /sorunlar) kaldırıldı: UI yalnız POST /api/* kullanıyordu, native
    // başlatıcı /health ve /rpc/durum kullanıyor. O yollar CSRF anahtarı
    // istemiyordu ve oturum varken /durum portala probe tetikleyebiliyordu.
    if (req.method !== "GET") {
      res.writeHead(405, BASLIKLAR);
      res.end();
      return;
    }
    json(res, 404, {
      ok: false,
      error: { code: "NOT_FOUND", message: "Sayfa bulunamadı." },
    });
  }
  return sunucu;
}
