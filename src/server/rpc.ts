// Yerel RPC sunucusu — ajan-öncelikli kontrol düzlemi.
// Protokol:
//  • control.json: {version:1, port, token, instanceId, pid, appVersion}
//    dizin 0700, dosya 0600, atomik yazım.
//  • POST /rpc/<ad> + Authorization: Bearer <token>
//  • GET /olaylar → NDJSON olay akışı
//  • GET /is/<isId>/izle → NDJSON iş akışı (nabız + durum)
//  • GET /semasi → komut şeması
//  • Yanıt: {ok:true,data} | {ok:false,error:{code,message}}

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { yazJsonAtomik, randHex, temizle } from "../store/fsops.js";
import { OlayYayici, redakteEt, type Olay } from "../core/log.js";
import { Hata, cikisKodu } from "../core/errors.js";
import { SurecKilidi } from "./surec-kilidi.js";

export const CONTROL_DOSYA = "control.json";

export interface KontrolBilgi {
  version: 1;
  port: number;
  token: string;
  instanceId: string;
  pid: number;
  appVersion: string;
}

export type RpcIsleyici = (govde: Record<string, unknown>) => Promise<unknown>;

export interface RpcSecenek {
  olaylar: OlayYayici;
  isleyiciler: Map<string, RpcIsleyici>;
  appVersion: string;
  /** control.json dizini */
  dizin: string;
  zamanAsimiMs?: number;
  /** Kullanıcı CLI'sinin yetkili kapatma isteği. */
  durdurOnay?: (govde: Record<string, unknown>) => Promise<unknown>;
  /** Yanıt tamamen gönderildikten sonra daemon kapanışı. */
  durdurSonrasi?: () => void;
  /** Kilit yardımcı süreci beklenmedik ölürse tüm daemon kapanışı. */
  kilitKaybi?: () => void;
  /** RPC kilidi ve control kaydı hazır olduktan sonra uygulama depolarını yükler. */
  baslatildi?: () => Promise<void> | void;
  /** NDJSON akışında istemci başına tampon tavanı (bayt; varsayılan 1 MiB). */
  akisTamponTavani?: number;
}

/** Yavaş okuyan istemci daemon belleğini şişirmesin: bu tavanı aşan akış
 *  kapatılır. İstemci yeniden bağlanabilir; `bekle.ts` kopan akıştan sonra
 *  son durumu RPC ile uzlaştırır. */
const AKIS_TAMPON_TAVANI = 1024 * 1024;

const HTTP_DURUM: Record<string, number> = {
  INVALID_INPUT: 400,
  METHOD_NOT_ALLOWED: 405,
  LOGIN_REQUIRED: 401,
  OTURUM_BITTI: 401,
  NOT_FOUND: 404,
  IS_BUSY: 409,
  OTOMASYON_BUTCESI: 429,
  APP_GONE: 503,
};

export class RpcSunucu {
  private sec: RpcSecenek;
  private sunucu?: Server;
  private bilgi?: KontrolBilgi;
  private akislar = new Set<ServerResponse>();
  private kilit?: SurecKilidi;

  constructor(sec: RpcSecenek) {
    this.sec = sec;
  }

  bilgiGetir(): KontrolBilgi | undefined {
    return this.bilgi;
  }

  async baslat(): Promise<KontrolBilgi> {
    const instanceId = randomBytes(16).toString("base64url");
    const token = randomBytes(32).toString("base64url");
    const kilit = new SurecKilidi(this.sec.dizin, instanceId);
    mkdirSync(this.sec.dizin, { recursive: true, mode: 0o700 });
    await kilit.edin();
    try {
      const mevcut = controlOku(this.sec.dizin);
      if (mevcut !== null && await daemonKimligiCanliMi(mevcut)) {
        throw new Hata("IS_BUSY", `tensipd zaten çalışıyor (port ${mevcut.port}); önce onu durdurun: tensipd durdur`);
      }
      this.kilit = kilit;
      kilit.kayipta(() => {
        if (this.sec.kilitKaybi !== undefined) this.sec.kilitKaybi();
        else void this.durdur();
      });
    } catch (e) {
      await kilit.birak();
      this.kilit = undefined;
      throw e;
    }
    return new Promise((coz, red) => {
      const s = createServer((req, res) => {
        void this.ele(req, res).catch(() => {
          yaz(res, 500, hataGovde("INTERNAL", "beklenmeyen hata"));
        });
      });
      s.requestTimeout = 120_000;
      s.headersTimeout = 30_000;
      s.keepAliveTimeout = 65_000;
      s.once("error", (e) => {
        void Promise.resolve(this.kilit?.birak()).finally(() => {
          this.kilit = undefined;
          red(e);
        });
      });
      s.listen(0, "127.0.0.1", () => {
        const a = s.address();
        if (a === null || typeof a === "string") {
          red(new Error("port alınamadı"));
          return;
        }
        this.sunucu = s;
        this.bilgi = {
          version: 1,
          port: a.port,
          token,
          instanceId,
          pid: process.pid,
          appVersion: this.sec.appVersion,
        };
        // control.json — dizin 0700, dosya 0600, atomik
        try {
          mkdirSync(this.sec.dizin, { recursive: true, mode: 0o700 });
          chmodSync(this.sec.dizin, 0o700);
        } catch {
          /* */
        }
        try {
          yazJsonAtomik(join(this.sec.dizin, CONTROL_DOSYA), this.bilgi);
        } catch (e) {
          this.bilgi = undefined;
          this.sunucu = undefined;
          void Promise.resolve(this.kilit?.birak()).finally(() => {
            this.kilit = undefined;
            s.close();
            red(e);
          });
          return;
        }
        void Promise.resolve().then(() => this.sec.baslatildi?.()).then(() => {
          coz(this.bilgi!);
        }).catch((e) => {
          const kapat = () => {
            const bilgi = this.bilgi;
            if (bilgi !== undefined) {
              const okunan = controlOku(this.sec.dizin);
              if (okunan?.instanceId === bilgi.instanceId) temizle(join(this.sec.dizin, CONTROL_DOSYA));
            }
            this.bilgi = undefined;
            this.sunucu = undefined;
            s.close(() => undefined);
          };
          kapat();
          void Promise.resolve(this.kilit?.birak()).finally(() => {
            this.kilit = undefined;
            red(e);
          });
        });
      });
    });
  }

  async durdur(): Promise<void> {
    const s = this.sunucu;
    this.sunucu = undefined;
    for (const a of this.akislar) a.end();
    this.akislar.clear();
    if (this.bilgi) {
      const okunan = controlOku(this.sec.dizin);
      if (okunan && okunan.instanceId === this.bilgi.instanceId) {
        temizle(join(this.sec.dizin, CONTROL_DOSYA));
      }
    }
    this.bilgi = undefined;
    if (!s) {
      await this.kilit?.birak();
      this.kilit = undefined;
      return Promise.resolve();
    }
    return new Promise<void>((coz) => {
      s.close(() => coz());
      s.closeAllConnections();
    }).finally(async () => {
      await this.kilit?.birak();
      this.kilit = undefined;
    });
  }

  private async ele(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const yol = (req.url ?? "").split("?")[0]!;
    // auth
    const auth = req.headers["authorization"] ?? "";
    const bekl = `Bearer ${this.bilgi?.token ?? ""}`;
    // Başlıklar latin1 çözülür: 0x80-0xFF baytı tek KARAKTER ama iki BAYT
    // olur. Karakter uzunluğu kıyaslanırsa timingSafeEqual RangeError atar ve
    // geçersiz token 401 yerine 500 döner. Bayt uzunluğu kıyaslanır (web.ts
    // ile aynı kural).
    const gecerli =
      this.bilgi !== undefined &&
      Buffer.byteLength(auth) === Buffer.byteLength(bekl) &&
      timingSafeEqual(Buffer.from(auth), Buffer.from(bekl));
    if (!gecerli) {
      yaz(res, 401, hataGovde("LOGIN_REQUIRED", "token geçersiz"));
      return;
    }
    if (yol === "/olaylar" && req.method === "GET") {
      this.akisAc(req, res, undefined);
      return;
    }
    const izleEsles = /^\/is\/([^/]+)\/izle$/.exec(yol);
    if (izleEsles && req.method === "GET") {
      this.akisAc(req, res, decodeURIComponent(izleEsles[1]!));
      return;
    }
    if (yol === "/semasi" && req.method === "GET") {
      const sema: Record<string, unknown> = {};
      for (const [ad, fn] of this.sec.isleyiciler) {
        void fn;
        sema[ad] = { govde: "JSON" };
      }
      yaz(res, 200, sema);
      return;
    }
    if (req.method !== "POST" || !yol.startsWith("/rpc/")) {
      yaz(res, 404, hataGovde("METHOD_NOT_ALLOWED", "bu uç tanımlı değil"));
      return;
    }
    const ct = req.headers["content-type"] ?? "";
    if (!ct.includes("application/json")) {
      yaz(res, 415, hataGovde("INVALID_INPUT", "application/json bekleniyor"));
      return;
    }
    let govde: Record<string, unknown> = {};
    try {
      govde = await govdeOku(req);
    } catch (e) {
      const mesaj = e instanceof Error ? e.message : String(e);
      yaz(res, 400, hataGovde("INVALID_INPUT", mesaj));
      return;
    }
    const ad = decodeURIComponent(yol.slice("/rpc/".length));
    if (ad === "kimlik") {
      if (req.method !== "POST") {
        yaz(res, 405, hataGovde("METHOD_NOT_ALLOWED", "POST gerekli"));
        return;
      }
      yaz(res, 200, { ok: true, data: { instanceId: this.bilgi!.instanceId, pid: this.bilgi!.pid } });
      return;
    }
    if (ad === "durdur" && this.sec.durdurOnay !== undefined) {
      try {
        const veri = await this.sec.durdurOnay(govde);
        res.once("finish", () => this.sec.durdurSonrasi?.());
        yaz(res, 200, { ok: true, data: veri });
      } catch (e) {
        const kod = e instanceof Hata ? e.code : "INTERNAL";
        const mesaj = e instanceof Error ? redakteEt(e.message) : "beklenmeyen hata";
        yaz(res, HTTP_DURUM[kod] ?? 200, { ok: false, error: { code: kod, message: mesaj } });
      }
      return;
    }
    const isleyici = this.sec.isleyiciler.get(ad);
    if (!isleyici) {
      yaz(res, 404, hataGovde("NOT_FOUND", `bilinmeyen rpc: ${ad}`));
      return;
    }
    try {
      const veri = await isleyici(govde);
      yaz(res, 200, { ok: true, data: veri });
    } catch (e) {
      const kod = e instanceof Hata ? e.code : "INTERNAL";
      const mesaj = e instanceof Error ? redakteEt(e.message) : "beklenmeyen hata";
      yaz(res, HTTP_DURUM[kod] ?? 200, { ok: false, error: { code: kod, message: mesaj } });
    }
  }

  private akisAc(req: IncomingMessage, res: ServerResponse, isIdFiltre?: string): void {
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true);
    res.writeHead(200, {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache",
    });
    this.akislar.add(res);
    const tavan = this.sec.akisTamponTavani ?? AKIS_TAMPON_TAVANI;
    let cik: (() => void) | undefined;
    let nabizT: ReturnType<typeof setInterval> | undefined;
    let kapandi = false;
    const kapat = (): void => {
      if (kapandi) return;
      kapandi = true;
      if (nabizT !== undefined) clearInterval(nabizT);
      cik?.();
      this.akislar.delete(res);
      res.end();
    };
    /** Tampon tavanı aşılırsa olayı sessizce düşürmek yerine akış kapatılır:
     *  eksik olay akışı, kopmuş akıştan daha yanıltıcıdır. */
    const gonder = (veri: unknown): void => {
      if (kapandi) return;
      if (res.writableLength > tavan) {
        kapat();
        return;
      }
      try {
        res.write(`${JSON.stringify(veri)}\n`);
      } catch {
        kapat();
      }
    };
    gonder({ tip: "nabiz", at: new Date().toISOString() });
    const abone = (o: Olay) => {
      if (isIdFiltre !== undefined) {
        const veri = o.veri as Record<string, unknown> | undefined;
        if (veri?.isId !== isIdFiltre) return;
      }
      gonder(o);
    };
    cik = this.sec.olaylar.aboneOl(abone);
    if (kapandi) {
      cik();
      return;
    }
    nabizT = setInterval(() => gonder({ tip: "nabiz", at: new Date().toISOString() }), 15_000);
    req.on("close", kapat);
  }
}

function controlOku(dizin: string): KontrolBilgi | null {
  try {
    const ham = JSON.parse(readFileSync(join(dizin, CONTROL_DOSYA), "utf8"));
    if (
      ham &&
      ham.version === 1 &&
      typeof ham.token === "string" &&
      ham.token.length > 0 &&
      typeof ham.instanceId === "string" &&
      ham.instanceId.length > 0 &&
      Number.isInteger(ham.port) &&
      ham.port >= 1 &&
      ham.port <= 65535 &&
      Number.isInteger(ham.pid) &&
      ham.pid >= 1
    ) return ham as KontrolBilgi;
  } catch {
    /* yok */
  }
  return null;
}

async function daemonKimligiCanliMi(k: KontrolBilgi): Promise<boolean> {
  try {
    const yanit = await fetch(`http://127.0.0.1:${k.port}/rpc/kimlik`, {
      method: "POST",
      headers: { authorization: `Bearer ${k.token}`, "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(500),
    });
    if (yanit.status === 200) {
      const g = (await yanit.json()) as { ok?: boolean; data?: { instanceId?: unknown } };
      return g.ok === true && g.data?.instanceId === k.instanceId;
    }
    if (yanit.status !== 404) return false;
    // Legacy daemon: kimlik ucu yok, /semasi auth ile canlılığını kanıtlar.
    const eski = await fetch(`http://127.0.0.1:${k.port}/semasi`, {
      headers: { authorization: `Bearer ${k.token}` },
      signal: AbortSignal.timeout(500),
    });
    return eski.status === 200;
  } catch {
    return false;
  }
}

function govdeOku(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((coz, red) => {
    const parcalar: Buffer[] = [];
    let boyut = 0;
    req.on("data", (c: Buffer) => {
      boyut += c.length;
      if (boyut > 5 * 1024 * 1024) {
        red(new Error("gövde çok büyük"));
        req.destroy();
        return;
      }
      parcalar.push(c);
    });
    req.on("end", () => {
      const metin = Buffer.concat(parcalar).toString("utf8");
      if (metin.trim() === "") {
        coz({});
        return;
      }
      try {
        const v = JSON.parse(metin);
        if (v === null || typeof v !== "object" || Array.isArray(v)) {
          red(new Error("gövde JSON nesnesi değil"));
          return;
        }
        coz(v as Record<string, unknown>);
      } catch {
        red(new Error("gövde JSON değil"));
      }
    });
  });
}

function yaz(res: ServerResponse, durum: number, govde: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(durum, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(govde));
}

function hataGovde(code: string, message: string): unknown {
  return { ok: false, error: { code, message } };
}

export { cikisKodu, randHex };
