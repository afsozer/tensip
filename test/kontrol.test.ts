// İş kontrol testleri: duraklat / devam / iptal + web panosu.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { MockUyap, opakToken } from "./mock-uyap/sunucu.js";
import { daemonKur, webPanosuBaslat, type Daemon } from "../src/server/daemon.js";
import { makeUdf, tmpKok } from "./yardimci.js";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

describe("iş kontrolleri", () => {
  const mock = new MockUyap({
    birimler: [{ birimId: "5000", birimAdi: "Kontrol Test Mahkemesi", yargiTuru: "0" }],
    davalar: [
      {
        dosyaId: opakToken("k-dosya"),
        birimAdi: "Kontrol Test Mahkemesi",
        birimId: "5000",
        esasNo: "2026/50",
        dosyaTur: "Hukuk Dava Dosyası",
        dosyaDurum: "Açık",
        yargiTuru: "0",
        evraklar: Array.from({ length: 30 }, (_, i) => ({
          evrakId: opakToken(`k-evrak-${i}`),
          tur: "Dilekçe",
          gonderen: "Av. K",
          tip: "GLN",
          tarih: "0" + ((i % 9) + 1) + "/09/2026",
          birimEvrakNo: String(100 + i),
          durum: "yuklu" as const,
          contentTipi: "application/octet-stream",
          icerik: makeUdf([`Dilekçe ${i}`, "İçerik."]),
        })),
      },
    ],
  });
  const ayar = tmpKok();
  const kok = tmpKok();
  let daemon: Daemon;

  before(async () => {
    await mock.baslat();
    daemon = daemonKur({
      ayarDir: ayar.kok,
      kok: kok.kok,
      portalUrl: mock.adres(),
      appVersion: "test",
      istekAralikMs: 60, // yavaşlat: duraklatma penceresi
      gunlukTavan: 200,
    });
    await daemon.rpc.baslat();
  });

  after(async () => {
    await daemon.kapat();
    await mock.durdur();
    ayar.temizle();
    kok.temizle();
  });

  const h = (ad: string) => daemon.isleyiciler.get(ad)!;

  async function isDurum(isId: string): Promise<Record<string, unknown>> {
    return (await h("is")({ isId })) as Record<string, unknown>;
  }

  test("duraklat → duraklatildi → devam → hazir", async () => {
    await h("giris")({ cerez: "JSESSIONID=duraklat123; x=1" });
    const son = (await h("klonla")({
      birim: "Kontrol Test Mahkemesi",
      esas: "2026/50",
      kapsam: "hepsi",
      avukat: "K AVUKAT",
    })) as { isId: string };
    // bitmesini beklemeden duraklat
    await new Promise((c) => setTimeout(c, 150));
    const duraklatildi = (await h("duraklat")({ isId: son.isId })) as { ok: boolean };
    assert.equal(duraklatildi.ok, true);
    // duraklatılmış duruma geçmesini bekle
    for (let i = 0; i < 100; i++) {
      const is = await isDurum(son.isId);
      if (is.durum === "duraklatildi") break;
      if (is.durum === "hazir" || is.durum === "hata") assert.fail(`erken bitti: ${is.durum}`);
      await new Promise((c) => setTimeout(c, 50));
    }
    const duraklatilan = await isDurum(son.isId);
    assert.equal(duraklatilan.durum, "duraklatildi");

    const devam = (await h("devam")({ isId: son.isId })) as { isId: string; ok?: boolean };
    assert.ok(devam.isId !== son.isId, "yeni iş açılır");
    for (let i = 0; i < 200; i++) {
      const is = await isDurum(devam.isId);
      if (is.durum === "hazir") break;
      if (is.durum === "hata") assert.fail(`hata: ${JSON.stringify(is.hata)}`);
      await new Promise((c) => setTimeout(c, 50));
    }
    const bitis = await isDurum(devam.isId);
    assert.equal(bitis.durum, "hazir");
    const evrak = (await h("evraklar")({
      caseKey: "Kontrol Test Mahkemesi\u00002026/50",
    })) as { adet: number };
    assert.equal(evrak.adet, 30);
  });

  test("iptal → iptal durumu", async () => {
    // ikinci bir dava yok; aynı davayı yeniden klonla yavaş iş başlatır
    // ama dava meşgul kilidi aynı caseKey için zaten serbest (önceki bitti)
    const son = (await h("klonla")({
      birim: "Kontrol Test Mahkemesi",
      esas: "2026/50",
      kapsam: "hepsi",
      avukat: "K AVUKAT",
    })) as { isId: string };
    await new Promise((c) => setTimeout(c, 100));
    await h("iptal")({ isId: son.isId });
    for (let i = 0; i < 100; i++) {
      const is = await isDurum(son.isId);
      if (is.durum === "iptal" || is.durum === "hazir") {
        assert.equal(is.durum, "iptal", `beklenmedik bitiş: ${is.durum}`);
        break;
      }
      await new Promise((c) => setTimeout(c, 50));
    }
  });
});

describe("web panosu", () => {
  const ayar = tmpKok();
  const kok = tmpKok();
  let daemon: Daemon;
  let adres = "";
  let csrf = "";

  before(async () => {
    daemon = daemonKur({ ayarDir: ayar.kok, kok: kok.kok, appVersion: "test", istekAralikMs: 5 });
    await daemon.rpc.baslat();
    adres = await webPanosuBaslat(daemon, 0, "test", "https://mock", kok.kok);
    const html = await (await fetch(adres)).text();
    csrf = html.match(/name="csrf-token" content="([^"]+)"/)?.[1] ?? "";
    assert.ok(csrf.length > 20);
  });

  const api = (ad: string, govde: unknown = {}) =>
    fetch(`${adres}/api/${ad}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": csrf, origin: adres },
      body: JSON.stringify(govde),
    });

  after(async () => {
    await daemon.kapat();
    ayar.temizle();
    kok.temizle();
  });

  test("pano HTML döner", async () => {
    const r = await fetch(adres + "/");
    assert.equal(r.status, 200);
    const metin = await r.text();
    assert.ok(metin.includes("Tensip"));
    assert.ok(metin.includes('name="csrf-token"'));
    assert.ok(metin.includes('src="/app.js"'));
  });

  test("durum yalnız POST /api/durum ile okunur", async () => {
    const r = await api("durum");
    assert.equal(r.status, 200);
    const d = (await r.json()) as { ok?: boolean; data?: { kok?: string; oturum?: unknown } };
    assert.equal(d.ok, true);
    assert.ok(d.data?.kok !== undefined);
    assert.ok(d.data?.oturum !== undefined);
  });

  test("eski salt-okunur GET yolları kaldırıldı (CSRF'siz yüzey yok)", async () => {
    // Bu yollar CSRF anahtarı istemiyordu; /durum oturum varken portala probe
    // tetikleyebiliyordu. UI yalnız POST /api/* kullanıyor.
    for (const yol of ["/durum", "/davalar", "/durusmalar", "/isler", "/sorunlar"]) {
      const r = await fetch(adres + yol);
      assert.equal(r.status, 404, `${yol} 404 dönmeli`);
      const d = (await r.json()) as { error?: { code?: string } };
      assert.equal(d.error?.code, "NOT_FOUND");
    }
  });

  test("/health daemon instanceId kimliğini taşır", async () => {
    const r = await fetch(adres + "/health");
    const d = await r.json() as { ok?: boolean; app?: string; apiVersion?: number; instanceId?: string };
    assert.equal(d.ok, true);
    assert.equal(d.app, "tensip");
    assert.equal(d.apiVersion, 1);
    assert.equal(d.instanceId, daemon.rpc.bilgiGetir()?.instanceId);
  });

  test("oturumsuz duruşma sorgusu boş liste yerine hata döndürür", async () => {
    const r = await api("durusmalar");
    assert.equal(r.status, 401);
    const d = (await r.json()) as { error?: { code: string }; data?: { durusmalar?: unknown } };
    assert.equal(d.error?.code, "LOGIN_REQUIRED");
    assert.equal(d.data?.durusmalar, undefined);
  });

  test("mutasyon ucu yok (POST 405)", async () => {
    const r = await fetch(adres + "/davalar", { method: "POST" });
    assert.equal(r.status, 405);
  });

  // ── Madde 4: Host denetimi + güvenlik başlıkları ──
  /** Host başlığını elle set eden ham istek (fetch Host'i kendisi yazar). */
  function hamIstek(yol: string, host: string | undefined): Promise<{ durum: number; basliklar: Record<string, string | string[] | undefined>; govde: string }> {
    const u = new URL(adres);
    return new Promise((coz, red) => {
      const istek = request(
        { hostname: u.hostname, port: Number(u.port), path: yol, method: "GET",
          headers: host !== undefined ? { host } : {} },
        (res) => {
          const parcalar: Buffer[] = [];
          res.on("data", (c: Buffer) => parcalar.push(c));
          res.on("end", () => {
            coz({ durum: res.statusCode ?? 0, basliklar: res.headers, govde: Buffer.concat(parcalar).toString("utf8") });
          });
        }
      );
      istek.on("error", red);
      istek.end();
    });
  }

  test("yabancı Host → 403 (DNS rebinding koruması)", async () => {
    const u = new URL(adres);
    const r = await hamIstek("/davalar", "evil.example");
    assert.equal(r.durum, 403);
    assert.ok(r.govde.includes("HOST_FORBIDDEN"));
    // portu yanlış vermiş hali de reddedilir
    const r2 = await hamIstek("/", `127.0.0.1:${Number(u.port) + 1}`);
    assert.equal(r2.durum, 403);
  });

  test("doğru Host → 200 + no-store + nosniff", async () => {
    const u = new URL(adres);
    const r = await hamIstek("/health", `127.0.0.1:${u.port}`);
    assert.equal(r.durum, 200);
    assert.equal(String(r.basliklar["cache-control"]), "no-store");
    assert.equal(String(r.basliklar["x-content-type-options"]), "nosniff");
    const r2 = await hamIstek("/", `localhost:${u.port}`);
    assert.equal(r2.durum, 200);
  });
});

// P06b incelemesi koşamadan (OAuth düştü) teslim edilen dosyada 7 HAM NUL
// baytı bulundu: `test/p06b.test.ts` `file(1)` tarafından "data" sayılıyor,
// `grep` dosyayı ikili sanıp hiç okumuyordu. Kural projede zaten vardı
// ("kaynakta ham NUL bırakma, kaçış dizisi kullan") ama bekçisi yoktu —
// yalnız üretilen HTML'e sızmasını sınayan bir test vardı (arsiv-ui).
// Ayırıcı olarak NUL KULLANILABİLİR (caseKey ve grup anahtarları öyle);
// yasak olan onu kaynağa HAM yazmaktır — `\u0000` yazılır.
test("kaynak ağacında HAM NUL baytı yok (kaçış dizisi kullanılır)", () => {
  const kok = new URL("../../", import.meta.url).pathname;
  const atla = new Set(["node_modules", "dist", ".git", "coverage"]);
  const suclular: string[] = [];
  const gez = (dizin: string): void => {
    for (const g of readdirSync(dizin, { withFileTypes: true })) {
      if (atla.has(g.name)) continue;
      const yol = join(dizin, g.name);
      if (g.isDirectory()) { gez(yol); continue; }
      if (!/\.(ts|js|mjs|json|md|css|html)$/.test(g.name)) continue;
      if (readFileSync(yol).includes(0)) suclular.push(yol.slice(kok.length));
    }
  };
  gez(kok);
  assert.deepEqual(suclular, [], `ham NUL taşıyan dosya: ${suclular.join(", ")}`);
});
