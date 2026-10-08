// CLI istemcisi — daemon'ın control.json'una bağlanır.
// İş mantığı SIFIR: sunucu ne derse onu taşır (ince istemci sözleşmesi).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export class CliHata extends Error {
  code: string;
  details?: unknown;
  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = "CliHata";
  }
}

const YOK_MESAJ = "tensipd çalışmıyor ya da CLI erişimi kapalı. Başlatmak için: `tensipd baslat`";
const YOK = () => new CliHata("APP_GONE", YOK_MESAJ);

export interface KontrolBilgi {
  version: 1;
  port: number;
  token: string;
  instanceId: string;
  pid: number;
  appVersion: string;
}

export function kontrolDizini(ayarDir?: string): string {
  if (ayarDir !== undefined) return ayarDir;
  return join(homedir(), ".config", "tensip");
}

export function kontrolOku(ayarDir?: string): KontrolBilgi {
  let ham: unknown;
  try {
    ham = JSON.parse(readFileSync(join(kontrolDizini(ayarDir), "control.json"), "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw YOK();
    throw new CliHata("INVALID_INPUT", "control.json bozuk; daemon kimliği doğrulanamadı");
  }
  const o = ham as KontrolBilgi | null;
  // PID'e bakılmaz (PID yeniden kullanılabilir); gerçek kanıt kimlikli RPC
  // bağlantısının kendisidir. Bozuk dosya, kayıp daemon ile karıştırılmaz.
  if (
    o === null ||
    o.version !== 1 ||
    typeof o.token !== "string" ||
    o.token.length === 0 ||
    typeof o.instanceId !== "string" ||
    o.instanceId.length === 0 ||
    !Number.isInteger(o.port) ||
    o.port < 1 ||
    o.port > 65535 ||
    !Number.isInteger(o.pid) ||
    o.pid < 1
  ) {
    throw new CliHata("INVALID_INPUT", "control.json bozuk; daemon kimliği doğrulanamadı");
  }
  return o;
}

export function istemciYap(ayarDir?: string) {
  const bilgi = () => kontrolOku(ayarDir);
  const basliklar = (d: KontrolBilgi) => ({
    authorization: `Bearer ${d.token}`,
    host: `127.0.0.1:${d.port}`,
  });
  return {
    async cagir(ad: string, govde: unknown): Promise<unknown> {
      const d = bilgi();
      let yanit: Response;
      try {
        yanit = await fetch(`http://127.0.0.1:${d.port}/rpc/${encodeURIComponent(ad)}`, {
          method: "POST",
          headers: { ...basliklar(d), "content-type": "application/json" },
          body: JSON.stringify(govde ?? {}),
          ...(ad === "durdur" ? { signal: AbortSignal.timeout(5_000) } : {}),
        });
      } catch (sebep) {
        // bağlanamadı: bayat control.json (süreç ölmüş/port kapalı)
        const ayrinti = sebep instanceof Error ? (sebep.cause as { message?: string; code?: string } | undefined) : undefined;
        throw new CliHata("APP_GONE", YOK_MESAJ, ayrinti?.message ?? String(sebep));
      }
      let g: { ok?: boolean; data?: unknown; error?: { code: string; message: string; details?: unknown } };
      try {
        g = (await yanit.json()) as typeof g;
      } catch {
        throw new CliHata("INTERNAL", "sunucu yanıtı JSON değil");
      }
      if (g.ok === true) return g.data;
      throw new CliHata(g.error?.code ?? "INTERNAL", g.error?.message ?? "hata", g.error?.details);
    },
    async get(yol: string): Promise<unknown> {
      const d = bilgi();
      let yanit: Response;
      try {
        yanit = await fetch(`http://127.0.0.1:${d.port}${yol}`, { headers: basliklar(d) });
      } catch {
        throw YOK();
      }
      try {
        return await yanit.json();
      } catch {
        throw new CliHata("INTERNAL", "sunucu yanıtı JSON değil");
      }
    },
    async *akis(yol: string): AsyncGenerator<unknown, void, void> {
      const d = bilgi();
      let yanit: Response;
      try {
        yanit = await fetch(`http://127.0.0.1:${d.port}${yol}`, { headers: basliklar(d) });
      } catch {
        throw YOK();
      }
      if (!yanit.ok || !yanit.body) throw new CliHata("APP_GONE", "akış açılamadı");
      const okuyucu = yanit.body.getReader();
      const cozucu = new TextDecoder();
      let tampon = "";
      // finally ŞART: tüketicisi break ederse okuyucu iptal edilmeden açık
      // soket Node'un event loop'unu canlı tutar ve CLI asla çıkmaz.
      try {
        for (;;) {
          const { value, done } = await okuyucu.read();
          if (done) {
            const kalan = tampon.trim();
            if (kalan !== "") yield JSON.parse(kalan);
            return;
          }
          tampon += cozucu.decode(value, { stream: true });
          const satirlar = tampon.split("\n");
          tampon = satirlar.pop() ?? "";
          for (const s of satirlar) {
            if (s.trim() !== "") yield JSON.parse(s);
          }
        }
      } finally {
        await okuyucu.cancel().catch(() => undefined);
      }
    },
  };
}

export type Istemci = ReturnType<typeof istemciYap>;
