import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { kapsamIcindeMi } from "../src/store/fsops.js";
import { tmpKok, makeUdf } from "./yardimci.js";
import { MockUyap, opakToken, type MockDava } from "./mock-uyap/sunucu.js";
import { daemonKur } from "../src/server/daemon.js";
import { ManifestDepo } from "../src/store/manifest.js";
import { hazirlikCoz, hazirlikOzet } from "../src/store/hazirlik.js";
import { belgeIsleyicileri } from "../src/server/belgeler.js";

test("kapsam denetimi eksik alt dizin ve dosya symlink kaçışını reddeder", () => {
  const a = tmpKok(), b = tmpKok();
  try {
    symlinkSync(b.kok, join(a.kok, "disari"));
    writeFileSync(join(b.kok, "veri"), "özel");
    symlinkSync(join(b.kok, "veri"), join(a.kok, "link"));
    assert.equal(kapsamIcindeMi(a.kok, join(a.kok, "disari/yeni/evrak")), false);
    assert.equal(kapsamIcindeMi(a.kok, join(a.kok, "link")), false);
    assert.equal(kapsamIcindeMi(a.kok, join(a.kok, "yeni/evrak")), true);
  } finally { a.temizle(); b.temizle(); }
});

for (const numara of ["", "42"]) test(`aynı adlı iki evrak ayrı saklanır; MD korunur (numara=${numara})`, async () => {
  const a = tmpKok(), k = tmpKok();
  const dava: MockDava = {
    dosyaId: opakToken("collision"), birimAdi: "Test Mahkemesi", birimId: "7000",
    esasNo: "2026/99", dosyaTur: "Hukuk Dava Dosyası", dosyaDurum: "Açık", yargiTuru: "0",
    evraklar: ["Birinci belge", "İkinci belge"].map((metin, i) => ({
      evrakId: opakToken(`evrak-${i}`), tur: "Cevap Dilekçesi", gonderen: "Test", tip: "GLN",
      tarih: "01/09/2026", birimEvrakNo: numara, durum: "yuklu", contentTipi: "application/octet-stream", icerik: makeUdf([metin]),
    })),
  };
  const mock = new MockUyap({ birimler: [{ birimId: "7000", birimAdi: dava.birimAdi, yargiTuru: "0" }], davalar: [dava] });
  await mock.baslat();
  const d = daemonKur({ ayarDir: a.kok, kok: k.kok, portalUrl: mock.adres(), istekAralikMs: 1, oturumYenileMs: 0 });
  const bekle = async (id: string) => {
    for (let i = 0; i < 200; i++) {
      const is = d.orkestrator.isGetir(id)!;
      if (is.durum === "hazir" || is.durum === "hata") { assert.equal(is.durum, "hazir", JSON.stringify(is.hata)); return; }
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("iş bitmedi");
  };
  try {
    await d.rpc.baslat();
    d.oturum.girisYap("JSESSIONID=collision", "manuel");
    const ilk = await d.isleyiciler.get("klonla")!({ birim: dava.birimAdi, esas: dava.esasNo, kapsam: "hepsi" }) as { isId: string };
    await bekle(ilk.isId);
    const kayit = d.registry.oku().davalar[0]!;
    const depo = new ManifestDepo(join(kayit.klonYolu!, "uyap-project.json"));
    const m = depo.oku()!;
    assert.equal(m.evraklar.length, 2);
    assert.equal(new Set(m.evraklar.map(e => e.path)).size, 2);
    assert.equal(new Set(m.evraklar.map(e => e.sha256)).size, 2);
    assert.ok(m.evraklar.every(e => e.mdStatus === "ok"));
    const md = m.evraklar.map(e => readFileSync(join(kayit.klonYolu!, e.mdPath!), "utf8"));
    assert.ok(md.some(s => s.includes("Birinci belge")) && md.some(s => s.includes("İkinci belge")));
    const ikinci = await d.isleyiciler.get("esitle")!({ caseKey: kayit.caseKey }) as { isId: string };
    await bekle(ikinci.isId);
    assert.deepEqual(depo.oku()!.evraklar.map(e => [e.path, e.mdStatus, e.mdPath]), m.evraklar.map(e => [e.path, e.mdStatus, e.mdPath]));
  } finally { await d.kapat(); await mock.durdur(); a.temizle(); k.temizle(); }
});

test("HTTP 200 hata kodlu belge dosya baytları olarak kabul edilmez", async () => {
  const { createServer } = await import("node:http");
  const { UyapIstemci } = await import("../src/uyap/client.js");
  const sunucu = createServer((_req, res) => {
    res.writeHead(200, { "uyapfc_rc": "ERROR", "content-type": "application/octet-stream" });
    res.end("portal hata mesajı");
  });
  await new Promise<void>(r => sunucu.listen(0, "127.0.0.1", r));
  try {
    const port = (sunucu.address() as { port: number }).port;
    const istemci = new UyapIstemci({ baseUrl: `http://127.0.0.1:${port}`, cookie: () => "" });
    await assert.rejects(istemci.baytlar("evrak", "dosya"), /rc=ERROR/);
  } finally { await new Promise<void>(r => sunucu.close(() => r())); }
});

// ── P15a sözleşmesi: ETİKET OKUMAK VE ÖZET HESAPLAMAK TEK BAYT YAZMAZ ──
//
// İDDİANIN SINIRI: bu test "hiçbir bayt değişmez" DEMEZ. Bir sonraki eşitleme
// manifest'i normal akışında yeniden yazar ve eski `unsupported` kayıtlar doğal
// olarak yeni değerlerini alır (orchestrator.ts:720/727) — bu göç değil, normal
// dönüşümdür. Kanıtlanan tek şey OKUMA yolunun yazmadığıdır: `evraklar`,
// `hazirlik-ozet`, `evrak-oku` ve saf yardımcılar (hazirlikCoz/hazirlikOzet,
// web/evrak-durum.js gruplaması) tek bayt değiştirmez.
function agacOzeti(kok: string): Map<string, string> {
  const harita = new Map<string, string>();
  const gez = (dizin: string) => {
    for (const g of readdirSync(dizin, { withFileTypes: true })) {
      const tam = join(dizin, g.name);
      if (g.isDirectory()) gez(tam);
      else if (g.isFile()) {
        const b = readFileSync(tam);
        harita.set(
          tam.slice(kok.length + 1),
          `${createHash("sha256").update(b).digest("hex")}:${b.length}:${statSync(tam).mtimeMs}`,
        );
      }
    }
  };
  gez(kok);
  return harita;
}

test("P15a etiket okumak ve özet hesaplamak tek bayt yazmaz", async () => {
  const a = tmpKok(),
    k = tmpKok();
  const dava: MockDava = {
    dosyaId: opakToken("okuma-yazmaz"),
    birimAdi: "Test Mahkemesi",
    birimId: "7100",
    esasNo: "2026/77",
    dosyaTur: "Hukuk Dava Dosyası",
    dosyaDurum: "Açık",
    yargiTuru: "0",
    evraklar: [
      {
        evrakId: opakToken("e-udf"),
        tur: "Dilekçe",
        gonderen: "Test",
        tip: "GLN",
        tarih: "01/09/2026",
        birimEvrakNo: "1",
        durum: "yuklu",
        contentTipi: "application/octet-stream",
        icerik: makeUdf(["Metin"]),
      },
      {
        evrakId: opakToken("e-jpg"),
        tur: "Vekaletname",
        gonderen: "Test",
        tip: "GLN",
        tarih: "02/09/2026",
        birimEvrakNo: "2",
        durum: "yuklu",
        contentTipi: "image/jpeg",
        icerik: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      },
    ],
  };
  const mock = new MockUyap({
    birimler: [{ birimId: "7100", birimAdi: dava.birimAdi, yargiTuru: "0" }],
    davalar: [dava],
  });
  await mock.baslat();
  const d = daemonKur({
    ayarDir: a.kok,
    kok: k.kok,
    portalUrl: mock.adres(),
    istekAralikMs: 1,
    oturumYenileMs: 0,
  });
  try {
    await d.rpc.baslat();
    d.oturum.girisYap("JSESSIONID=okuma", "manuel");
    const is = (await d.isleyiciler.get("klonla")!({
      birim: dava.birimAdi,
      esas: dava.esasNo,
      kapsam: "hepsi",
    })) as { isId: string };
    for (let i = 0; i < 300; i++) {
      const durum = d.orkestrator.isGetir(is.isId)!.durum;
      if (durum === "hazir") break;
      assert.notEqual(durum, "hata");
      await new Promise((r) => setTimeout(r, 10));
    }
    const kayit = d.registry.oku().davalar[0]!;
    const manifestYolu = join(kayit.klonYolu!, "uyap-project.json");

    const oncekiAgac = agacOzeti(kayit.klonYolu!);
    const oncekiManifest = readFileSync(manifestYolu);
    assert.ok(oncekiAgac.size >= 3, "en az iki kaynak + manifest");

    // 1) Motor okuma yolları
    const evraklar = (await d.isleyiciler.get("evraklar")!({
      caseKey: kayit.caseKey,
    })) as { evraklar: { mdStatus: string; path: string }[] };
    const belgeler = belgeIsleyicileri(d, k.kok, async () => {});
    const ozet = (await belgeler.get("hazirlik-ozet")!({})) as {
      ozetler: { caseKey: string; toplam: number; kullanilabilir: number }[];
    };
    assert.equal(ozet.ozetler[0]!.toplam, 2);
    assert.equal(ozet.ozetler[0]!.kullanilabilir, 2, "udf ok + jpg gorsel");
    for (const e of evraklar.evraklar)
      await belgeler.get("evrak-oku")!({ caseKey: kayit.caseKey, path: e.path });

    // 2) Saf yardımcılar (motor tarafı + web modülü)
    hazirlikOzet(evraklar.evraklar);
    for (const e of evraklar.evraklar) hazirlikCoz(e.mdStatus, e.path);
    const { evrakGruplari, evrakOzeti } = await import(
      new URL("../../web/evrak-durum.js", import.meta.url).href
    );
    evrakGruplari(evraklar.evraklar);
    evrakOzeti(evraklar.evraklar);

    // 3) Tek bayt değişmemeli — sha256, boyut ve mtimeMs dâhil.
    assert.deepEqual(
      [...agacOzeti(kayit.klonYolu!).entries()].sort(),
      [...oncekiAgac.entries()].sort(),
    );
    assert.ok(oncekiManifest.equals(readFileSync(manifestYolu)));
  } finally {
    await d.kapat();
    await mock.durdur();
    a.temizle();
    k.temizle();
  }
});

test("P15a elle yazılmış legacy/bozuk mdStatus okuma yolunda çökmez ve diskte kalır", async () => {
  const a = tmpKok(),
    k = tmpKok();
  const d = daemonKur({
    ayarDir: a.kok,
    kok: k.kok,
    portalUrl: "http://127.0.0.1:1",
    istekAralikMs: 1,
    oturumYenileMs: 0,
  });
  try {
    const klon = join(k.kok, "Eski Mahkeme", "2020-1");
    mkdirSync(klon, { recursive: true });
    const manifestYolu = join(klon, "uyap-project.json");
    // ESKİ SÜRÜMÜN yazdığı manifest: birleşik `unsupported` + uydurma değer.
    const kayitlar = [
      { path: "_kaynak/evraklar/Gelen/07-Vekalet-Idari/a.jpg", mdStatus: "unsupported" },
      { path: "_kaynak/evraklar/Gelen/03-Tebligatlar/b.pdf", mdStatus: "unsupported" },
      { path: "_kaynak/evraklar/Dosya/08-Ekler-Diger/c.zip", mdStatus: "unsupported" },
      { path: "_kaynak/evraklar/Giden/06-Mali/d.html", mdStatus: "unsupported" },
      { path: "_kaynak/evraklar/Gelen/02-Dilekceler/e.udf", mdStatus: "zort" },
    ];
    new ManifestDepo(manifestYolu).yaz({
      dosyaId: '"ESKI"',
      mahkeme: "Eski Mahkeme",
      birimId: "3",
      esasNo: "2020/1",
      isIcra: false,
      clonedAt: "2020-01-01T00:00:00.000Z",
      evraklar: kayitlar.map((r, i) => ({
        evrakId: `"E${i}"`,
        stableKey: `ana:${i}`,
        path: r.path,
        sha256: "aa",
        isEkEvrak: false,
        category: "02-Dilekceler",
        yon: "Gelen" as const,
        tur: "Evrak",
        gonderen: "X",
        tarih: "01/01/2020",
        dosyaKey: "2020/1",
        mdStatus: r.mdStatus as "ok",
      })),
    });
    d.registry.koy({
      caseKey: "Eski Mahkeme\u00002020/1",
      portal: "avukat",
      kaynak: ["portal"],
      dosyaNo: "2020/1",
      birimAdi: "Eski Mahkeme",
      birimId: "3",
      group: "Hukuk",
      kod: "SULH",
      yargiTuru: "0",
      isIcra: false,
      isCbs: false,
      kapsam: "hepsi",
      portalGoruldu: "2020-01-01T00:00:00.000Z",
      klonYolu: klon,
    });
    const once = readFileSync(manifestYolu);

    const belgeler = belgeIsleyicileri(d, k.kok, async () => {});
    const ozet = (await belgeler.get("hazirlik-ozet")!({})) as {
      ozetler: { toplam: number; kullanilabilir: number; dagilim: Record<string, number> }[];
    };
    const o = ozet.ozetler[0]!;
    assert.equal(o.toplam, 5);
    // .jpg → gorsel, .pdf → gorsel, .zip → desteklenmiyor,
    // .html → bilinmiyor (bu dal unsupported ÜRETEMEZ), "zort" → bilinmiyor
    assert.equal(o.kullanilabilir, 2);
    assert.equal(o.dagilim["desteklenmiyor"], 1);
    assert.equal(o.dagilim["bilinmiyor"], 2);

    const okunan = new ManifestDepo(manifestYolu).oku()!;
    assert.deepEqual(
      okunan.evraklar.map((e) => e.mdStatus),
      kayitlar.map((r) => r.mdStatus),
      "okuma değeri NORMALİZE ETMEMELİ",
    );
    assert.ok(once.equals(readFileSync(manifestYolu)), "manifest baytları aynen kalmalı");
  } finally {
    await d.kapat();
    a.temizle();
    k.temizle();
  }
});
