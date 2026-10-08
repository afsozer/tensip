import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import {
  writeFileSync,
  symlinkSync,
  realpathSync,
  readFileSync,
  mkdirSync,
  rmSync,
  chmodSync,
  existsSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { daemonKur, type Daemon } from "../src/server/daemon.js";
import { panoSunucu } from "../src/server/web.js";
import { MockUyap, opakToken } from "./mock-uyap/sunucu.js";
import { tmpKok, makeUdf } from "./yardimci.js";
import { ManifestDepo } from "../src/store/manifest.js";

const ayar = tmpKok(),
  kok = tmpKok(),
  dis = tmpKok();
const mock = new MockUyap({
  birimler: [{ birimId: "7000", birimAdi: "Test Mahkemesi", yargiTuru: "0" }],
  davalar: [
    {
      dosyaId: opakToken("web-case"),
      birimAdi: "Test Mahkemesi",
      birimId: "7000",
      esasNo: "2026/99",
      dosyaTur: "Hukuk Dava Dosyası",
      dosyaDurum: "Açık",
      yargiTuru: "0",
      evraklar: [
        {
          evrakId: opakToken("web-document"),
          tur: "Dilekçe",
          gonderen: "Test",
          tip: "GLN",
          tarih: "01/09/2026",
          birimEvrakNo: "42",
          durum: "yuklu",
          contentTipi: "application/octet-stream",
          icerik: makeUdf([
            "<script>önizleme kod çalıştırmaz</script>",
            "Örnek belge.",
          ]),
        },
      ],
    },
  ],
});
let d: Daemon,
  s: ReturnType<typeof panoSunucu>,
  url = "",
  token = "";
const acilan: string[] = [];
before(async () => {
  await mock.baslat();
  d = daemonKur({
    ayarDir: ayar.kok,
    kok: kok.kok,
    portalUrl: mock.adres(),
    istekAralikMs: 1,
    oturumYenileMs: 0,
  });
  await d.rpc.baslat();
  s = panoSunucu(d, "test", mock.adres(), kok.kok, {
    dosyaAc: async (yol) => {
      acilan.push(yol);
    },
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(s.address() as { port: number }).port}`;
  const html = await (await fetch(url)).text();
  token = html.match(/name="csrf-token" content="([^"]+)"/)?.[1] ?? "";
  assert.ok(token.length > 20);
});
after(async () => {
  await new Promise<void>((r) => {
    s.close(() => r());
    s.closeAllConnections();
  });
  await d.kapat();
  await mock.durdur();
  ayar.temizle();
  kok.temizle();
  dis.temizle();
});
async function api(
  ad: string,
  body: unknown = {},
  headers: Record<string, string> = {},
) {
  return fetch(url + "/api/" + ad, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": token,
      origin: url,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}
test("yerel API yabancı kökeni, eksik anahtarı, bozuk gövdeyi ve bilinmeyen işlemi reddeder", async () => {
  assert.equal(
    (await api("durum", {}, { origin: "https://evil.example" })).status,
    403,
  );
  assert.equal((await api("durum", {}, { "x-csrf-token": "" })).status, 403);
  assert.equal(
    (await api("durum", {}, { "x-csrf-token": "ü".repeat(64) })).status,
    403,
  );
  assert.equal((await api("durum", [])).status, 400);
  assert.equal(
    (await api("durum", {}, { "content-type": "text/plain" })).status,
    400,
  );
  assert.equal((await api("bilinmeyen")).status, 404);
  assert.equal((await fetch(url + "/api/cikis")).status, 405);
  assert.equal((await fetch(url + "/../package.json")).status, 404);
  const r = await fetch(url);
  assert.ok(
    r.headers
      .get("content-security-policy")
      ?.includes("frame-ancestors 'none'"),
  );
});
test("UI durum yenilemeleri portala probe atmaz ve UYAP çerezi/RPC anahtarı sızdırmaz", async () => {
  d.oturum.girisYap("JSESSIONID=web-secret", "manuel");
  let probed = false;
  const eski = d.oturum.probeTaze;
  d.oturum.probeTaze = async () => {
    probed = true;
    return "aktif";
  };
  try {
    for (let i = 0; i < 3; i++) {
      const r = await api("durum");
      assert.equal(r.status, 200);
      const text = await r.text();
      assert.ok(text.includes("aktif"));
      assert.ok(!text.includes("web-secret"));
      assert.ok(!text.includes(d.rpc.bilgiGetir()!.token));
    }
    assert.equal(probed, false);
  } finally {
    d.oturum.probeTaze = eski;
  }
});
test("UI arama → indir → oku → oturumsuz oku → aynı davayı tekrar indir eylemi eşitler", async () => {
  const arama = (await (
    await api("davalarim", { birim: "Test Mahkemesi", yil: "2026", sira: "99" })
  ).json()) as any;
  assert.equal(arama.data.adet, 1);
  async function bekle(id: string) {
    for (let i = 0; i < 300; i++) {
      const is = d.orkestrator.isGetir(id)!;
      if (["hazir", "hata"].includes(is.durum)) {
        assert.equal(is.durum, "hazir", JSON.stringify(is.hata));
        return;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("İş bitmedi");
  }
  const ilk = (await (
    await api("klonla", { birim: "Test Mahkemesi", esas: "2026/99" })
  ).json()) as any;
  await bekle(ilk.data.isId);
  const kayit = d.registry.oku().davalar[0]!;
  const belge = new ManifestDepo(
    join(kayit.klonYolu!, "uyap-project.json"),
  ).oku()!.evraklar[0]!;
  const param = { caseKey: kayit.caseKey, path: belge.path };
  const yanit = (await (await api("evrak-oku", param)).json()) as any;
  assert.ok(yanit.data.metin.includes("Örnek belge."));
  assert.equal((await api("evrak-ac", param)).status, 200);
  assert.equal(acilan.length, 1);
  assert.equal(acilan[0], realpathSync(join(kayit.klonYolu!, belge.path)));
  d.oturum.cikis();
  assert.equal((await api("evrak-oku", param)).status, 200);
  assert.equal(
    (await api("klonla", { birim: "Test Mahkemesi", esas: "2026/99" })).status,
    401,
  );
  d.oturum.girisYap("JSESSIONID=again", "manuel");
  const ikinci = (await (
    await api("klonla", { birim: "Test Mahkemesi", esas: "2026/99" })
  ).json()) as any;
  assert.equal(d.orkestrator.isGetir(ikinci.data.isId)!.tur, "esitle");
  await bekle(ikinci.data.isId);
  assert.equal(d.registry.oku().davalar.length, 1);
});
test("belge erişimi kayıt dışı yolları, bozuk manifest symlinkini ve MD kaçışını reddeder", async () => {
  const kayit = d.registry.oku().davalar[0]!;
  assert.equal(
    (
      await api("evrak-oku", {
        caseKey: kayit.caseKey,
        path: "../../../etc/passwd",
      })
    ).status,
    404,
  );
  const depo = new ManifestDepo(join(kayit.klonYolu!, "uyap-project.json"));
  const m = depo.oku()!;
  const e = m.evraklar[0]!;
  const onceki = e.mdPath;
  writeFileSync(join(dis.kok, "secret"), "SECRET");
  symlinkSync(join(dis.kok, "secret"), join(kayit.klonYolu!, "escape"));
  e.mdPath = "escape";
  depo.yaz(m);
  const r = await api("evrak-oku", { caseKey: kayit.caseKey, path: e.path });
  assert.equal(r.status, 403);
  assert.ok(!(await r.text()).includes("SECRET"));
  e.mdPath = onceki;
  depo.yaz(m);
});

test("P02 web modülü aynı kökenden JS olarak sunulur; keyfi web yolları açılmaz", async () => {
  const response = await fetch(url + "/portal.js");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /javascript/);
  assert.match(await response.text(), /export function portalSonuclari/);
  assert.equal((await fetch(url + "/portal-private.js")).status, 404);
});

// P08c: app.js artık tek dosya değil. Varlık izin listesine (src/server/web.ts
// `varliklar`) eklenmeyen bir modül 404 döner ve sayfa tamamen boş açılır; bu
// testin işi tam olarak o hatayı yakalamaktır.
test("P08c app.js'in import ettiği her web modülü aynı izin listesinden sunulur", async () => {
  const gorulen = new Set(["/app.js"]);
  const kuyruk = ["/app.js"];
  while (kuyruk.length) {
    const yol = kuyruk.shift()!;
    const r = await fetch(url + yol);
    assert.equal(r.status, 200, `${yol} sunulmuyor (izin listesinde yok mu?)`);
    assert.match(r.headers.get("content-type") ?? "", /javascript/, yol);
    const metin = await r.text();
    for (const m of metin.matchAll(/\bfrom\s+"\.\/([A-Za-z0-9._-]+\.js)"/g)) {
      const hedef = `/${m[1]}`;
      if (!gorulen.has(hedef)) {
        gorulen.add(hedef);
        kuyruk.push(hedef);
      }
    }
  }
  // Ayrım sonrası beklenen modül kümesi; yeni modül eklenirse burası büyür.
  for (const beklenen of [
    "/ortak.js",
    "/arsiv.js",
    "/evrak-durum.js",
    "/isler.js",
    "/ajanda.js",
    "/toplu.js",
    "/portal.js",
    // P07b — safahat/taraflar/hesap sekmelerinin çizimi.
    "/detay.js",
  ])
    assert.ok(
      gorulen.has(beklenen),
      `${beklenen} app.js'ten ulaşılamıyor: ${[...gorulen].join(", ")}`,
    );
});

// ── P15a: hazırlık özeti ve uzantı reddi metinleri ────────────────────

test("P15a hazirlik-ozet izin listesinde, CSRF ister ve manifest sayısını raporlar", async () => {
  assert.equal((await api("hazirlik-ozet", {}, { "x-csrf-token": "" })).status, 403);
  const kayit = d.registry.oku().davalar[0]!;
  const r = await api("hazirlik-ozet");
  assert.equal(r.status, 200);
  const gelen = (await r.json()) as {
    data: { ozetler: { caseKey: string; toplam: number; kullanilabilir: number }[] };
  };
  const o = gelen.data.ozetler.find((x) => x.caseKey === kayit.caseKey)!;
  assert.ok(o, "klonlanmış dava özette olmalı");
  // TUTARLILIK (P15a kabul ölçütü): özetin toplamı `evraklar` RPC'sinin adedi.
  const ev = (await (await api("evraklar", { caseKey: kayit.caseKey })).json()) as {
    data: { adet: number };
  };
  assert.equal(o.toplam, ev.data.adet);
  assert.equal(o.kullanilabilir, 1);
});

test("P15b evraklar yanıtı sonEsitleme taşır; hazirlik-ozet aynı sayacı verir", async () => {
  const kayit = d.registry.oku().davalar[0]!;
  const m = new ManifestDepo(join(kayit.klonYolu!, "uyap-project.json")).oku()!;
  const ev = (await (await api("evraklar", { caseKey: kayit.caseKey })).json()) as {
    data: { adet: number; evraklar: unknown[]; sonEsitleme: { esitlemeId: string; ilkIndirme: boolean } | null };
  };
  // Yanıt yalnız ALAN EKLER: `adet` ve `evraklar` anlamı değişmedi.
  assert.equal(ev.data.adet, m.evraklar.length);
  assert.equal(ev.data.evraklar.length, m.evraklar.length);
  // İşaretçi evrak listesiyle AYNI yanıtta gelmeli; ayrı çağrı iki farklı
  // eşitlemeye ait olabilir ve rozet yanlış satıra düşerdi.
  assert.deepEqual(ev.data.sonEsitleme, m.sonEsitleme ?? null);
  assert.equal(typeof ev.data.sonEsitleme!.esitlemeId, "string");

  // Dava satırı sayacı için İKİNCİ BİR RPC EKLENMEDİ: sayaç zaten her manifesti
  // açan `hazirlik-ozet` yanıtından gelir (ek dosya okuması sıfır).
  const ozet = (await (await api("hazirlik-ozet")).json()) as {
    data: { ozetler: { caseKey: string; yeni: number; yenilenen: number }[] };
  };
  const o = ozet.data.ozetler.find((x) => x.caseKey === kayit.caseKey)!;
  const rozetli = m.evraklar.filter((e) => e.indirmeDamgasi?.esitlemeId === m.sonEsitleme?.esitlemeId).length;
  assert.equal(o.yeni + o.yenilenen, m.sonEsitleme!.ilkIndirme ? 0 : rozetli);
});

test("P15a bayat sonEvrakSayisi özeti bozmaz ve registry'ye yazılmaz", async () => {
  const kayit = d.registry.oku().davalar[0]!;
  const once = kayit.sonEvrakSayisi;
  kayit.sonEvrakSayisi = 999; // registry sayacı BAYAT: duraklamış işte hiç yazılmaz
  d.registry.koy(kayit);
  try {
    const gelen = (await (await api("hazirlik-ozet")).json()) as {
      data: { ozetler: { caseKey: string; toplam: number }[] };
    };
    const o = gelen.data.ozetler.find((x) => x.caseKey === kayit.caseKey)!;
    assert.equal(o.toplam, 1, "özetin kaynağı manifest, registry değil");
    // Özet hesaplamak registry'yi DÜZELTMEZ; türetilmiş veri geri yazılmaz.
    assert.equal(d.registry.oku().davalar[0]!.sonEvrakSayisi, 999);
  } finally {
    kayit.sonEvrakSayisi = once;
    d.registry.koy(kayit);
  }
});

test("P15a bozuk manifest çağrıyı düşürmez; diğer davanın özeti kaybolmaz", async () => {
  const kayit = d.registry.oku().davalar[0]!;
  const manifestYolu = join(kayit.klonYolu!, "uyap-project.json");
  const yedek = readFileSync(manifestYolu);
  // İkinci, sağlam bir dava kaydı: bozuk manifest hepsini düşürüyor mu?
  const ikinciKlon = join(kok.kok, "Ikinci Mahkeme", "2026-5");
  mkdirSync(ikinciKlon, { recursive: true });
  new ManifestDepo(join(ikinciKlon, "uyap-project.json")).yaz({
    dosyaId: '"IK"',
    mahkeme: "Ikinci Mahkeme",
    birimId: "2",
    esasNo: "2026/5",
    isIcra: false,
    clonedAt: new Date().toISOString(),
    evraklar: [
      {
        evrakId: '"A"',
        stableKey: "ana:1",
        path: "_kaynak/evraklar/Gelen/07-Vekalet-Idari/a.jpg",
        sha256: "aa",
        isEkEvrak: false,
        category: "07-Vekalet-Idari",
        yon: "Gelen",
        tur: "Vekaletname",
        gonderen: "X",
        tarih: "01/09/2026",
        dosyaKey: "2026/5",
        // Eski birleşik değer: türetme .jpg üzerinden `gorsel` demeli.
        mdStatus: "unsupported",
      },
    ],
  });
  d.registry.koy({
    ...kayit,
    caseKey: "Ikinci Mahkeme\u00002026/5",
    birimAdi: "Ikinci Mahkeme",
    dosyaNo: "2026/5",
    klonYolu: ikinciKlon,
    sonEvrakSayisi: undefined,
  });
  writeFileSync(manifestYolu, "{ bozuk json");
  try {
    const r = await api("hazirlik-ozet");
    assert.equal(r.status, 200, "tek bozuk manifest bütün çağrıyı düşürmemeli");
    const gelen = (await r.json()) as {
      data: {
        ozetler: {
          caseKey: string;
          okunamadi?: boolean;
          toplam?: number;
          kullanilabilir?: number;
        }[];
      };
    };
    const bozuk = gelen.data.ozetler.find((x) => x.caseKey === kayit.caseKey)!;
    assert.equal(bozuk.okunamadi, true);
    const saglam = gelen.data.ozetler.find((x) => x.caseKey === "Ikinci Mahkeme\u00002026/5")!;
    assert.deepEqual([saglam.toplam, saglam.kullanilabilir], [1, 1], "unsupported+.jpg → gorsel");
  } finally {
    writeFileSync(manifestYolu, yedek);
    const v = d.registry.oku();
    v.davalar = v.davalar.filter((x) => x.caseKey !== "Ikinci Mahkeme\u00002026/5");
    d.registry.yaz();
  }
});

test("P15a evrak-ac reddi gerçek sebebi söyler; .html/.zip/.bin açılmaz", async () => {
  const kayit = d.registry.oku().davalar[0]!;
  const depo = new ManifestDepo(join(kayit.klonYolu!, "uyap-project.json"));
  const m = depo.oku()!;
  const yedek = m.evraklar.slice();
  const ornek = m.evraklar[0]!;
  const dizin = join(kayit.klonYolu!, "_kaynak", "evraklar", "Dosya", "08-Ekler-Diger");
  mkdirSync(dizin, { recursive: true });
  for (const [uz, veri] of [
    ["html", "<html><body>pul</body></html>"],
    ["zip", "PKham"],
    ["bin", "ham"],
  ] as const) {
    writeFileSync(join(dizin, `ek.${uz}`), veri);
    m.evraklar.push({
      ...ornek,
      evrakId: `"EK-${uz}"`,
      stableKey: `ana:${uz}`,
      path: `_kaynak/evraklar/Dosya/08-Ekler-Diger/ek.${uz}`,
      mdPath: undefined,
      mdStatus: "desteklenmiyor",
    });
  }
  depo.yaz(m);
  try {
    const mesaj = async (uz: string) => {
      const r = await api("evrak-ac", {
        caseKey: kayit.caseKey,
        path: `_kaynak/evraklar/Dosya/08-Ekler-Diger/ek.${uz}`,
      });
      assert.equal(r.status, 400, uz);
      return ((await r.json()) as { error: { message: string } }).error.message;
    };
    const oncekiAcilan = acilan.length;
    assert.match(await mesaj("html"), /HTML/);
    assert.match(await mesaj("zip"), /arşiv dosyası/);
    assert.match(await mesaj("bin"), /tanınmayan bir biçimde/);
    // GÜVENLİK: hiçbiri /usr/bin/open yoluna ulaşmadı.
    assert.equal(acilan.length, oncekiAcilan);
  } finally {
    m.evraklar = yedek;
    depo.yaz(m);
  }
});

test("P15a evrak-oku türetilmiş hazirlik alanını taşır", async () => {
  const kayit = d.registry.oku().davalar[0]!;
  const depo = new ManifestDepo(join(kayit.klonYolu!, "uyap-project.json"));
  const m = depo.oku()!;
  const e = m.evraklar[0]!;
  const r = (await (
    await api("evrak-oku", { caseKey: kayit.caseKey, path: e.path })
  ).json()) as { data: { mdStatus: string; hazirlik: string } };
  assert.equal(r.data.mdStatus, "ok");
  assert.equal(r.data.hazirlik, "ok");
});

test("P15a hazirlik-ozet maliyeti: 40 dava × 150 kayıt ÖLÇÜLÜR", async () => {
  const eklenen: string[] = [];
  for (let i = 0; i < 40; i++) {
    const caseKey = `Olcum Mahkemesi ${i}\u00002026/${i}`;
    const klon = join(kok.kok, `olcum-${i}`);
    mkdirSync(klon, { recursive: true });
    new ManifestDepo(join(klon, "uyap-project.json")).yaz({
      dosyaId: `"O${i}"`,
      mahkeme: `Olcum Mahkemesi ${i}`,
      birimId: "9",
      esasNo: `2026/${i}`,
      isIcra: false,
      clonedAt: new Date().toISOString(),
      evraklar: Array.from({ length: 150 }, (_, j) => ({
        evrakId: `"O${i}-${j}"`,
        stableKey: `ana:${j}`,
        path: `_kaynak/evraklar/Gelen/02-Dilekceler/${j}.${["udf", "pdf", "jpg", "zip"][j % 4]}`,
        sha256: "aa",
        isEkEvrak: false,
        category: "02-Dilekceler",
        yon: "Gelen" as const,
        tur: "Dilekçe",
        gonderen: "X",
        tarih: "01/09/2026",
        dosyaKey: `2026/${i}`,
        mdStatus: (["ok", "unsupported", "gorsel", "bekliyor"] as const)[j % 4]!,
      })),
    });
    d.registry.koy({
      ...d.registry.oku().davalar[0]!,
      caseKey,
      birimAdi: `Olcum Mahkemesi ${i}`,
      dosyaNo: `2026/${i}`,
      klonYolu: klon,
    });
    eklenen.push(caseKey);
  }
  try {
    const t0 = performance.now();
    const r = await api("hazirlik-ozet");
    const sure = performance.now() - t0;
    assert.equal(r.status, 200);
    const gelen = (await r.json()) as {
      data: { ozetler: { caseKey: string; toplam?: number; kullanilabilir?: number }[] };
    };
    const ilk = gelen.data.ozetler.find((x) => x.caseKey === eklenen[0])!;
    assert.equal(ilk.toplam, 150);
    // ok(38) + gorsel(37) + unsupported→.pdf→gorsel(38) = 113
    assert.equal(ilk.kullanilabilir, 113);
    console.log(`  ℹ hazirlik-ozet 40 dava × 150 kayıt (6.000 kayıt): ${sure.toFixed(1)} ms`);
    // Gevşek tavan: ölçüm bunun çok altında; amaç regresyon yakalamak.
    assert.ok(sure < 3000, `hazirlik-ozet çok yavaş: ${sure.toFixed(1)} ms`);
  } finally {
    const v = d.registry.oku();
    v.davalar = v.davalar.filter((x) => !eklenen.includes(x.caseKey));
    d.registry.yaz();
  }
});


// ── P15c: kaynak durumu (manifestte kayıtlı, diskte var mı?) ──────────
//
// SINIR: bu bir DENETİM DEĞİLDİR (P06a). Hash doğrulanmaz, yetim dosya
// aranmaz; tek soru "kayıtlı yol diskte var mı?"dır. Aşağıdaki testlerin işi
// üç şeyi kilitlemek: (1) ölçüm hiçbir bayt yazmaz ve portala hiç gitmez,
// (2) "yok" ile "erişilemedi" ASLA aynı cevaba düşmez, (3) hata gövdeleri
// mutlak arşiv yolu sızdırmaz.
describe("P15c kaynak durumu", () => {
  const kayitAl = () => d.registry.oku().davalar[0]!;
  const evrakAl = () =>
    new ManifestDepo(join(kayitAl().klonYolu!, "uyap-project.json")).oku()!
      .evraklar[0]!;
  const satirlar = async (govde: Record<string, unknown> = {}) => {
    const kayit = kayitAl();
    const r = await api("evraklar", { caseKey: kayit.caseKey, ...govde });
    assert.equal(r.status, 200);
    return ((await r.json()) as {
      data: { adet: number; evraklar: { path: string; kaynakDurum: string }[] };
    }).data;
  };

  test("her satır kaynak durumu taşır; ölçüm oturumsuzdur ve portala gitmez", async () => {
    const kayit = kayitAl();
    const e = evrakAl();
    const yol = join(kayit.klonYolu!, e.path);

    const oncekiIstek = mock.istekler.length;
    const tam = await satirlar();
    assert.ok(tam.evraklar.length > 0);
    for (const s of tam.evraklar)
      assert.equal(s.kaynakDurum, "var", `${s.path} "var" olmalıydı`);
    // `adet` anlamı DEĞİŞMEDİ: alan eklendi, satır sayısı değil.
    assert.equal(tam.adet, tam.evraklar.length);

    const yedek = readFileSync(yol);
    rmSync(yol);
    try {
      const eksik = await satirlar();
      const satir = eksik.evraklar.find((x) => x.path === e.path)!;
      assert.equal(satir.kaynakDurum, "yok");
      for (const s of eksik.evraklar)
        if (s.path !== e.path) assert.equal(s.kaynakDurum, "var", s.path);
      // Oturum kapalıyken de AYNI cevap: ölçüm yalnız yerel diske bakar.
      d.oturum.cikis();
      const oturumsuz = await satirlar();
      assert.equal(
        oturumsuz.evraklar.find((x) => x.path === e.path)!.kaynakDurum,
        "yok",
      );
    } finally {
      writeFileSync(yol, yedek);
      d.oturum.girisYap("JSESSIONID=p15c", "manuel");
    }
    // Üç `evraklar` çağrısı boyunca portala TEK istek gitmedi.
    assert.equal(mock.istekler.length, oncekiIstek);
  });

  test("ölçüm manifest'e geri yazılmaz (rozet hiçbir baytı değiştirmez)", async () => {
    const kayit = kayitAl();
    const manifestYolu = join(kayit.klonYolu!, "uyap-project.json");
    const e = evrakAl();
    const yol = join(kayit.klonYolu!, e.path);
    const yedek = readFileSync(yol);
    const oncekiManifest = readFileSync(manifestYolu);
    rmSync(yol);
    try {
      assert.equal(
        (await satirlar()).evraklar.find((x) => x.path === e.path)!.kaynakDurum,
        "yok",
      );
      assert.deepEqual(
        readFileSync(manifestYolu),
        oncekiManifest,
        "kaynak durumu türetilmiştir; manifest'e yazılamaz",
      );
      // `kaynakDurum` yalnız YANIT alanıdır, diskteki kayıtta yeri yoktur.
      assert.ok(!oncekiManifest.toString("utf8").includes("kaynakDurum"));
    } finally {
      writeFileSync(yol, yedek);
    }
  });

  test("kaynağı silinmiş evrakta önizleme AÇIK kalır, 'asıl belgeyi aç' kapanır", async () => {
    const kayit = kayitAl();
    const e = evrakAl();
    const param = { caseKey: kayit.caseKey, path: e.path };
    const yol = join(kayit.klonYolu!, e.path);
    const yedek = readFileSync(yol);
    const oncekiAcilan = acilan.length;
    rmSync(yol);
    try {
      // KARAR (Eksik 3): türetilmiş metin kullanıcının belgeye kalan tek
      // erişimidir; önizleme kapanmaz, yanına durumu konur.
      const oku = await api("evrak-oku", param);
      assert.equal(oku.status, 200);
      const veri = (await oku.json()) as {
        data: { metin: string; mdStatus: string; hazirlik: string; kaynakDurum: string };
      };
      assert.ok(veri.data.metin.includes("Örnek belge."));
      // İki AYRI eksen: `hazirlik` metni, `kaynakDurum` asıl dosyayı anlatır.
      assert.equal(veri.data.hazirlik, "ok");
      assert.equal(veri.data.kaynakDurum, "yok");

      const ac = await api("evrak-ac", param);
      assert.equal(ac.status, 404);
      const hata = (await ac.json()) as { error: { code: string; message: string } };
      assert.equal(hata.error.code, "NOT_FOUND");
      assert.match(hata.error.message, /kaynağı arşivde bulunamadı/);
      // Ham "ENOENT: no such file or directory, stat '/…'" BİTTİ: ne İngilizce
      // errno ne de mutlak arşiv yolu gövdeye çıkar.
      assert.ok(!hata.error.message.includes("ENOENT"), hata.error.message);
      assert.ok(!hata.error.message.includes(kayit.klonYolu!), hata.error.message);
      assert.ok(!hata.error.message.includes("/"), hata.error.message);
      assert.equal(acilan.length, oncekiAcilan, "eksik dosya açılmaya kalkışılmadı");
    } finally {
      writeFileSync(yol, yedek);
    }
  });

  test("izin kapalıyken KAYNAK_ERISILEMEDI der; 'yok' ya da PATH_FORBIDDEN demez", async (t) => {
    if (process.getuid?.() === 0) return t.skip("root izin denetimini aşar");
    const kayit = kayitAl();
    const e = evrakAl();
    const dizin = join(kayit.klonYolu!, e.path, "..");
    chmodSync(dizin, 0o000);
    try {
      const satir = (await satirlar()).evraklar.find((x) => x.path === e.path)!;
      if (satir.kaynakDurum === "var")
        return t.skip("dosya sistemi izinleri uygulamıyor");
      assert.equal(satir.kaynakDurum, "erisilemiyor");

      const r = await api("evrak-ac", { caseKey: kayit.caseKey, path: e.path });
      const hata = (await r.json()) as { error: { code: string; message: string } };
      // 403 kalır (PATH_FORBIDDEN ile aynı sınıf) ama KOD ayrışır: eskiden
      // "yazma kök dışına engellendi" diyordu, oysa yol kök içindeydi.
      assert.equal(r.status, 403);
      assert.equal(hata.error.code, "KAYNAK_ERISILEMEDI");
      assert.match(hata.error.message, /erişilemedi/);
      assert.match(hata.error.message, /silinmiş olduğu anlamına gelmez/);
      assert.ok(!hata.error.message.includes(kayit.klonYolu!));
    } finally {
      chmodSync(dizin, 0o755);
    }
  });

  test("dava KLASÖRÜ erişilemezken de KAYNAK_ERISILEMEDI; arşiv yolu sızmaz", async (t) => {
    // Bir üstteki test izni evrakın DİZİNİNE uyguluyor. Bu test bir seviye
    // yukarıyı, dava klasörünün KENDİSİNİ kapatır: evrakBul o durumda manifest'i
    // ölçerken eskiden `kapsamKontrol`a düşüyor, kullanıcıya "yazma kök dışına
    // engellendi: <tam arşiv yolu>" diyordu (yanlış kod + yol sızıntısı).
    if (process.getuid?.() === 0) return t.skip("root izin denetimini aşar");
    const kayit = kayitAl();
    const e = evrakAl();
    chmodSync(kayit.klonYolu!, 0o000);
    try {
      const deneme = await api("evrak-oku", { caseKey: kayit.caseKey, path: e.path });
      if (deneme.status === 200) return t.skip("dosya sistemi izinleri uygulamıyor");
      const hata = (await deneme.json()) as { error: { code: string; message: string } };
      assert.equal(deneme.status, 403);
      assert.equal(hata.error.code, "KAYNAK_ERISILEMEDI");
      assert.notEqual(hata.error.code, "PATH_FORBIDDEN");
      assert.match(hata.error.message, /silinmiş olduğu anlamına gelmez/);
      // Gövde arşiv düzenini TAŞIMAZ: ne klon yolu, ne kök, ne herhangi bir yol.
      assert.ok(!hata.error.message.includes(kayit.klonYolu!), hata.error.message);
      assert.ok(!hata.error.message.includes(kok.kok), hata.error.message);
      assert.ok(!hata.error.message.includes("/"), hata.error.message);

      // evrak-ac aynı yoldan geçer; o da aynı cevabı verir ve dosya açmaya kalkmaz.
      const oncekiAcilan = acilan.length;
      const r2 = await api("evrak-ac", { caseKey: kayit.caseKey, path: e.path });
      const h2 = (await r2.json()) as { error: { code: string; message: string } };
      assert.equal(r2.status, 403);
      assert.equal(h2.error.code, "KAYNAK_ERISILEMEDI");
      assert.ok(!h2.error.message.includes(kayit.klonYolu!), h2.error.message);
      assert.equal(acilan.length, oncekiAcilan, "erişilemeyen klasörde dosya açılmaya kalkışıldı");
    } finally {
      chmodSync(kayit.klonYolu!, 0o755);
    }
  });

  test("manifest'teki bozuk/kaçış yolu listeyi düşürmez, yanlış etiketlemez", async () => {
    const kayit = kayitAl();
    const depo = new ManifestDepo(join(kayit.klonYolu!, "uyap-project.json"));
    const m = depo.oku()!;
    const yedek = m.evraklar.slice();
    const ornek = m.evraklar[0]!;
    writeFileSync(join(dis.kok, "disarida.pdf"), "X");
    m.evraklar.push(
      // `path` eksik: eskiden resolve(klasor, undefined) TypeError'ı BÜTÜN
      // listeyi 500'e düşürürdü.
      { ...ornek, evrakId: '"BOZUK"', stableKey: "ana:bozuk", path: undefined as never },
      { ...ornek, evrakId: '"BOS"', stableKey: "ana:bos", path: "" },
      { ...ornek, evrakId: '"KACIS"', stableKey: "ana:kacis", path: "../../../etc/passwd" },
      { ...ornek, evrakId: '"SYM"', stableKey: "ana:sym", path: "disari-link" },
    );
    symlinkSync(join(dis.kok, "disarida.pdf"), join(kayit.klonYolu!, "disari-link"));
    depo.yaz(m);
    try {
      const veri = await satirlar();
      const bul = (k: string) =>
        veri.evraklar.find((x) => (x as { evrakId?: string }).evrakId === k)!;
      assert.equal(bul('"BOZUK"').kaynakDurum, "bilinmiyor");
      assert.equal(bul('"BOS"').kaynakDurum, "bilinmiyor");
      // Kök dışı yol "yok" DEĞİL "kapsamDisi"dır: /etc/passwd gerçekten duruyor,
      // ama arşivin dışında — kullanıcıya "eksik" demek yanlış olurdu.
      assert.equal(bul('"KACIS"').kaynakDurum, "kapsamDisi");
      assert.equal(bul('"SYM"').kaynakDurum, "kapsamDisi");
      assert.equal(bul(ornek.evrakId).kaynakDurum, "var");

      // Kaçış yolları belge işleyicilerinde hâlâ PATH_FORBIDDEN/403 verir ve
      // dış dosyanın içeriğini sızdırmaz.
      const r = await api("evrak-oku", { caseKey: kayit.caseKey, path: "disari-link" });
      assert.equal(r.status, 403);
      const hata = (await r.json()) as { error: { code: string; message: string } };
      assert.equal(hata.error.code, "PATH_FORBIDDEN");
      assert.ok(!hata.error.message.includes(dis.kok));
    } finally {
      m.evraklar = yedek;
      depo.yaz(m);
      rmSync(join(kayit.klonYolu!, "disari-link"), { force: true });
    }
  });

  test("P15c maliyeti: 600 evraklı dava klasöründe evraklar RPC'si ÖLÇÜLÜR", async () => {
    const kayit = kayitAl();
    const klon = join(kok.kok, "buyuk-dava");
    const yonler = ["Gelen", "Giden", "Dosya"];
    const katlar = [
      "01-Kararlar-Tutanaklar",
      "02-Dilekceler",
      "03-Tebligatlar",
      "04-Muzekkereler-Yazismalar",
      "06-Mali",
      "07-Vekalet-Idari",
      "08-Ekler-Diger",
      "09-Durusma-Zabitlari",
    ];
    const evraklar = Array.from({ length: 600 }, (_, i) => {
      // Her 5. evrakın kendi `_ekler` dizini var (orchestrator deseni): dizin
      // sayısı gerçekçi düzenden FAZLA, yani ölçüm karamsar taraftan.
      const taban = `_kaynak/evraklar/${yonler[i % 3]}/${katlar[i % 8]}`;
      const p = i % 5 === 0
        ? `${taban}/evrak-${i}_ekler/evrak-${i}.pdf`
        : `${taban}/evrak-${i}.pdf`;
      mkdirSync(join(klon, p, ".."), { recursive: true });
      // %10'u eksik: hem "yok" dalı hem de dizin önbelleği gerçek yükte ölçülsün.
      if (i % 10 !== 0) writeFileSync(join(klon, p), "x");
      return {
        evrakId: `"B${i}"`,
        stableKey: `ana:${i}`,
        path: p,
        sha256: "aa",
        isEkEvrak: false,
        category: katlar[i % 8]!,
        yon: "Gelen" as const,
        tur: "Dilekçe",
        gonderen: "X",
        tarih: "01/09/2026",
        dosyaKey: "2026/600",
        mdStatus: "ok" as const,
      };
    });
    new ManifestDepo(join(klon, "uyap-project.json")).yaz({
      dosyaId: '"B"',
      mahkeme: "Buyuk Mahkeme",
      birimId: "9",
      esasNo: "2026/600",
      isIcra: false,
      clonedAt: new Date().toISOString(),
      evraklar,
    });
    d.registry.koy({
      ...kayit,
      caseKey: "Buyuk Mahkeme 2026/600",
      birimAdi: "Buyuk Mahkeme",
      dosyaNo: "2026/600",
      klonYolu: klon,
    });
    try {
      await api("evraklar", { caseKey: "Buyuk Mahkeme 2026/600" }); // ısınma
      const t0 = performance.now();
      const r = await api("evraklar", { caseKey: "Buyuk Mahkeme 2026/600" });
      const sure = performance.now() - t0;
      assert.equal(r.status, 200);
      const veri = (await r.json()) as {
        data: { adet: number; evraklar: { kaynakDurum: string }[] };
      };
      assert.equal(veri.data.adet, 600);
      assert.equal(
        veri.data.evraklar.filter((x) => x.kaynakDurum === "yok").length,
        60,
      );
      const ozetT0 = performance.now();
      await api("hazirlik-ozet");
      const ozetSure = performance.now() - ozetT0;
      console.log(
        `  ℹ 600 evraklı dava: evraklar (ölçümlü) ${sure.toFixed(1)} ms · hazirlik-ozet ${ozetSure.toFixed(1)} ms`,
      );
      // Gevşek tavan: amaç rakam sabitlemek değil, regresyon yakalamak.
      assert.ok(sure < 3000, `evraklar çok yavaş: ${sure.toFixed(1)} ms`);
    } finally {
      const v = d.registry.oku();
      v.davalar = v.davalar.filter((x) => x.caseKey !== "Buyuk Mahkeme 2026/600");
      d.registry.yaz();
      rmSync(klon, { recursive: true, force: true });
    }
  });
});

describe("P10a tanılama web ucu", () => {
  test("POST /api/tani: CSRF ile 200, beklenen alanlar, sır yok", async () => {
    const r = await api("tani");
    assert.equal(r.status, 200);
    const v = (await r.json()) as { ok: boolean; data: Record<string, any> };
    assert.equal(v.ok, true);
    for (const alan of ["surum", "kaynak", "calisma", "bagimlilik", "arsiv", "ayar", "uyarilar", "not"]) {
      assert.ok(alan in v.data, `tani yanıtında ${alan} bulunmalı`);
    }
    assert.equal(v.data["arsiv"].kok, kok.kok);
    assert.equal(v.data["ayar"].dizin, ayar.kok);
    // Panonun gösterdiği her şey sırsız olmalı: token/çerez/kimlik deseni yok.
    const metin = JSON.stringify(v.data);
    for (const desen of [/JSESSIONID/i, /Bearer/i, /"token"/i, /cookie/i, /caseKey/i, /evrakId/i]) {
      assert.ok(!desen.test(metin), `tani yanıtında sır deseni: ${desen}`);
    }
  });

  test("tanılama gövdedeki yol/kimlik argümanlarını YOK SAYAR", async () => {
    // İzin listesine giren her işlem yeni bir okuma yüzeyidir. `tani` argüman
    // kabul etseydi belge işleyicilerindeki kök sınırının dışında bir kapı
    // açılırdı; web katmanı gövdeyi bilerek boşaltıyor.
    const r = await api("tani", { kok: "/etc", yol: "/etc/passwd", caseKey: "x" });
    assert.equal(r.status, 200);
    const v = (await r.json()) as { data: { arsiv: { kok: string } } };
    assert.equal(v.data.arsiv.kok, kok.kok);
  });

  test("tanılama CSRF'siz/yabancı kökende 403, GET'te 405", async () => {
    assert.equal((await api("tani", {}, { "x-csrf-token": "" })).status, 403);
    assert.equal((await api("tani", {}, { origin: "https://evil.example" })).status, 403);
    const g = await fetch(url + "/api/tani", { method: "GET", headers: { origin: url } });
    assert.equal(g.status, 405);
  });

  test("tanılama portala istek atmaz ve oturumu yoklamaz", async () => {
    const once = mock.istekler.length;
    await api("tani");
    await api("tani");
    assert.equal(mock.istekler.length, once, "tanılama oturumsuzdur");
  });

  test("/health gövdesi GENİŞLEMEDİ: commit/dal/yol Bearer'sız uca sızmaz", async () => {
    // /health Bearer istemez ve baslatici.sh onu ayrıştırır. Kaynak yolu veya
    // commit oraya konursa aynı kökendeki her sayfaya sızar.
    const r = await fetch(url + "/health");
    const d = (await r.json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(d).sort(), ["apiVersion", "app", "appVersion", "instanceId", "ok"]);
    const metin = JSON.stringify(d);
    for (const desen of [/commit/i, /\/Users\//, /dal/, /node_modules/, /pdftotext/]) {
      assert.ok(!desen.test(metin), `/health sızıntısı: ${desen}`);
    }
  });
});

// ── P16 sorunların yeri ve sayacı ────────────────────────────────────────────
// Kullanıcının gerçek arşivinde şu an AÇIK SORUN YOK; bu blok sorunları
// `d.sorunlar` üzerinden SENTETİK olarak üretir ve bitince depoyu boşaltır.
describe("P16 sorunların yeri ve sayacı", () => {
  const caseKey = () => d.registry.oku().davalar[0]!.caseKey;
  type Satir = { sorunId: string; tur: string; durum: string; sayilir?: boolean };
  const sorunlarOku = async (govde: Record<string, unknown> = {}) => {
    const r = await api("sorunlar", govde);
    assert.equal(r.status, 200);
    return ((await r.json()) as {
      data: {
        acik: Satir[];
        hepsi: Satir[];
        acikAdet: number;
        sayilanAdet: number;
        hepsiAdet: number;
      };
    }).data;
  };
  const durumOku = async () => {
    const r = await api("durum");
    assert.equal(r.status, 200);
    return ((await r.json()) as {
      data: { sorunAcik: number; sorunAcikToplam: number };
    }).data;
  };
  const kimlikler: Record<string, string> = {};

  before(() => {
    // Üç eksen: eyleme dönük indirme hatası, eyleme dönük `arac-yok`
    // (dönüşüm türü altında, metinden ayırt ediliyor) ve düzeltilemeyen
    // "UYAP'a yüklenmemiş" kaydı.
    kimlikler["indirme"] = d.sorunlar.ekle({
      caseKey: caseKey(),
      evrakId: "p16-a",
      tur: "indirme",
      hata: "portal 500 döndü",
    }).sorunId;
    kimlikler["arac"] = d.sorunlar.ekle({
      caseKey: caseKey(),
      evrakId: "p16-b",
      tur: "donusum",
      hata: "pdftotext bulunamadı (brew install poppler)",
    }).sorunId;
    kimlikler["yuklenmemis"] = d.sorunlar.ekle({
      caseKey: caseKey(),
      evrakId: "p16-c",
      tur: "yuklenmemis",
      hata: "Evrak UYAP sistemine yüklenmemiş",
    }).sorunId;
  });
  after(() => {
    const v = d.sorunlar.oku();
    v.sorunlar.length = 0;
    d.sorunlar.yaz();
  });

  test("sayaç yalnız eyleme dönük kayıtları sayar; liste hepsini taşır", async () => {
    const liste = await sorunlarOku();
    assert.equal(liste.acikAdet, 3, "üç kayıt da AÇIK listede durmalı");
    assert.equal(liste.sayilanAdet, 2, "yuklenmemis sayaca girmemeli");
    const tur = (t: string) => liste.acik.find((x) => x.tur === t)!;
    assert.equal(tur("indirme").sayilir, true);
    assert.equal(tur("donusum").sayilir, true, "arac-yok eyleme dönüktür");
    assert.equal(tur("yuklenmemis").sayilir, false);

    // Başlıktaki rozet ile listenin sayacı AYNI kaynaktan (eylemeDonukMu).
    const durum = await durumOku();
    assert.equal(durum.sorunAcik, liste.sayilanAdet);
    assert.equal(durum.sorunAcikToplam, liste.acikAdet);
  });

  test("aynı sorun iki ekranda farklı sayılmaz: web sayacı sunucununkine eşit", async () => {
    const { davaSorunSayaci } = await import(
      new URL("../../web/sorunlar.js", import.meta.url).href
    );
    const liste = await sorunlarOku();
    const durum = await durumOku();
    // Sorun sekmesinin sayacı (tüm arşiv) ve dava satırındaki rozet, aynı
    // yanıttaki `sayilir` bayrağından türer; sunucunun kendi sayısıyla üçü de
    // eşit olmak zorunda.
    assert.equal(davaSorunSayaci(liste, null).sayilan, durum.sorunAcik);
    assert.equal(davaSorunSayaci(liste, null).toplam, durum.sorunAcikToplam);
    assert.equal(davaSorunSayaci(liste, caseKey()).sayilan, durum.sorunAcik);
    // Başka bir davaya daraltıldığında sıfırlanır; sayı davaya aittir.
    assert.equal(davaSorunSayaci(liste, "yok-boyle-bir-dava").sayilan, 0);
  });

  test("yoksayılan kayıt SAYAÇTAN düşer, LİSTEDEN düşmez", async () => {
    const id = kimlikler["indirme"]!;
    assert.equal((await api("sorunlar", { islem: "yoksay", sorunId: id })).status, 200);
    const sonra = await sorunlarOku();
    assert.equal(sonra.sayilanAdet, 1, "yoksayılan kayıt sayaçtan düşmeli");
    assert.equal((await durumOku()).sorunAcik, 1);
    assert.ok(
      !sonra.acik.some((x) => x.sorunId === id),
      "yoksayılan kayıt AÇIK listesinde kalmaz",
    );
    const kayit = sonra.hepsi.find((x) => x.sorunId === id)!;
    assert.ok(kayit, "yoksayılan kayıt LİSTEDEN düşmemeli");
    assert.equal(kayit.durum, "yok-sayildi");
    assert.equal(kayit.sayilir, true, "tür değişmedi; yalnız durumu değişti");

    assert.equal((await api("sorunlar", { islem: "vazgec", sorunId: id })).status, 200);
    assert.equal((await sorunlarOku()).sayilanAdet, 2, "geri alma sayacı yükseltmeli");
    assert.equal((await durumOku()).sorunAcik, 2);
  });

  test("türetilmiş `sayilir` bayrağı sorunlar.json'a YAZILMAZ", async () => {
    await sorunlarOku();
    await api("sorunlar", { islem: "yoksay", sorunId: kimlikler["arac"]! });
    await api("sorunlar", { islem: "vazgec", sorunId: kimlikler["arac"]! });
    const ham = readFileSync(join(ayar.kok, "sorunlar.json"), "utf8");
    assert.ok(ham.includes("p16-a"), "kayıtlar diske yazılmış olmalı");
    assert.ok(!ham.includes("sayilir"), "sınıflama türetilmiştir, kalıcı değildir");
  });

  test("oturumsuz arşivde sorun sekmesi çalışır ve portala TEK istek atmaz", async () => {
    d.oturum.cikis();
    const onceki = mock.istekler.length;
    try {
      const liste = await sorunlarOku();
      assert.equal(liste.acikAdet, 3);
      assert.equal(liste.sayilanAdet, 2);
      // Sekmenin ihtiyacı olan diğer iki uç da oturumsuz çalışır.
      assert.equal((await api("davalar")).status, 200);
      const id = kimlikler["yuklenmemis"]!;
      assert.equal((await api("sorunlar", { islem: "yoksay", sorunId: id })).status, 200);
      assert.equal((await api("sorunlar", { islem: "vazgec", sorunId: id })).status, 200);
      assert.equal(
        mock.istekler.length,
        onceki,
        "sorun sekmesi portalı yoklamamalı",
      );
    } finally {
      d.oturum.girisYap("JSESSIONID=p16", "manuel");
    }
  });

  test("/sorunlar.js varlık listesinde: sekme boş açılmaz", async () => {
    const r = await fetch(url + "/sorunlar.js");
    assert.equal(r.status, 200, "varliklar haritasına eklenmemiş → sekme boş açılır");
    assert.match(r.headers.get("content-type") ?? "", /javascript/);
    assert.match(await r.text(), /export function sorunlariCiz/);
  });

  test("bilinmeyen sorunId 404; yoksay/vazgec sessizce başarılı görünmez", async () => {
    assert.equal(
      (await api("sorunlar", { islem: "yoksay", sorunId: "srn-yok" })).status,
      404,
    );
    assert.equal(
      (await api("sorunlar", { islem: "vazgec", sorunId: "srn-yok" })).status,
      404,
    );
  });

  // Kaydı AÇAN ve KAPATAN yolların aynı kimliği görmesi bu yardımcıya bağlı;
  // ölçüt `ekle`in yığılma engeliyle birebir aynı (caseKey + evrakId + tür).
  // Bu describe'ın son testi: yeni kayıtlar önceki mutlak sayıları bozmasın.
  test("acikBul kimliği tam eşler ve YOKSAYILAN kaydı döndürmez", () => {
    const ck = caseKey();
    const a = d.sorunlar.ekle({ caseKey: ck, evrakId: "p16-bul", tur: "indirme", hata: "x" });
    assert.equal(d.sorunlar.acikBul(ck, "p16-bul", "indirme")?.sorunId, a.sorunId);
    // Üç eksenin her biri tek başına eşleşmeyi bozar.
    assert.equal(d.sorunlar.acikBul(ck, "p16-bul", "donusum"), undefined);
    assert.equal(d.sorunlar.acikBul(ck, "baska-evrak", "indirme"), undefined);
    assert.equal(d.sorunlar.acikBul("baska-dava", "p16-bul", "indirme"), undefined);
    // Kullanıcı "Yoksay" dediyse karar onundur: düzelme kaydı yeniden yazmaz.
    d.sorunlar.yokSay(a.sorunId);
    assert.equal(d.sorunlar.acikBul(ck, "p16-bul", "indirme"), undefined);
    // Çözülmüş kayıt da AÇIK değildir; ikinci bir eşitleme onu tekrar kapatmaz.
    d.sorunlar.yokSayVazgec(a.sorunId);
    d.sorunlar.cozuldu(a.sorunId);
    assert.equal(d.sorunlar.acikBul(ck, "p16-bul", "indirme"), undefined);
    assert.equal(
      d.sorunlar.hepsi().find((x) => x.sorunId === a.sorunId)?.durum,
      "cozuldu",
      "çözülen kayıt LİSTEDEN silinmez",
    );
  });
});

describe("P18 taraf web yüzeyi", () => {
  test("/taraf.js varlık listesinde: iki ekran da boş açılmaz", async () => {
    const r = await fetch(url + "/taraf.js");
    assert.equal(r.status, 200, "varliklar haritasına eklenmemiş → satırlar boş çizilir");
    assert.match(r.headers.get("content-type") ?? "", /javascript/);
    assert.match(await r.text(), /export function tarafOzetiHTML/);
  });

  test("`liste-taraflar` IZINLI kümesinde ve CSRF'siz reddedilir", async () => {
    // İzin listesinde olmasaydı NOT_FOUND (404) dönerdi; oturum kapalıyken
    // beklenen yanıt 401'dir — yani işlem BULUNUYOR ama oturum istiyor.
    const eski = d.oturum.durumBilgisi().durum;
    d.oturum.cikis();
    try {
      const r = await api("liste-taraflar", { dosyaId: "x", surum: 1 });
      assert.equal(r.status, 401, "izin listesinde yoksa 404 görülür");
    } finally {
      if (eski === "aktif") d.oturum.girisYap("JSESSIONID=p18-web", "manuel");
    }
    const ham = await fetch(url + "/api/liste-taraflar", {
      method: "POST",
      headers: { "content-type": "application/json", origin: url },
      body: JSON.stringify({ dosyaId: "x", surum: 1 }),
    });
    assert.equal(ham.status, 403);
  });
});

describe("P06a arşiv denetimi web yüzeyi", () => {
  const kayitAl = () => {
    const k = d.registry.oku().davalar.find((x) => x.dosyaNo === "2026/99");
    assert.ok(k?.klonYolu, "denetim testi klonlanmış davayı bulamadı");
    return k!;
  };
  const denetle = async (govde: Record<string, unknown> = {}) => {
    const r = await api("arsiv-denetle", govde);
    assert.equal(r.status, 200, await r.clone().text());
    return ((await r.json()) as { data: Record<string, any> }).data;
  };

  test("/denetim.js varlık listesinde: üçüncü sekme boş açılmaz", async () => {
    const r = await fetch(url + "/denetim.js");
    assert.equal(r.status, 200, "varliklar haritasına eklenmemiş → sekme boş açılır");
    assert.match(r.headers.get("content-type") ?? "", /javascript/);
    assert.match(await r.text(), /export function denetimCiz/);
  });

  test("`arsiv-denetle` IZINLI kümesinde ve CSRF'siz reddedilir", async () => {
    const kayit = kayitAl();
    const s = await denetle({ caseKey: kayit.caseKey });
    assert.equal(s["sayilar"].dava, 1);
    assert.equal(s["kapsam"].tumArsiv, false);
    const ham = await fetch(url + "/api/arsiv-denetle", {
      method: "POST",
      headers: { "content-type": "application/json", origin: url },
      body: JSON.stringify({}),
    });
    assert.equal(ham.status, 403);
    // Klonlanmamış dava istenirse 404 — boş rapor "sağlam" diye DÖNMEZ.
    const yok = await api("arsiv-denetle", { caseKey: "Yok Mahkemesi 2026/1" });
    assert.equal(yok.status, 404);
  });

  test("KABUL 5 — denetim OTURUMSUZ çalışır ve portal istek sayacı DEĞİŞMEZ", async () => {
    const kayit = kayitAl();
    const eskiDurum = d.oturum.durumBilgisi().durum;
    d.oturum.cikis();
    const oncekiIstek = mock.istekler.length;
    try {
      const s = await denetle({ caseKey: kayit.caseKey });
      assert.equal(typeof s["tamamlandi"], "boolean");
      assert.equal(mock.istekler.length, oncekiIstek, "denetim portala istek attı");
      // Arşiv kökü, arşiv dışı yol ve dış dosya içeriği rapora sızmaz.
      const metin = JSON.stringify(s);
      assert.ok(!metin.includes(kok.kok), "mutlak arşiv yolu rapora sızdı");
      assert.ok(!metin.includes(dis.kok), "arşiv dışı yol rapora sızdı");
      assert.ok(!metin.includes("SECRET"), "dış dosya içeriği rapora sızdı");
    } finally {
      if (eskiDurum === "aktif") d.oturum.girisYap("JSESSIONID=p06a", "manuel");
    }
  });

  test("denetim manifest'e, registry'ye ve sorunlar.json'a TEK BAYT yazmaz", async () => {
    const kayit = kayitAl();
    const izle = [
      join(kayit.klonYolu!, "uyap-project.json"),
      join(ayar.kok, "davalarim.json"),
      join(ayar.kok, "sorunlar.json"),
    ].filter((p) => existsSync(p));
    assert.ok(izle.length >= 2, "izlenecek depo dosyası bulunamadı");
    const ozet = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
    const once = izle.map(ozet);
    const sorunOnce = d.sorunlar.hepsi().length;
    await denetle({ caseKey: kayit.caseKey });
    assert.deepEqual(izle.map(ozet), once, "denetim depo dosyalarını değiştirdi");
    assert.equal(d.sorunlar.hepsi().length, sorunOnce, "denetim sorun kaydı açtı");
  });

  test("eşitlemesi süren dava atlanır: sonuç KISMİ döner", async () => {
    const kayit = kayitAl();
    const gercek = d.orkestrator.islerHepsi.bind(d.orkestrator);
    (d.orkestrator as unknown as Record<string, unknown>)["islerHepsi"] = () => [
      ...gercek(),
      {
        isId: "sahte-calisan",
        tur: "esitle",
        caseKey: kayit.caseKey,
        durum: "calisiyor",
        baslamaAt: new Date().toISOString(),
        ilerleme: { toplam: 0, biten: 0 },
      },
    ];
    try {
      const s = await denetle({ caseKey: kayit.caseKey });
      assert.equal(s["tamamlandi"], false);
      assert.equal(s["davalar"][0].durum, "atlandi-mesgul");
      assert.equal(s["sayilar"].denetlenen, 0);
      assert.match(String(s["kismiSebep"]), /eşitleme/i);
    } finally {
      (d.orkestrator as unknown as Record<string, unknown>)["islerHepsi"] = gercek;
    }
  });
});

describe("P19 sadeleştirme web yüzeyi", () => {
  const kayitAl = () => {
    const k = d.registry.oku().davalar.find((x) => x.dosyaNo === "2026/99");
    assert.ok(k?.klonYolu, "sadeleştirme testi klonlanmış davayı bulamadı");
    return k!;
  };

  test("`sadelestir` IZINLI kümesinde ve CSRF'siz reddedilir", async () => {
    const kayit = kayitAl();
    // İzin listesinde olmasaydı NOT_FOUND (404) dönerdi.
    const r = await api("sadelestir", { caseKey: kayit.caseKey });
    assert.equal(r.status, 200, await r.clone().text());
    const ham = await fetch(url + "/api/sadelestir", {
      method: "POST",
      headers: { "content-type": "application/json", origin: url },
      body: JSON.stringify({ caseKey: kayit.caseKey }),
    });
    assert.equal(ham.status, 403);
    const yok = await api("sadelestir", { caseKey: "Yok Mahkemesi 2026/1" });
    assert.equal(yok.status, 404);
  });

  test("ONAYSIZ çağrı yalnız PLAN döner: manifest baytı değişmez", async () => {
    const kayit = kayitAl();
    const manifestYolu = join(kayit.klonYolu!, "uyap-project.json");
    const once = readFileSync(manifestYolu);
    const r = await api("sadelestir", { caseKey: kayit.caseKey });
    const veri = ((await r.json()) as { data: Record<string, unknown> }).data;
    assert.equal(veri["uygulandi"], false);
    assert.equal(veri["once"], veri["sonra"], "onaysız çağrıda kayıt düşmemeli");
    assert.deepEqual(readFileSync(manifestYolu), once, "onaysız çağrı manifeste yazdı");
    // Portala TEK istek gitmez: sadeleştirme tamamen yereldir.
  });

  test("eşitlemesi süren dosyada sadeleştirme REDDEDİLİR", async () => {
    const kayit = kayitAl();
    const gercek = d.orkestrator.islerHepsi.bind(d.orkestrator);
    (d.orkestrator as unknown as Record<string, unknown>)["islerHepsi"] = () => [
      ...gercek(),
      {
        isId: "sahte-calisan-p19",
        tur: "esitle",
        caseKey: kayit.caseKey,
        durum: "calisiyor",
        baslamaAt: new Date().toISOString(),
        ilerleme: { toplam: 0, biten: 0 },
      },
    ];
    try {
      const r = await api("sadelestir", { caseKey: kayit.caseKey, onay: true });
      assert.equal(r.status, 409, await r.clone().text());
    } finally {
      (d.orkestrator as unknown as Record<string, unknown>)["islerHepsi"] = gercek;
    }
  });

  // SATIR KAPSAMI: denetim satırındaki düğme kendi yolunu gönderir ve motor
  // yalnız o grubu sadeleştirir. RPC yolu geçirmezse düğme, kullanıcının
  // seçmediği grupların kayıtlarını da düşürürdü (ÖLÇÜLDÜ, 13 Eylül).
  test("SATIR KAPSAMI — `yol` motora geçer, rasgele disk yolu 400 döner", async () => {
    const kayit = kayitAl();
    const m = new ManifestDepo(join(kayit.klonYolu!, "uyap-project.json")).oku();
    const yol = m!.evraklar[0]!.path;
    const r = await api("sadelestir", { caseKey: kayit.caseKey, yol });
    assert.equal(r.status, 200, await r.clone().text());
    const veri = ((await r.json()) as { data: Record<string, unknown> }).data;
    assert.equal(veri["hedefYol"], yol, "RPC satırın yolunu motora geçirmiyor");
    assert.equal(veri["uygulandi"], false);
    for (const kotu of ["/etc/passwd", "../../disari.html", ""]) {
      const red = await api("sadelestir", { caseKey: kayit.caseKey, yol: kotu });
      assert.equal(red.status, 400, `kabul edilmemeliydi: ${kotu}`);
    }
  });

  test("sadeleştirme portala TEK istek atmaz", async () => {
    const kayit = kayitAl();
    const onceki = mock.istekler.length;
    await api("sadelestir", { caseKey: kayit.caseKey });
    assert.equal(mock.istekler.length, onceki, "sadeleştirme portala istek attı");
  });
});

describe("P06b seçili onarım web yüzeyi", () => {
  const kayitAl = () => {
    const k = d.registry.oku().davalar.find((x) => x.dosyaNo === "2026/99");
    assert.ok(k?.klonYolu, "onarım testi klonlanmış davayı bulamadı");
    return k!;
  };
  const hedefYolu = () => {
    const m = new ManifestDepo(join(kayitAl().klonYolu!, "uyap-project.json")).oku();
    assert.ok(m && m.evraklar.length > 0, "manifest boş");
    return m!.evraklar[0]!.path;
  };

  test("`onar` IZINLI kümesinde ve CSRF'siz reddedilir", async () => {
    const kayit = kayitAl();
    // İzin listesinde olmasaydı NOT_FOUND (404) dönerdi.
    const r = await api("onar", { caseKey: kayit.caseKey, yol: hedefYolu(), eylem: "metin" });
    assert.equal(r.status, 200, await r.clone().text());
    const ham = await fetch(url + "/api/onar", {
      method: "POST",
      headers: { "content-type": "application/json", origin: url },
      body: JSON.stringify({ caseKey: kayit.caseKey, yol: hedefYolu(), eylem: "metin" }),
    });
    assert.equal(ham.status, 403);
    const yok = await api("onar", {
      caseKey: "Yok Mahkemesi 2026/1",
      yol: hedefYolu(),
      eylem: "metin",
    });
    assert.equal(yok.status, 404);
  });

  // ÖLÜ DÜĞME BEKÇİSİ: denetim raporu türev bulgusunda `.md` yolunu yazar ve
  // arayüz onu olduğu gibi gönderir. Motor kaydı yalnız kaynak yoluyla
  // arasaydı bu çağrı `kayit-belirsiz` düşer, düğme hiç çalışmazdı.
  test("RAPORDAKİ TÜREV YOLU (.md) onarımda kaydı bulur", async () => {
    const kayit = kayitAl();
    const m = new ManifestDepo(join(kayit.klonYolu!, "uyap-project.json")).oku();
    const turevli = m!.evraklar.find((e) => typeof e.mdPath === "string" && e.mdPath !== "");
    assert.ok(turevli, "türevi olan kayıt yok");
    const r = await api("onar", { caseKey: kayit.caseKey, yol: turevli.mdPath, eylem: "metin" });
    assert.equal(r.status, 200, await r.clone().text());
    const veri = ((await r.json()) as { data: Record<string, unknown> }).data;
    assert.notEqual(veri["durum"], "kayit-belirsiz", "rapordaki türev yolu kaydı bulamadı");
  });

  test("İSTEMCİDEN GELEN RASGELE YOL reddedilir: mutlak ve kök dışı yol 400", async () => {
    const kayit = kayitAl();
    for (const yol of ["/etc/passwd", "../../disari.html", ""]) {
      const r = await api("onar", { caseKey: kayit.caseKey, yol, eylem: "metin" });
      assert.equal(r.status, 400, `kabul edilmemeliydi: ${yol}`);
    }
    const kotuEylem = await api("onar", {
      caseKey: kayit.caseKey,
      yol: hedefYolu(),
      eylem: "sil",
    });
    assert.equal(kotuEylem.status, 400);
  });

  test("ONAYSIZ çağrı yalnız PLAN döner: manifest baytı değişmez, portala istek gitmez", async () => {
    const kayit = kayitAl();
    const manifestYolu = join(kayit.klonYolu!, "uyap-project.json");
    const once = readFileSync(manifestYolu);
    const oncekiIstek = mock.istekler.length;
    for (const eylem of ["metin", "kaynak"]) {
      const r = await api("onar", { caseKey: kayit.caseKey, yol: hedefYolu(), eylem });
      const veri = ((await r.json()) as { data: Record<string, unknown> }).data;
      assert.equal(veri["uygulandi"], false, eylem);
      assert.equal(veri["isId"], undefined, `${eylem}: onaysız çağrı iş başlattı`);
    }
    assert.deepEqual(readFileSync(manifestYolu), once, "onaysız çağrı manifeste yazdı");
    assert.equal(mock.istekler.length, oncekiIstek, "plan portala istek attı");
  });

  test("METİN onarımı OTURUMSUZ çalışır ve portal istek sayacı DEĞİŞMEZ", async () => {
    const kayit = kayitAl();
    const eskiDurum = d.oturum.durumBilgisi().durum;
    d.oturum.cikis();
    const oncekiIstek = mock.istekler.length;
    try {
      const r = await api("onar", { caseKey: kayit.caseKey, yol: hedefYolu(), eylem: "metin" });
      assert.equal(r.status, 200, await r.clone().text());
      assert.equal(mock.istekler.length, oncekiIstek, "metin onarımı portala istek attı");
      // Yanıt OPAK PORTAL TOKENI taşımaz: evrakId RPC sınırını geçmez.
      const veri = ((await r.json()) as { data: Record<string, unknown> }).data;
      assert.ok(!JSON.stringify(veri).includes("evrakId"), "opak kimlik yanıta sızdı");
    } finally {
      if (eskiDurum === "aktif") d.oturum.girisYap("JSESSIONID=p06a", "manuel");
    }
  });

  test("eşitlemesi süren dosyada onarım REDDEDİLİR", async () => {
    const kayit = kayitAl();
    const gercek = d.orkestrator.islerHepsi.bind(d.orkestrator);
    (d.orkestrator as unknown as Record<string, unknown>)["islerHepsi"] = () => [
      ...gercek(),
      {
        isId: "sahte-calisan-p06b",
        tur: "esitle",
        caseKey: kayit.caseKey,
        durum: "calisiyor",
        baslamaAt: new Date().toISOString(),
        ilerleme: { toplam: 0, biten: 0 },
      },
    ];
    try {
      const r = await api("onar", {
        caseKey: kayit.caseKey,
        yol: hedefYolu(),
        eylem: "metin",
        onay: true,
      });
      assert.equal(r.status, 409, await r.clone().text());
    } finally {
      (d.orkestrator as unknown as Record<string, unknown>)["islerHepsi"] = gercek;
    }
  });
});

// ── P07a — "Takvime aktar" web yüzeyi ──────────────────────────────────────
// Aktarma PORTALA GİTMEZ ve ARŞİVE DOKUNMAZ: girdisi ekrandaki satırlardır,
// çıktısı ayar dizinindeki dışa aktarma konumudur.
describe("P07a takvime aktarma web yüzeyi", () => {
  const disaAktarma = join(ayar.kok, "disa-aktarma");
  const icsYolu = join(disaAktarma, "ajanda.ics");
  const durumYolu = join(disaAktarma, "takvim-durum.json");
  const satir = (ek: Record<string, unknown> = {}) => ({
    tarihSaat: "2026-09-09 11:40:00.0",
    dosyaNo: "2026/918",
    yerelBirimAd: "Sentetik 1. İş Mahkemesi",
    birimId: "7000",
    islemTuru: 0,
    islemTuruAciklama: "Duruşma",
    islemSonucuAciklama: "Günü Verildi",
    ...ek,
  });
  const aktar = async (govde: Record<string, unknown>) => {
    const r = await api("takvime-aktar", govde);
    assert.equal(r.status, 200, await r.clone().text());
    return ((await r.json()) as { data: Record<string, any> }).data;
  };
  // Erteleme yalnız HENÜZ YAPILMAMIŞ duruşma için geçerlidir; web katmanı
  // gerçek saati kullandığı için fixture tarihleri BUGÜNE GÖRE üretilir
  // (sabit tarih yazılırsa test takvim ilerledikçe sessizce anlamını yitirir).
  const gunSonra = (adet: number, saat = "10:00") => {
    const d = new Date(Date.now() + adet * 86_400_000);
    const p2 = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${saat}:00.0`;
  };

  test("`takvime-aktar` IZINLI kümesinde ve CSRF'siz reddedilir", async () => {
    const veri = await aktar({ durusmalar: [satir()] });
    assert.equal(veri["adet"], 1);
    const ham = await fetch(url + "/api/takvime-aktar", {
      method: "POST",
      headers: { "content-type": "application/json", origin: url },
      body: JSON.stringify({ durusmalar: [satir()] }),
    });
    assert.equal(ham.status, 403);
  });

  test("dosya AYAR dizinine yazılır, ARŞİVE değil; izinler 0600 ve Takvim'e AÇILIR", async () => {
    const oncekiAcilan = acilan.length;
    const veri = await aktar({ durusmalar: [satir()] });
    assert.equal(veri["yol"], icsYolu);
    assert.ok(!String(veri["yol"]).startsWith(kok.kok), "dosya arşive yazıldı");
    assert.equal((statSync(icsYolu).mode & 0o777).toString(8), "600");
    assert.equal((statSync(disaAktarma).mode & 0o777).toString(8), "700");
    assert.equal(veri["acildi"], true);
    assert.equal(acilan.length, oncekiAcilan + 1);
    assert.equal(acilan.at(-1), icsYolu);
    const ics = readFileSync(icsYolu, "utf8");
    assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\n"), "CRLF ile başlamıyor");
    assert.match(ics, /DTSTART;TZID=Europe\/Istanbul:20260909T114000/);
    assert.match(veri["kisaYol"] as string, /disa-aktarma\/ajanda\.ics$/);
  });

  test("aktarma OTURUMSUZ çalışır, portala TEK istek atmaz ve arşive tek bayt yazmaz", async () => {
    const kayit = d.registry.oku().davalar.find((x) => x.dosyaNo === "2026/99");
    assert.ok(kayit?.klonYolu);
    const izle = [
      join(kayit!.klonYolu!, "uyap-project.json"),
      join(ayar.kok, "davalarim.json"),
    ].filter((p) => existsSync(p));
    const once = izle.map((p) => readFileSync(p));
    const eskiDurum = d.oturum.durumBilgisi().durum;
    d.oturum.cikis();
    const oncekiIstek = mock.istekler.length;
    try {
      const veri = await aktar({ durusmalar: [satir({ dosyaNo: "2026/500" })] });
      assert.equal(veri["adet"], 1);
      assert.equal(mock.istekler.length, oncekiIstek, "aktarma portala istek attı");
      izle.forEach((p, i) =>
        assert.deepEqual(readFileSync(p), once[i], `aktarma ${p} dosyasını değiştirdi`),
      );
    } finally {
      if (eskiDurum === "aktif") d.oturum.girisYap("JSESSIONID=p07a", "manuel");
    }
  });

  test("KABUL 2/3 — aynı duruşma iki kez TEK etkinlik; ertelenen AYNI etkinliği günceller", async () => {
    rmSync(durumYolu, { force: true });
    const ileri = satir({ dosyaNo: "2026/777", tarihSaat: gunSonra(10) });
    const birinci = await aktar({ durusmalar: [ileri] });
    const ikinci = await aktar({ durusmalar: [ileri] });
    const uid = birinci["etkinlikler"][0].uid;
    assert.equal(ikinci["etkinlikler"][0].uid, uid);
    assert.equal(ikinci["etkinlikler"][0].sequence, 0);
    assert.equal(ikinci["guncellenen"], 0);
    const ertelenmis = await aktar({
      durusmalar: [satir({ dosyaNo: "2026/777", tarihSaat: gunSonra(24, "09:30") })],
    });
    assert.equal(ertelenmis["etkinlikler"][0].uid, uid, "erteleme yeni UID üretti");
    assert.equal(ertelenmis["etkinlikler"][0].sequence, 1);
    assert.equal(ertelenmis["guncellenen"], 1);
    const ics = readFileSync(icsYolu, "utf8");
    assert.equal(ics.split("BEGIN:VEVENT").length - 1, 1);
    assert.match(ics, /SEQUENCE:1/);
    // durum dosyası da 0600 ve tek kayıt tutuyor
    assert.equal((statSync(durumYolu).mode & 0o777).toString(8), "600");
    const durum = JSON.parse(readFileSync(durumYolu, "utf8")) as {
      etkinlikler: { uid: string }[];
    };
    assert.equal(durum.etkinlikler.filter((e) => e.uid === uid).length, 1);
  });

  test("UÇTAN UCA — YAPILMIŞ duruşmanın etkinliği yeni celseye TAŞINMAZ", async () => {
    // Duruşma sorgusu bugünden ileri bakar: yeni celse ekrana düştüğünde
    // defterdeki önceki celse zaten geçmiştedir. O kaydı devralmak, duruşmanın
    // yapıldığı günü avukatın takviminden siler.
    rmSync(durumYolu, { force: true });
    const gecmis = await aktar({
      durusmalar: [satir({ dosyaNo: "2026/778", tarihSaat: gunSonra(-30, "10:00") })],
    });
    const eskiUid = gecmis["etkinlikler"][0].uid;
    const yeniCelse = await aktar({
      durusmalar: [satir({ dosyaNo: "2026/778", tarihSaat: gunSonra(25, "10:00") })],
    });
    assert.notEqual(yeniCelse["etkinlikler"][0].uid, eskiUid, "geçmiş celse TAŞINDI");
    assert.equal(yeniCelse["etkinlikler"][0].sequence, 0);
    assert.equal(yeniCelse["etkinlikler"][0].ertelendi, false);
    assert.equal(yeniCelse["guncellenen"], 0, "ekran 'güncellendi' diyecekti");
    assert.ok(
      (yeniCelse["uyarilar"] as string[]).some((u) => u.includes("tarihi geçmiş")),
      `kullanıcı sessiz bırakıldı: ${JSON.stringify(yeniCelse["uyarilar"])}`,
    );
    const ics = readFileSync(icsYolu, "utf8");
    assert.match(ics, /SEQUENCE:0/);
    assert.ok(!/SEQUENCE:1/.test(ics), "yeni celse GÜNCELLEME olarak yazıldı");
    // Geçmiş etkinlik defterde duruyor: takvimdeki kaydının karşılığı silinmedi.
    const durum = JSON.parse(readFileSync(durumYolu, "utf8")) as {
      etkinlikler: { uid: string }[];
    };
    assert.ok(
      durum.etkinlikler.some((e) => e.uid === eskiUid),
      "yapılmış duruşmanın kaydı defterden silindi",
    );
  });

  test("İSTEMCİ HEDEF YOLU SEÇEMEZ: gövdedeki `yol` yok sayılır", async () => {
    const disariYol = join(dis.kok, "kacak.ics");
    const veri = await aktar({
      durusmalar: [satir()],
      yol: disariYol,
      hedef: disariYol,
      dosyaAdi: "../../kacak.ics",
    });
    assert.equal(veri["yol"], icsYolu);
    assert.ok(!existsSync(disariYol), "istemcinin verdiği yola yazıldı");
  });

  test("aktarılabilir kayıt yoksa 400 ve sebep döner; boş liste kabul edilmez", async () => {
    const bos = await api("takvime-aktar", { durusmalar: [] });
    assert.equal(bos.status, 400);
    const tarihsiz = await api("takvime-aktar", {
      durusmalar: [satir({ tarihSaat: "belirsiz" })],
    });
    assert.equal(tarihsiz.status, 400);
    assert.match(
      ((await tarihsiz.json()) as { error: { message: string } }).error.message,
      /uydurma|okunamadı/i,
    );
  });

  test("KABUL 6 — uçtan uca varsayılan çıktıda taraf adı YOK", async () => {
    await aktar({
      durusmalar: [
        satir({
          dosyaNo: "2026/888",
          dosyaTaraflari: [{ isim: "SENTETİK", soyad: "DAVACIOĞLU", sifat: "DAVACI" }],
        }),
      ],
    });
    const kapali = readFileSync(icsYolu, "utf8");
    assert.ok(!kapali.includes("DAVACIOĞLU"), "taraf adı varsayılan çıktıya sızdı");
    await aktar({
      durusmalar: [
        satir({
          dosyaNo: "2026/888",
          dosyaTaraflari: [{ isim: "SENTETİK", soyad: "DAVACIOĞLU", sifat: "DAVACI" }],
        }),
      ],
      taraflariEkle: true,
    });
    assert.ok(readFileSync(icsYolu, "utf8").includes("DAVACIO"), "seçenek açıkken yazılmadı");
  });
});
