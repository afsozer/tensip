// Portal yanıtı belleğe alınır. Tek sınır zaman aşımı olursa bozuk ya da
// bitmeyen bir yanıt motoru şişirir; bu testler bayt tavanını sabitler.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { hamIstek, YANIT_TAVANI } from "../src/uyap/client.js";

describe("portal yanıt tavanı", () => {
  let sunucu: Server;
  let adres = "";
  /** Gövde gerçekten okundu mu? (content-length ile erken ret kanıtı) */
  let gonderilenBayt = 0;

  before(async () => {
    sunucu = createServer((req, res) => {
      gonderilenBayt = 0;
      const parca = Buffer.alloc(64 * 1024, 0x61);
      const yol = (req.url ?? "").split("?")[0];
      if (yol === "/kucuk") {
        res.writeHead(200, { "content-type": "application/pdf", "content-length": "5" });
        res.end("kucuk");
        return;
      }
      if (yol === "/uzunluk-yalani") {
        // content-length yok (chunked): tavan yalnız birikimle yakalanabilir.
        res.writeHead(200, { "content-type": "application/pdf" });
        const yaz = (): void => {
          while (gonderilenBayt < 8 * 1024 * 1024) {
            gonderilenBayt += parca.length;
            if (!res.write(parca)) {
              res.once("drain", yaz);
              return;
            }
          }
          res.end();
        };
        yaz();
        return;
      }
      // /bildirilen: content-length tavanın üstünde — gövde hiç okunmamalı.
      res.writeHead(200, {
        "content-type": "application/pdf",
        "content-length": String(8 * 1024 * 1024),
      });
      const yaz = (): void => {
        while (gonderilenBayt < 8 * 1024 * 1024) {
          gonderilenBayt += parca.length;
          if (!res.write(parca)) {
            res.once("drain", yaz);
            return;
          }
        }
        res.end();
      };
      yaz();
    });
    await new Promise<void>((c) => sunucu.listen(0, "127.0.0.1", c));
    adres = `http://127.0.0.1:${(sunucu.address() as { port: number }).port}`;
  });

  after(async () => {
    await new Promise<void>((c) => {
      sunucu.close(() => c());
      sunucu.closeAllConnections();
    });
  });

  test("varsayılan tavan gerçek evrakı geçecek kadar yüksek", () => {
    // Taranmış PDF/TIFF rahatça altında kalmalı; tavan koruma, kota değil.
    assert.ok(YANIT_TAVANI >= 64 * 1024 * 1024);
  });

  test("tavanın altındaki yanıt normal döner", async () => {
    const y = await hamIstek(`${adres}/kucuk`, {
      yontem: "GET",
      cookie: "JSESSIONID=t",
      zamanAsimiMs: 5_000,
      enBuyukBaytlar: 1024,
    });
    assert.equal(y.durum, 200);
    assert.equal(y.baytlar.toString("utf8"), "kucuk");
  });

  test("bildirilen content-length tavanı aşarsa gövde indirilmeden reddedilir", async () => {
    await assert.rejects(
      hamIstek(`${adres}/bildirilen`, {
        yontem: "GET",
        cookie: "JSESSIONID=t",
        zamanAsimiMs: 5_000,
        enBuyukBaytlar: 256 * 1024,
      }),
      (e: unknown) => {
        assert.equal((e as { code?: string }).code, "PORTAL_YANIT_BILINMIYOR");
        assert.match((e as Error).message, /bayt sınırını aştı/);
        return true;
      },
    );
    // Erken ret: 8 MiB'lik gövde tamamen yazılmadan bağlantı koptu.
    assert.ok(
      gonderilenBayt < 8 * 1024 * 1024,
      `sunucu ${gonderilenBayt} bayt yazdı; erken ret beklenir`,
    );
  });

  test("content-length yoksa birikim tavanda kesilir", async () => {
    const tavan = 256 * 1024;
    await assert.rejects(
      hamIstek(`${adres}/uzunluk-yalani`, {
        yontem: "GET",
        cookie: "JSESSIONID=t",
        zamanAsimiMs: 10_000,
        enBuyukBaytlar: tavan,
      }),
      (e: unknown) => {
        assert.equal((e as { code?: string }).code, "PORTAL_YANIT_BILINMIYOR");
        return true;
      },
    );
    assert.ok(
      gonderilenBayt < 8 * 1024 * 1024,
      `sunucu ${gonderilenBayt} bayt yazdı; akış tavanda kesilmeliydi`,
    );
  });
});
