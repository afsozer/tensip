// CDP komut/olay köprüsü. WebSocket çerçeveleme, upgrade ve ping/pong
// Node'un yerleşik istemcisine aittir; üretim bağımlılığı gerekmez.
import { hamIstek } from "./client.js";

export interface WsSecenek {
  /** Yalnız bağlantı kurulması için tavan; açık bağlantı sessizlikte kapanmaz. */
  zamanAsimiMs?: number;
  onClose?: (neden: string) => void;
}

export class MiniWs {
  private soket?: WebSocket;
  private bekleme = new Map<number, {
    coz: (v: unknown) => void;
    red: (e: Error) => void;
    zamanlayici: ReturnType<typeof setTimeout>;
  }>();
  private olayAboneleri = new Map<string, Set<(params: unknown, oturum?: string) => void>>();
  private sonId = 0;
  acik = false;

  async baglan(url: string, sec: WsSecenek = {}): Promise<void> {
    if (new URL(url).protocol !== "ws:") throw new Error("ws adresi bekleniyor");
    if (this.soket) throw new Error("ws bağlantısı zaten başlatıldı");
    const soket = new WebSocket(url);
    this.soket = soket;
    await new Promise<void>((coz, red) => {
      let bildirildi = false;
      const bitti = (neden: string): void => {
        clearTimeout(zamanlayici);
        this.acik = false;
        const hata = new Error(neden);
        red(hata);
        this.bekleyenleriReddet(hata);
        this.olayAboneleri.clear();
        if (!bildirildi) {
          bildirildi = true;
          sec.onClose?.(neden);
        }
      };
      const zamanlayici = setTimeout(() => {
        bitti("ws bağlantı zaman aşımı");
        soket.close();
      }, sec.zamanAsimiMs ?? 10_000);
      soket.addEventListener("open", () => {
        clearTimeout(zamanlayici);
        this.acik = true;
        coz();
      }, { once: true });
      soket.addEventListener("error", () => bitti("ws bağlantı hatası"));
      soket.addEventListener("close", () => bitti("ws bağlantısı kapandı"), { once: true });
      soket.addEventListener("message", (olay) => {
        if (typeof olay.data === "string") this.mesajGeldi(olay.data);
      });
    });
  }

  private bekleyenleriReddet(hata: Error): void {
    for (const b of this.bekleme.values()) {
      clearTimeout(b.zamanlayici);
      b.red(hata);
    }
    this.bekleme.clear();
  }

  private mesajGeldi(metin: string): void {
    let msg: { id?: number; method?: string; params?: unknown; error?: unknown; result?: unknown; sessionId?: string };
    try { msg = JSON.parse(metin); } catch { return; }
    if (!msg || typeof msg !== "object") return;
    if (typeof msg.id === "number") {
      const b = this.bekleme.get(msg.id);
      if (b) {
        this.bekleme.delete(msg.id);
        clearTimeout(b.zamanlayici);
        if (msg.error !== undefined) b.red(new Error(JSON.stringify(msg.error)));
        else b.coz(msg.result);
      }
    }
    if (typeof msg.method === "string") {
      for (const cb of this.olayAboneleri.get(msg.method) ?? []) {
        try { cb(msg.params, msg.sessionId); } catch { /* abone bağlantıyı kapatmasın */ }
      }
    }
  }

  olayDinle(metod: string, cb: (params: unknown, oturum?: string) => void): () => void {
    let kume = this.olayAboneleri.get(metod);
    if (!kume) {
      kume = new Set();
      this.olayAboneleri.set(metod, kume);
    }
    kume.add(cb);
    return () => {
      kume.delete(cb);
      if (kume.size === 0) this.olayAboneleri.delete(metod);
    };
  }

  cagir(metod: string, params: Record<string, unknown> = {}, oturum?: string): Promise<unknown> {
    if (!this.acik || this.soket?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("cdp bağlantısı açık değil"));
    }
    const id = ++this.sonId;
    return new Promise<unknown>((coz, red) => {
      const zamanlayici = setTimeout(() => {
        this.bekleme.delete(id);
        red(new Error(`cdp zaman aşımı: ${metod}`));
      }, 30_000);
      this.bekleme.set(id, { coz, red, zamanlayici });
      const mesaj: Record<string, unknown> = { id, method: metod, params };
      if (oturum !== undefined) mesaj["sessionId"] = oturum;
      try { this.soket!.send(JSON.stringify(mesaj)); }
      catch (e) {
        this.bekleme.delete(id);
        clearTimeout(zamanlayici);
        red(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  kapat(): void {
    this.acik = false;
    this.bekleyenleriReddet(new Error("cdp bağlantısı kapatıldı"));
    this.olayAboneleri.clear();
    this.soket?.close();
  }
}

/** CDP tarayıcı istemcisi: hedef listesi + çerez yoklaması. */
export class CdpIstemci {
  private ws?: MiniWs;
  constructor(public tarayiciWsUrl: string) {}

  get acik(): boolean { return this.ws?.acik ?? false; }

  static async hedefleriListele(port: number): Promise<{ pages: { url: string; title: string; id: string }[]; tarayiciWsUrl: string }> {
    const ham = await hamIstek(`http://127.0.0.1:${port}/json/list`, {
      yontem: "GET",
      cookie: "",
      zamanAsimiMs: 5000,
    });
    const liste = JSON.parse(ham.baytlar.toString("utf8")) as {
      type: string;
      url: string;
      title: string;
      id: string;
      webSocketDebuggerUrl?: string;
    }[];
    const ver = await hamIstek(`http://127.0.0.1:${port}/json/version`, {
      yontem: "GET",
      cookie: "",
      zamanAsimiMs: 5000,
    });
    const v = JSON.parse(ver.baytlar.toString("utf8")) as { webSocketDebuggerUrl: string };
    return {
      pages: liste.filter((t) => t.type === "page").map((t) => ({ url: t.url, title: t.title, id: t.id })),
      tarayiciWsUrl: v.webSocketDebuggerUrl,
    };
  }

  async ac(): Promise<void> {
    this.ws = new MiniWs();
    await this.ws.baglan(this.tarayiciWsUrl, { zamanAsimiMs: 10_000 });
  }

  /** Tarayıcı genelindeki tüm çerezler. */
  async tumCerezler(): Promise<{ name: string; domain: string; value: string }[]> {
    if (!this.ws) throw new Error("cdp açık değil");
    const r = (await this.ws.cagir("Storage.getCookies", {})) as { cookies?: { name: string; domain: string; value: string }[] };
    return r.cookies ?? [];
  }

  /** CDP hedefleri (sayfalar dahil) — yedek tamamlanma kriteri için. */
  async sayfaHedefleri(): Promise<{ id: string; tip: string; url: string }[]> {
    if (!this.ws) throw new Error("cdp açık değil");
    const r = (await this.ws.cagir("Target.getTargets", {})) as {
      targetInfos?: { targetId?: string; type?: string; url?: string }[];
    };
    return (r.targetInfos ?? []).map((t) => ({ id: t.targetId ?? "", tip: t.type ?? "", url: t.url ?? "" }));
  }

  /**
   * Sayfa hedeflerinin ağ trafiğini izler (flatten oturumlar). Yeni
   * hedefler (popup) için de otomatik bağlanır. Dönen fonksiyon tüm
   * abonelikleri kapatır.
   *
   * Neden var: giriş tamamlanmasını portala İSTEK ATmadan anlamak
   * istiyoruz (5 Eyl gözlemi: ara oturumla dış probe sunucu oturumunu
   * bozuyor). Tarayıcının kendi ajx yanıtlarındaki `uyapfc_rc: SUCCESS`
   * buradan okunur.
   */
  async aglariIzle(
    cb: (yanit: { url: string; durum: number; basliklar: Record<string, string> }) => void
  ): Promise<() => void> {
    if (!this.ws) throw new Error("cdp açık değil");
    const ws = this.ws;
    const abonelikler: (() => void)[] = [];
    // Önce global abonelik: hangi oturumdan gelirse gelsin (zaten yalnız
    // Network.enable açtığımız hedeflerden olay akar).
    abonelikler.push(
      ws.olayDinle("Network.responseReceived", (params) => {
        const y = (params as { response?: { url?: string; status?: number; headers?: Record<string, string> } }).response;
        if (!y?.url) return;
        cb({ url: y.url, durum: y.status ?? 0, basliklar: y.headers ?? {} });
      })
    );
    const baglanmis = new Set<string>();
    let durdu = false;
    const bagla = async (hedefId: string): Promise<void> => {
      if (durdu || baglanmis.has(hedefId)) return;
      baglanmis.add(hedefId);
      try {
        const r = (await ws.cagir("Target.attachToTarget", { targetId: hedefId, flatten: true })) as {
          sessionId?: string;
        };
        if (!r.sessionId || durdu) return;
        await ws.cagir("Network.enable", {}, r.sessionId);
      } catch {
        /* bağlanılamayan hedef (korunan pencere vb.) — yok say */
      }
    };
    // Discover mevcut hedefler için de olay üretir; önce dinleyici kurulmalı.
    abonelikler.push(
      ws.olayDinle("Target.targetCreated", (params) => {
        const t = (params as { targetInfo?: { type?: string; targetId?: string } }).targetInfo;
        if (t?.type === "page" && t.targetId) void bagla(t.targetId);
      })
    );
    try {
      await ws.cagir("Target.setDiscoverTargets", { discover: true });
      const hedefler = await this.sayfaHedefleri();
      for (const h of hedefler) {
        if (h.tip === "page" && h.id) void bagla(h.id);
      }
    } catch {
      /* Bağlantı kapanmışsa çağıran giriş döngüsü bunu denetler. */
    }
    return () => {
      durdu = true;
      for (const kapat2 of abonelikler) kapat2();
    };
  }

  kapat(): void {
    this.ws?.kapat();
  }
}
