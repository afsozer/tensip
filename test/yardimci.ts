import { deflateSync } from "node:zlib";
// Test yardımcıları: ZIP üretici (UDF fixture), mini PDF, HTML, geçici dizinler.

import { createHash } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

// ── CRC32 ────────────────────────────────────────────────────────────
const CRC_TABLO: number[] = (() => {
  const t: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLO[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// ── ZIP üretici (store yöntemi) ──────────────────────────────────────
export interface ZipGirdi {
  ad: string;
  veri: Buffer;
}

export function zipYaz(girdiler: ZipGirdi[]): Buffer {
  const parcalar: Buffer[] = [];
  const merkezi: Buffer[] = [];
  let ofset = 0;
  for (const g of girdiler) {
    const ad = Buffer.from(g.ad, "utf8");
    const crc = crc32(g.veri);
    const yerel = Buffer.alloc(30);
    yerel.writeUInt32LE(0x04034b50, 0);
    yerel.writeUInt16LE(20, 4);
    yerel.writeUInt16LE(0, 6);
    yerel.writeUInt16LE(0, 8); // store
    yerel.writeUInt16LE(0, 10);
    yerel.writeUInt16LE(0, 12);
    yerel.writeUInt32LE(crc, 14);
    yerel.writeUInt32LE(g.veri.length, 18);
    yerel.writeUInt32LE(g.veri.length, 22);
    yerel.writeUInt16LE(ad.length, 26);
    yerel.writeUInt16LE(0, 28);
    parcalar.push(yerel, ad, g.veri);

    const merkeziKayit = Buffer.alloc(46);
    merkeziKayit.writeUInt32LE(0x02014b50, 0);
    merkeziKayit.writeUInt16LE(20, 4);
    merkeziKayit.writeUInt16LE(20, 6);
    merkeziKayit.writeUInt16LE(0, 8);
    merkeziKayit.writeUInt16LE(0, 10);
    merkeziKayit.writeUInt16LE(0, 12);
    merkeziKayit.writeUInt16LE(0, 14);
    merkeziKayit.writeUInt32LE(crc, 16);
    merkeziKayit.writeUInt32LE(g.veri.length, 20);
    merkeziKayit.writeUInt32LE(g.veri.length, 24);
    merkeziKayit.writeUInt16LE(ad.length, 28);
    merkeziKayit.writeUInt16LE(0, 30);
    merkeziKayit.writeUInt16LE(0, 32);
    merkeziKayit.writeUInt16LE(0, 34);
    merkeziKayit.writeUInt16LE(0, 36);
    merkeziKayit.writeUInt32LE(0, 38);
    merkeziKayit.writeUInt32LE(ofset, 42);
    merkezi.push(merkeziKayit, ad);
    ofset += 30 + ad.length + g.veri.length;
  }
  const merkeziBuyukluk = merkezi.reduce((a, b) => a + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(girdiler.length, 8);
  eocd.writeUInt16LE(girdiler.length, 10);
  eocd.writeUInt32LE(merkeziBuyukluk, 12);
  eocd.writeUInt32LE(ofset, 16);
  return Buffer.concat([...parcalar, ...merkezi, eocd]);
}

// ── UDF fixture ──────────────────────────────────────────────────────

/** UYAP content.xml üretir: metin CDATA + paragraf ofsetleri. */
export function udfContentXml(metin: string, paragrafUzunluklari: number[]): string {
  let kalip = '<?xml version="1.0" encoding="UTF-8" ?> \n\n<template format_id="1.8" >\n<content><![CDATA[';
  // paragraflar: offset'ler üst üste gelir; uzunluklar toplamı metnin tamamı
  let ofset = 0;
  const paragraflar: string[] = [];
  for (const u of paragrafUzunluklari) {
    paragraflar.push(`<content startOffset="${ofset}" length="${u}" />`);
    ofset += u;
  }
  kalip += metin + "]]></content><properties><pageFormat mediaSizeName=\"1\" leftMargin=\"42.5\" rightMargin=\"42.5\" topMargin=\"42.5\" bottomMargin=\"42.5\" paperOrientation=\"1\" headerFOffset=\"20.0\" footerFOffset=\"20.0\" /></properties>\n<elements resolver=\"hvl-default\" >\n";
  kalip += paragraflar.map((p) => `<paragraph>${p}</paragraph>`).join("");
  kalip += "\n</elements>\n<styles><style name=\"hvl-default\" family=\"Times New Roman\" size=\"12\" description=\"Gövde\" /></styles>\n</template>";
  return kalip;
}

/** Gerçekçi UDF: metnin paragraflarını otomatik keser (paragraf = satır). */
export function makeUdf(paragraflar: string[]): Buffer {
  const parca = paragraflar.map((p) => p + "\n");
  const metin = parca.join("");
  const uzunluklar = parca.map((p) => p.length);
  const xml = udfContentXml(metin, uzunluklar);
  return zipYaz([
    { ad: "content.xml", veri: Buffer.from(xml, "utf8") },
    { ad: "sign.sgn", veri: Buffer.from("---sahte imza---", "utf8") },
  ]);
}

// ── HTML fixture ─────────────────────────────────────────────────────
export function makeHtml(icerik: string, baslik = "Vekalet Pulu"): Buffer {
  return Buffer.from(
    `<html><head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8">` +
      `<title>${baslik}</title></head><body>` +
      icerik +
      `</body></html>`,
    "utf8"
  );
}

// ── mini PDF (metin katmanlı) ────────────────────────────────────────
export function miniPdf(metin = "Test PDF metni", sikistir = false): Buffer {
  const ham = Buffer.from(metin ? `BT /F1 12 Tf 72 720 Td (${metin}) Tj ET` : "", "latin1");
  const akis = sikistir ? deflateSync(ham) : ham;
  const nesneler = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
    `4 0 obj\n<< /Length ${akis.length}${sikistir ? " /Filter /FlateDecode" : ""} >>\nstream\n${akis.toString("latin1")}\nendstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];
  let pdf = "%PDF-1.4\n";
  const ofsetler: number[] = [];
  for (const n of nesneler) {
    ofsetler.push(pdf.length);
    pdf += n;
  }
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n`;
  for (const o of ofsetler) {
    pdf += String(o).padStart(10, "0") + " 00000 n \n";
  }
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

// ── geçici dizin ─────────────────────────────────────────────────────
export function tmpKok(): { kok: string; temizle: () => void } {
  const kok = mkdtempSync(join(tmpdir(), "tensip-test-"));
  return { kok, temizle: () => rmSync(kok, { recursive: true, force: true }) };
}

/** Dosya başında BİR KEZ çağrılır; dönen işlev `tmpKok` gibi kullanılır ama
 *  açtığı her dizini dosyanın tüm testleri bitince siler. Çok sayıda kısa testin
 *  her birine try/finally sarmak yerine: gövde değişmez, düşen test de artık
 *  bırakmaz. `bin/test-kos.mjs` bekçisi sızan dizini sayar. */
export function geciciKokler(): typeof tmpKok {
  const acik: (() => void)[] = [];
  after(() => {
    for (const temizle of acik.splice(0)) temizle();
  });
  return () => {
    const k = tmpKok();
    acik.push(k.temizle);
    return k;
  };
}

export function davaYaz(kok: string, rel: string, veri: Buffer | string): void {
  const dosya = join(kok, rel);
  mkdirSync(join(dosya, ".."), { recursive: true });
  writeFileSync(dosya, veri);
}

// Paylaşılan mock CDP (WebSocket) sunucusu — cdp.test.ts ve oturum-yenile testleri kullanır.
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export class MiniWsSunucu {
  sunucu: Server;
  port = 0;
  private istemciler = new Set<Socket>();

  /** Testin cevaplamadığı CDP komutlarına standart yanıtlar. */
  static VARSAYILAN: Record<string, unknown> = {
    "Target.setDiscoverTargets": {},
    "Target.attachToTarget": { sessionId: "s1" },
    "Network.enable": {},
    "Target.getTargets": { targetInfos: [] },
  };

  constructor(private isleyici: (mesaj: { id?: number; method?: string }) => unknown) {
    this.sunucu = createServer((soket) => {
      let tampon = Buffer.alloc(0);
      let yukseldi = false;
      soket.on("data", (d: Buffer) => {
        tampon = Buffer.concat([tampon, d]);
        if (!yukseldi) {
          const metin = tampon.toString("utf8");
          const bitis = metin.indexOf("\r\n\r\n");
          if (bitis < 0) return;
          const anahtar = /Sec-WebSocket-Key: (\S+)/i.exec(metin)?.[1];
          if (!anahtar) {
            soket.destroy();
            return;
          }
          const kabul = createHash("sha1").update(anahtar + GUID).digest("base64");
          soket.write(
            "HTTP/1.1 101 Switching Protocols\r\n" +
              "Upgrade: websocket\r\n" +
              "Connection: Upgrade\r\n" +
              `Sec-WebSocket-Accept: ${kabul}\r\n\r\n`
          );
          yukseldi = true;
          tampon = tampon.subarray(Buffer.byteLength(metin.slice(0, bitis + 4), "utf8"));
          this.istemciler.add(soket);
          soket.on("close", () => this.istemciler.delete(soket));
        }
        for (;;) {
          const c = this.cerceveCoz(tampon);
          if (!c) break;
          tampon = tampon.subarray(c.tuketildi);
          if (c.opkod === 8) {
            soket.end();
            continue;
          }
          if (c.opkod !== 1) continue;
          const mesaj = JSON.parse(c.veri.toString("utf8"));
          let yanit = this.isleyici(mesaj);
          // Testin cevaplamadığı CDP komutlarına standart yanıtlar —
          // ağ izleme (Target/Network) kurulumunun asılmasın diye.
          if (yanit === undefined && mesaj.id !== undefined && mesaj.method !== undefined) {
            const v = MiniWsSunucu.VARSAYILAN[mesaj.method];
            if (v !== undefined) yanit = v;
          }
          if (yanit !== undefined && mesaj.id !== undefined) {
            this.gonder(soket, JSON.stringify({ id: mesaj.id, result: yanit }));
          }
        }
      });
    });
  }

  private cerceveCoz(t: Buffer): { opkod: number; veri: Buffer; tuketildi: number } | null {
    if (t.length < 2) return null;
    const opkod = t[0]! & 0x0f;
    const maske = (t[1]! & 0x80) !== 0;
    let uzunluk = t[1]! & 0x7f;
    let kafa = 2;
    if (uzunluk === 126) {
      if (t.length < 4) return null;
      uzunluk = t.readUInt16BE(2);
      kafa = 4;
    } else if (uzunluk === 127) {
      if (t.length < 10) return null;
      uzunluk = Number(t.readBigUInt64BE(2));
      kafa = 10;
    }
    if (!maske) return null; // istemci maskeli göndermek ZORUNDA
    if (t.length < kafa + 4 + uzunluk) return null;
    const anahtar = t.subarray(kafa, kafa + 4);
    const govde = Buffer.from(t.subarray(kafa + 4, kafa + 4 + uzunluk));
    for (let i = 0; i < govde.length; i++) govde[i] = govde[i]! ^ anahtar[i % 4]!;
    return { opkod, veri: govde, tuketildi: kafa + 4 + uzunluk };
  }

  private gonder(soket: Socket, metin: string): void {
    const veri = Buffer.from(metin, "utf8");
    let kafa: Buffer;
    if (veri.length < 126) {
      kafa = Buffer.from([0x81, veri.length]);
    } else {
      kafa = Buffer.alloc(4);
      kafa[0] = 0x81;
      kafa[1] = 126;
      kafa.writeUInt16BE(veri.length, 2);
    }
    soket.write(Buffer.concat([kafa, veri]));
  }

  baslat(sabitPort?: number): Promise<void> {
    return new Promise((c) => {
      this.sunucu.listen(sabitPort ?? 0, "127.0.0.1", () => {
        const a = this.sunucu.address();
        if (a !== null && typeof a !== "string") this.port = a.port;
        c();
      });
    });
  }

  durdur(): Promise<void> {
    for (const s of this.istemciler) s.destroy();
    return new Promise((c) => this.sunucu.close(() => c()));
  }

  /** CDP olayı yayını (id'siz mesaj) — Network.responseReceived vb. */
  yayinla(metod: string, params: Record<string, unknown>): void {
    const metin = JSON.stringify({ method: metod, params });
    for (const s of this.istemciler) this.gonder(s, metin);
  }
}
