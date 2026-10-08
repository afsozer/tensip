// RPC sunucusu protokol testleri: control.json, auth, semasi, akışlar

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { join } from "node:path";
import { connect } from "node:net";
import { RpcSunucu } from "../src/server/rpc.js";
import { OlayYayici } from "../src/core/log.js";
import { kontrolOku, istemciYap } from "../src/cli/istemci.js";
import { geciciKokler } from "./yardimci.js";

const tmpKok = geciciKokler();

describe("rpc", () => {
  const { kok } = tmpKok();
  const olaylar = new OlayYayici();
  const isleyiciler = new Map();
  isleyiciler.set("topla", async (g: Record<string, unknown>) => {
    return (Number(g["a"]) || 0) + (Number(g["b"]) || 0);
  });
  isleyiciler.set("hata", async () => {
    const { Hata } = await import("../src/core/errors.js");
    throw new Hata("INVALID_INPUT", "kötü girdi");
  });

  let sunucu: RpcSunucu;
  let port: number;
  let token: string;

  before(async () => {
    sunucu = new RpcSunucu({
      olaylar,
      isleyiciler,
      appVersion: "test",
      dizin: kok,
    });
    const b = await sunucu.baslat();
    port = b.port;
    token = b.token;
  });

  after(async () => {
    await sunucu.durdur();
  });

  test("control.json yazıldı, token 0600", () => {
    const k = kontrolOku(kok);
    assert.equal(k.version, 1);
    assert.equal(k.port, port);
    assert.equal(k.token, token);
    const s = statSync(join(kok, "control.json"));
    assert.equal(s.mode & 0o777, 0o600);
  });

  test("rpc çağrısı token'la çalışır", async () => {
    const ist = istemciYap(kok);
    const son = (await ist.cagir("topla", { a: 2, b: 3 })) as number;
    assert.equal(son, 5);
  });

  test("yanlış token 401", async () => {
    const yanit = await fetch(`http://127.0.0.1:${port}/rpc/topla`, {
      method: "POST",
      headers: { authorization: "Bearer wrong-token-0000", "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(yanit.status, 401);
  });

  test("ASCII dışı Authorization 500 değil 401 döner", async () => {
    // Başlık latin1 çözülür: 0xC3 tek KARAKTER ama UTF-8'de iki BAYT. Karakter
    // uzunluğu kıyaslanırsa timingSafeEqual RangeError atar ve geçersiz token
    // sunucu hatası gibi görünür.
    const sahte = `Bearer ${"Ã".repeat(token.length)}`;
    assert.equal(sahte.length, `Bearer ${token}`.length, "karakter uzunluğu eşit olmalı");
    assert.notEqual(Buffer.byteLength(sahte), Buffer.byteLength(`Bearer ${token}`));
    const yanit = await fetch(`http://127.0.0.1:${port}/rpc/topla`, {
      method: "POST",
      headers: { authorization: sahte, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(yanit.status, 401);
    const g = (await yanit.json()) as { error?: { code?: string } };
    assert.equal(g.error?.code, "LOGIN_REQUIRED");
  });

  test("hata kodu ayrıştırılır", async () => {
    const ist = istemciYap(kok);
    try {
      await ist.cagir("hata", {});
      assert.fail("hata bekleniyordu");
    } catch (e) {
      assert.equal((e as { code?: string }).code, "INVALID_INPUT");
    }
  });

  test("bilinmeyen rpc 404", async () => {
    const ist = istemciYap(kok);
    try {
      await ist.cagir("yok-boyle", {});
      assert.fail("hata bekleniyordu");
    } catch (e) {
      assert.equal((e as { code?: string }).code, "NOT_FOUND");
    }
  });

  test("olay akışı NDJSON", async () => {
    const ist = istemciYap(kok);
    const akis = ist.akis("/olaylar");
    const ilk = await akis.next(); // ilk nabız
    assert.equal((ilk.value as { tip: string }).tip, "nabiz");
    // abonelik kuruldu; şimdi olay bas
    olaylar.bas("deneme", { x: 1 });
    const ikinci = await akis.next();
    assert.equal((ikinci.value as { tip: string }).tip, "deneme");
    await akis.return(undefined);
  });
});

describe("rpc akış tamponu", () => {
  const { kok, temizle } = tmpKok();
  const olaylar = new OlayYayici();
  const TAVAN = 4096;
  let sunucu: RpcSunucu;
  let port = 0;
  let token = "";

  before(async () => {
    sunucu = new RpcSunucu({
      olaylar,
      isleyiciler: new Map(),
      appVersion: "test",
      dizin: kok,
      akisTamponTavani: TAVAN,
    });
    const b = await sunucu.baslat();
    port = b.port;
    token = b.token;
  });

  after(async () => {
    await sunucu.durdur();
    temizle();
  });

  test("okumayan istemcinin akışı tampon tavanında kesilir", async () => {
    const soket = connect(port, "127.0.0.1");
    await new Promise<void>((coz, red) => {
      soket.once("connect", () => coz());
      soket.once("error", red);
    });
    soket.write(
      `GET /olaylar HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
        `Authorization: Bearer ${token}\r\nConnection: keep-alive\r\n\r\n`,
    );
    // net.connect duraklatılmış başlar: istemci HİÇ okumuyor. Çekirdek
    // tamponu dolunca res.writableLength tavanı geçer ve akış kapanmalı.
    await new Promise((c) => setTimeout(c, 100));

    const parca = "x".repeat(64 * 1024);
    const olayBoyutu = JSON.stringify({ tip: "deneme", veri: { veri: parca } }).length;
    let uretilen = 0;
    for (let i = 0; i < 300; i++) {
      olaylar.bas("deneme", { veri: parca });
      uretilen += olayBoyutu;
      await new Promise((c) => setImmediate(c));
    }

    // Şimdi oku: chunked gövde sonlanmış olmalı (0-uzunluklu son parça).
    let alinan = 0;
    let govde = "";
    soket.on("data", (c: Buffer) => {
      alinan += c.length;
      govde += c.toString("latin1");
    });
    soket.resume();
    await Promise.race([
      new Promise<void>((coz) => {
        const bak = setInterval(() => {
          if (govde.includes("\r\n0\r\n\r\n")) {
            clearInterval(bak);
            coz();
          }
        }, 20);
        bak.unref();
      }),
      new Promise((_, red) =>
        setTimeout(() => red(new Error("akış sonlanmadı; sunucu sınırsız tamponluyor")), 15_000),
      ),
    ]);
    // Asıl kanıt: üretilen ~20 MiB'in tamamı belleğe alınıp gönderilmedi.
    assert.ok(
      alinan < uretilen / 4,
      `alınan ${alinan} bayt, üretilen ${uretilen} baytın çeyreğinden az olmalı`,
    );
    soket.destroy();
  });
});
