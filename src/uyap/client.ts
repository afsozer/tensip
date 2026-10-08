// UYAP JSON istemcisi.
//
// Sözleşme (uyap skill'den doğrulanmış):
//  • Kimlik: oturum çerezi (JSESSIONID …) tam dizisi.
//  • Uçlar hatayı HTTP 200 ile döner; gerçek durum `uyapfc_rc` yanıt
//    başlığındadır (SUCCESS / PRTL_GNL_10000-2 …).
//  • Sessiz bozulma: yüklenmemiş evrak HTTP 200 + text/plain +
//    "Evrak UYAP sistemine yüklenmemiş." döner — ayıklanır.
//  • Belge uçlarına tırnaklı opak token'lar encodeURIComponent ile konur.

import { OTURUM_BITTIR, UCLAR } from "./endpoints.js";
import { Hata, KODLAR } from "../core/errors.js";
import { Fren } from "../core/fren.js";

export interface IstemciSecenekler {
  /** Portal kök adresi; testlerde mock sunucuya işaret eder. */
  baseUrl: string;
  /** Oturum çerezi — "JSESSIONID=abc; …" tam dizisi. */
  cookie: () => string;
  /** İstek öncesi fren (asgari aralık). */
  fren?: Fren;
  istekIzin?: () => void;
  zamanAsimiMs?: number;
  /** Yanıt gövdesi bellek tavanı (bayt); varsayılan {@link YANIT_TAVANI}. */
  yanitTavaniBayt?: number;
  /** Yerel log hedefi (isteğe bağlı) */
  logla?: (mesaj: string) => void;
}

/** Yanıt gövdesi belleğe alınır; tek sınır zaman aşımı olursa bozuk ya da
 *  bitmeyen bir portal yanıtı motoru şişirebilir. Tavan gerçek evrakı
 *  (taranmış PDF/TIFF dâhil) rahatça geçecek kadar yüksektir. */
export const YANIT_TAVANI = 128 * 1024 * 1024;

export interface PortalYanit {
  durum: number;
  basliklar: Record<string, string>;
  govde: string;
  /** uyapfc_rc başlık değeri (varsa) */
  rc?: string;
}

const BILINEN_BASLIKLAR = ["uyapfc_rc", "content-type", "content-disposition", "content-length"];

export class UyapIstemci {
  private sec: IstemciSecenekler;
  private fren?: Fren;

  constructor(sec: IstemciSecenekler) {
    this.sec = sec;
    this.fren = sec.fren;
  }

  /** İsteği frenin tek sırasından geçirir; iptal denetimi sıra geldiğinde ve yanıt dönünce yapılır. */
  private async sirali<T>(is: () => Promise<T>): Promise<T> {
    const kosu = async () => { this.sec.istekIzin?.(); return is(); };
    const yanit = await (this.fren ? this.fren.istek(kosu) : kosu());
    this.sec.istekIzin?.();
    return yanit;
  }

  /** POST JSON gövde + JSON yanıtı beklenen uç çağrısı. */
  async json(yol: string, govde: unknown): Promise<PortalYanit> {
    return this.talep(yol, { yontem: "POST", govde: JSON.stringify(govde) });
  }

  /** GET — belge baytları için; yanıt baytlarıyla. */
  async baytlar(
    evrakId: string,
    dosyaId: string
  ): Promise<{ durum: number; basliklar: Record<string, string>; baytlar: Buffer; rc?: string }> {
    const qs = `evrakId=${encodeURIComponent(evrakId)}&dosyaId=${encodeURIComponent(dosyaId)}`;
    const yanit = await this.sirali(() => hamIstek(
      this.sec.baseUrl + UCLAR.belge.yol + "?" + qs,
      {
        yontem: "GET",
        cookie: this.sec.cookie(),
        zamanAsimiMs: this.sec.zamanAsimiMs ?? 120_000,
        ...(this.sec.yanitTavaniBayt !== undefined ? { enBuyukBaytlar: this.sec.yanitTavaniBayt } : {}),
      }
    ));
    const rc = yanit.basliklar["uyapfc_rc"];
    if (OTURUM_BITTIR.has(rc ?? "") || yanit.durum === 401 || yanit.durum === 302) {
      throw new Hata(KODLAR.OTURUM_BITTI, "belge isteğinde oturum sona erdi");
    }
    if (yanit.durum !== 200 || (rc !== undefined && rc !== "SUCCESS")) {
      throw new Hata(KODLAR.PORTAL_YANIT_BILINMIYOR, `belge yanıtı HTTP ${yanit.durum}, rc=${rc ?? "-"}`);
    }
    const ct = yanit.basliklar["content-type"] ?? "";
    // OTURUM ÖLÜMÜ: text/html + giriş sayfası imzası (doğrulanmış tespit)
    if (ct.includes("text/html")) {
      const bas = yanit.baytlar.subarray(0, Math.min(4096, yanit.baytlar.length)).toString("utf8");
      if (GIRIS_IMZALARI.some((r) => r.test(bas))) {
        throw new Hata(KODLAR.OTURUM_BITTI, "giriş sayfası döndü — oturum düşmüş");
      }
    }
    return {
      durum: yanit.durum,
      basliklar: yanit.basliklar,
      baytlar: yanit.baytlar,
      rc: yanit.basliklar["uyapfc_rc"],
    };
  }

  /** Genel talep: HTTP + rc denetimi + sessiz bozulma tespiti.
   *  `cerez` verilirse depolanan oturum çerezi yerine o kullanılır —
   *  CDP yakalama kapısı henüz kayıtlı olmayan çerezi sınarken bunu kullanır. */
  async talep(yol: string, secenek: { yontem: "POST"; govde: string; cerez?: string }): Promise<PortalYanit> {
    const ham = await this.sirali(() => hamIstek(this.sec.baseUrl + yol, {
      yontem: secenek.yontem,
      govde: secenek.govde,
      cookie: secenek.cerez ?? this.sec.cookie(),
      zamanAsimiMs: this.sec.zamanAsimiMs ?? 60_000,
      ...(this.sec.yanitTavaniBayt !== undefined ? { enBuyukBaytlar: this.sec.yanitTavaniBayt } : {}),
    }));
    const yanit: PortalYanit = {
      durum: ham.durum,
      basliklar: ham.basliklar,
      govde: ham.baytlar.toString("utf8"),
      rc: ham.basliklar["uyapfc_rc"],
    };
    this.sec.logla?.(`uyap ${yol} → ${yanit.durum} rc=${yanit.rc ?? "-"} (${yanit.govde.length} byte)`);
    if (OTURUM_BITTIR.has(yanit.rc ?? "")) {
      throw new Hata(KODLAR.OTURUM_BITTI, "portal oturumu bitti (rc=" + yanit.rc + ")");
    }
    if (yanit.durum >= 400) {
      throw new Hata(
        KODLAR.PORTAL_YANIT_BILINMIYOR,
        `portal ${yanit.durum} döndü: ${yol}`,
        { govde: yanit.govde.slice(0, 500) }
      );
    }
    return yanit;
  }

  /** JSON uçlarından satır listesi çıkarır (toleranslı). */
  async satirlar(yol: string, govde: unknown): Promise<Record<string, unknown>[]> {
    const yanit = await this.talep(yol, { yontem: "POST", govde: JSON.stringify(govde) });
    const { satirlariDuzlestir } = await import("./schema.js");
    // RC başlığı varsa SUCCESS dışı değerlerde hata ver
    if (yanit.rc && yanit.rc !== "SUCCESS") {
      throw new Hata(
        KODLAR.PORTAL_YANIT_BILINMIYOR,
        `portal rc=${yanit.rc}: ${yol}`,
        { govde: yanit.govde.slice(0, 800) }
      );
    }
    const satirlar = satirlariDuzlestir(belkiJson(yanit.govde));
    return satirlar as Record<string, unknown>[];
  }
}

function belkiJson(metin: string): unknown {
  try {
    return JSON.parse(metin);
  } catch {
    return { ham: metin };
  }
}

/** Giriş sayfası imzaları — oturum öldüğünde belge yerine HTML döner
 *  (doğrulanmış tespit: PS betiğindeki desenler). */
const GIRIS_IMZALARI: RegExp[] = [
  /Giri(ş|s) Sayfas/i,
  /e-Devlet/,
  /login\.uyap/,
  /oturum.*sonlan/i,
  /giris\.uyap/i,
];

/** Sessiz bozulma tespiti: text/plain yanıt = belge değil (yüklenmemiş ya da
 *  hata mesajı; doğrulanmış davranış — asla belge olarak kaydedilmez). */
export function evrakYuklenmemisMi(baytlar: Buffer, contentTipi: string): boolean {
  return contentTipi.includes("text/plain");
}

/** text/plain yanıtın kullanıcı-okunur mesajı. */
export function yuklenmemisMesaji(baytlar: Buffer): string {
  return baytlar.toString("utf8").trim().slice(0, 200);
}

export interface HamIstekSecenek {
  yontem: "GET" | "POST";
  govde?: string;
  cookie: string;
  zamanAsimiMs: number;
  /** Yanıt gövdesi tavanı (bayt); varsayılan {@link YANIT_TAVANI}. */
  enBuyukBaytlar?: number;
}

export interface HamYanit {
  durum: number;
  basliklar: Record<string, string>;
  baytlar: Buffer;
}

/** node:http tabanlı ham istek — sıfır bağımlılık. */
export async function hamIstek(url: string, sec: HamIstekSecenek): Promise<HamYanit> {
  const u = new URL(url);
  const mod = u.protocol === "https:" ? await import("node:https") : await import("node:http");
  const govdeBuffer = sec.govde !== undefined ? Buffer.from(sec.govde, "utf8") : undefined;
  const basliklar: Record<string, string> = {
    ...(govdeBuffer !== undefined ? { "content-type": "application/json; charset=UTF-8" } : {}),
    ...(govdeBuffer !== undefined ? { "content-length": String(govdeBuffer.byteLength) } : {}),
    ...(sec.cookie ? { cookie: sec.cookie } : {}),
    "user-agent": "Tensip/1.0",
    accept: "*/*",
  };
  const tavan = sec.enBuyukBaytlar ?? YANIT_TAVANI;
  return await new Promise<HamYanit>((coz, red) => {
    let bitti = false;
    const tavaniAstir = (olculen: number): void => {
      if (bitti) return;
      bitti = true;
      req.destroy();
      red(
        new Hata(
          KODLAR.PORTAL_YANIT_BILINMIYOR,
          `portal yanıtı ${tavan} bayt sınırını aştı (${olculen} bayt): ${url}`
        )
      );
    };
    const req = mod.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: sec.yontem,
        headers: basliklar,
      },
      (res) => {
        // Bildirilen uzunluk tavanı aşıyorsa gövde hiç indirilmez.
        const bildirilen = Number(res.headers["content-length"]);
        if (Number.isFinite(bildirilen) && bildirilen > tavan) {
          tavaniAstir(bildirilen);
          return;
        }
        const parcalar: Buffer[] = [];
        let boyut = 0;
        res.on("data", (c: Buffer) => {
          if (bitti) return;
          boyut += c.length;
          // content-length yalan söyleyebilir; birikimi de sınırla.
          if (boyut > tavan) {
            tavaniAstir(boyut);
            return;
          }
          parcalar.push(c);
        });
        res.on("end", () => {
          if (bitti) return;
          bitti = true;
          const bas: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (v === undefined) continue;
            const deger = Array.isArray(v) ? v.join(", ") : String(v);
            if (BILINEN_BASLIKLAR.includes(k) || k.startsWith("x-")) bas[k] = deger;
          }
          coz({ durum: res.statusCode ?? 0, basliklar: bas, baytlar: Buffer.concat(parcalar) });
        });
      }
    );
    req.on("error", (e) => {
      if (bitti) return;
      bitti = true;
      red(e);
    });
    req.setTimeout(sec.zamanAsimiMs, () => {
      req.destroy(new Error(`zaman aşımı (${sec.zamanAsimiMs} ms): ${url}`));
    });
    if (govdeBuffer !== undefined) req.write(govdeBuffer);
    req.end();
  });
}

