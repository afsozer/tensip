// P18 — dosya tarafları: motor tarafı.
//
// Bu dosya GÖSTERİMİ değil VERİYİ ve İSTEK DİSİPLİNİNİ sınar: taraf sorgusu ne
// zaman portala gider, ne zaman gitmez, kayıt nereye yazılır ve hata hâlinde
// evrak indirme etkilenir mi. Satır HTML'i ve düğme durumları
// test/arsiv-ui.test.ts'tedir.
//
// GİZLİLİK: bütün taraf adları SENTETİKTİR. Gerçek müvekkil/karşı taraf adı bu
// dosyaya, mock'a ve log'a kopyalanmaz. Sahte portal + tmp arşiv köküyle
// çalışır; kullanıcının gerçek arşivine ve çalışan motoruna dokunulmaz.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { daemonKur, type Daemon } from "../src/server/daemon.js";
import { caseKeyYap, type DavaKaydi } from "../src/store/registry.js";
import { taraflariCoz, tarafCoz } from "../src/uyap/taraf.js";
import { MockUyap, opakToken, type MockDava, type MockEvrak } from "./mock-uyap/sunucu.js";
import { makeHtml, tmpKok } from "./yardimci.js";
import type { IsKaydi } from "../src/jobs/orchestrator.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BIRIM = "P18 Test İcra Müdürlüğü";
const TARAF_YOLU = "/dosya_taraf_bilgileri_brd.ajx";

// Canlı portalın ölçülen alan adları (`adi`/`rol`/`vekil`) — SENTETİK değerler.
const CANLI_BICIM = [
  { adi: "SENTETİK ALACAKLI A.Ş.", rol: "Alacaklı", vekil: "Av. Sentetik Vekil", kisiKurum: "Kurum" },
  { adi: "SENTETİK BORÇLU BİR", rol: "Borçlu", vekil: "", kisiKurum: "Kişi" },
  { adi: "SENTETİK BORÇLU İKİ", rol: "Borçlu", vekil: "", kisiKurum: "Kişi" },
];

function evrak(n: number): MockEvrak {
  return {
    evrakId: opakToken(`p18-doc-${n}`),
    tur: `Dilekçe ${n}`,
    gonderen: "Test",
    tip: "GLN",
    tarih: "10/09/2026",
    birimEvrakNo: String(n),
    durum: "yuklu",
    contentTipi: "text/html",
    icerik: makeHtml(`<p>Belge ${n}</p>`),
  };
}

async function harness(evrakSayisi = 3) {
  const t = tmpKok();
  const dava: MockDava = {
    dosyaId: opakToken("p18-case"),
    birimAdi: BIRIM,
    birimId: "p18",
    esasNo: "2026/7",
    dosyaTur: "İcra Dosyası",
    dosyaDurum: "Açık",
    yargiTuru: "2",
    evraklar: Array.from({ length: evrakSayisi }, (_, i) => evrak(i + 1)),
    taraflar: CANLI_BICIM,
  };
  const mock = new MockUyap({
    birimler: [{ birimId: "p18", birimAdi: BIRIM, yargiTuru: "2" }],
    davalar: [dava],
  });
  await mock.baslat();
  const options = {
    ayarDir: t.kok,
    kok: join(t.kok, "archive"),
    portalUrl: mock.adres(),
    istekAralikMs: 5,
    oturumYenileMs: 0,
  };
  const daemon: Daemon = daemonKur(options);
  await daemon.rpc.baslat();
  daemon.oturum.girisYap("JSESSIONID=p18", "manuel");
  const caseKey = caseKeyYap(BIRIM, dava.esasNo);
  const call = async (name: string, body: Record<string, unknown> = {}): Promise<any> =>
    daemon.isleyiciler.get(name)!(body);
  const isler = async (): Promise<IsKaydi[]> => (await call("isler")).isler;
  const until = async (kosul: (j: IsKaydi[]) => boolean) => {
    for (let n = 0; n < 800; n++) {
      const j = await isler();
      if (kosul(j)) return j;
      await wait(10);
    }
    throw new Error("beklenen iş durumuna gelinmedi");
  };
  const kayit = (): DavaKaydi =>
    daemon.registry.oku().davalar.find((d) => d.caseKey === caseKey)!;
  const tarafIstekleri = () => mock.istekler.filter((i) => i.yol === TARAF_YOLU).length;
  const bitir = async (is: IsKaydi): Promise<IsKaydi> => {
    const j = await until((liste) =>
      liste.some((x) => x.isId === is.isId && (x.durum === "hazir" || x.durum === "eksikli")),
    );
    return j.find((x) => x.isId === is.isId)!;
  };
  const klonla = async () =>
    bitir(await call("klonla", { birim: BIRIM, esas: dava.esasNo, kapsam: "hepsi", avukat: "*" }));
  const esitle = async () => bitir(await call("esitle", { caseKey }));
  return {
    t, mock, dava, daemon, caseKey, call, kayit, tarafIstekleri, klonla, esitle, until,
    close: async () => {
      await daemon.kapat();
      await mock.durdur();
      t.temizle();
    },
  };
}

// ── Ayrıştırma ───────────────────────────────────────────────────────────────
describe("P18 taraf çözümü — rol PORTALDAN gelir", () => {
  test("canlı biçim (adi/rol) ve eski biçim (isim+soyad/sifat) aynı sonuca çıkar", () => {
    const canli = taraflariCoz(CANLI_BICIM);
    assert.deepEqual(canli, [
      { adi: "SENTETİK ALACAKLI A.Ş.", rol: "Alacaklı", vekil: "Av. Sentetik Vekil" },
      { adi: "SENTETİK BORÇLU BİR", rol: "Borçlu" },
      { adi: "SENTETİK BORÇLU İKİ", rol: "Borçlu" },
    ]);
    const eski = taraflariCoz([
      { isim: "SENTETİK", soyad: "DAVACI", sifat: "Davacı", adres: "Denizli", vekil: "" },
    ]);
    assert.deepEqual(eski, [{ adi: "SENTETİK DAVACI", rol: "Davacı" }]);
  });

  test("ROL ADI OLDUĞU GİBİ TAŞINIR: ceza/çocuk etiketleri kategoriye zorlanmaz", () => {
    // Ölçüldü (12 Eylül, canlı): ceza (çocuk) dosyasında portal bu iki rolü
    // gönderiyor. Sabit "hukuk → davacı/davalı" tablosu burada yanlış olurdu.
    const t = taraflariCoz([
      { adi: "SENTETİK KATILAN", rol: "Katılan" },
      { adi: "SENTETİK ÇOCUK", rol: "Suça Sürüklenen Çocuk" },
      { adi: "SENTETİK YENİ ROL", rol: "Portalın Yarın Ekleyeceği Rol" },
    ]);
    assert.deepEqual(t.map((x) => x.rol), [
      "Katılan",
      "Suça Sürüklenen Çocuk",
      "Portalın Yarın Ekleyeceği Rol",
    ]);
  });

  test("kaynakta SABİT ROL EŞLEME TABLOSU yoktur (bekçi)", async () => {
    const { readFileSync } = await import("node:fs");
    for (const yol of ["../../src/uyap/taraf.ts", "../../web/taraf.js"]) {
      // taraf.ts derlenmiş .js olarak da okunabilirdi; kaynağı okuyoruz.
      const kaynak = readFileSync(new URL(yol, import.meta.url), "utf8");
      // Rol adları yalnız AÇIKLAMA satırlarında geçebilir; kod satırında bir
      // rol dizesi karşılaştırılıyorsa sabit tablo doğmuş demektir.
      const kodSatirlari = kaynak
        .split("\n")
        .filter((s) => !/^\s*(\/\/|\*|\/\*)/.test(s));
      for (const rol of ["Alacaklı", "Borçlu", "Davacı", "Davalı", "Katılan"]) {
        assert.ok(
          !kodSatirlari.some((s) => s.includes(rol)),
          `${yol} kod satırında sabit rol adı var: ${rol}`,
        );
      }
    }
  });

  test("adı olmayan satır listeyi düşürmez, sessizce atlanır", () => {
    assert.equal(tarafCoz({ rol: "Borçlu" }), null);
    assert.deepEqual(taraflariCoz([{ rol: "Borçlu" }, null, "metin", { adi: "SENTETİK", rol: "" }]), [
      { adi: "SENTETİK", rol: "" },
    ]);
  });
});

// ── P18a — liste satırının kendi dosyaId'siyle sorgu ─────────────────────────
describe("P18a liste-taraflar: klonlanmamış dosya + oturum damgası", () => {
  test("KLONLANMAMIŞ dosya için çalışır; `taraflar` aynı dosyada NOT_FOUND verir", async () => {
    const h = await harness();
    try {
      // Hiç klonlanmadı: registry boş.
      assert.equal(h.daemon.registry.oku().davalar.length, 0);
      const surum = h.daemon.oturum.surum;
      const yanit = await h.call("liste-taraflar", { dosyaId: h.dava.dosyaId, surum });
      assert.equal(yanit.dosyaId, h.dava.dosyaId);
      assert.equal(yanit.adet, 3);
      assert.deepEqual(yanit.taraflar.map((t: { rol: string }) => t.rol), [
        "Alacaklı",
        "Borçlu",
        "Borçlu",
      ]);
      // Mevcut uç bu işi göremez: caseKey ister ve klonlanmış dava arar.
      await assert.rejects(
        h.call("taraflar", { caseKey: h.caseKey }),
        (e: unknown) => (e as { code?: string }).code === "NOT_FOUND",
      );
      // Registry'ye HİÇBİR ŞEY yazılmadı: portal listesi kalıcı değildir.
      assert.equal(h.daemon.registry.oku().davalar.length, 0);
    } finally {
      await h.close();
    }
  });

  test("liste yanıtları oturum sürümünü taşır; sürüm uyuşmazsa istek PORTALA GİTMEZ", async () => {
    const h = await harness();
    try {
      const liste = await h.call("dosyalar-listele", {});
      assert.equal(liste.surum, h.daemon.oturum.surum);
      const arama = await h.call("davalarim", { birim: BIRIM, yil: "2026", sira: "7" });
      assert.equal(arama.surum, h.daemon.oturum.surum);

      const once = h.tarafIstekleri();
      await assert.rejects(
        h.call("liste-taraflar", { dosyaId: h.dava.dosyaId, surum: h.daemon.oturum.surum + 1 }),
        (e: unknown) => (e as { code?: string }).code === "LOGIN_REQUIRED",
      );
      assert.equal(h.tarafIstekleri(), once, "eski sürümlü istek portala gitmiş");
      // Sürüm hiç verilmezse tahmin edilmez.
      await assert.rejects(
        h.call("liste-taraflar", { dosyaId: h.dava.dosyaId }),
        (e: unknown) => (e as { code?: string }).code === "INVALID_INPUT",
      );
      assert.equal(h.tarafIstekleri(), once);
    } finally {
      await h.close();
    }
  });

  // ELLE UI KONTROLÜNDE YAKALANAN KUSURUN MOTOR TARAFI (P18 incelemesi):
  // pano, elindeki listenin CANLI oturuma ait olup olmadığını ölçebilmeli.
  // `durum` yanıtı bu yüzden oturum sürümünü taşır ve bu sayaç, listeyi
  // damgalayan sayacın TA KENDİSİDİR — iki ayrı kadran olursa düğme kapısı
  // sunucunun kapısıyla çelişir.
  test("`durum` yanıtı oturum SÜRÜMÜNÜ taşır; listeyi damgalayan sayaçla AYNIDIR", async () => {
    const h = await harness();
    try {
      const d1 = await h.call("durum", { yerel: true });
      assert.equal(d1.oturum.surum, h.daemon.oturum.surum);
      assert.equal(typeof d1.oturum.surum, "number");
      const liste = await h.call("dosyalar-listele", {});
      assert.equal(liste.surum, d1.oturum.surum, "liste damgası ile durum sürümü ayrışmış");

      // GEÇİCİ durum değişimi sürümü DEĞİŞTİRMEZ: pano bu ikisini ayırabilmeli.
      h.daemon.oturum.durum = "kontrol_ediliyor";
      const d2 = await h.call("durum", { yerel: true });
      assert.equal(d2.oturum.durum, "kontrol_ediliyor");
      assert.equal(d2.oturum.surum, d1.oturum.surum, "geçici durum sürümü artırmış");
      h.daemon.oturum.durum = "aktif";

      // Çıkış + yeniden giriş sürümü ARTIRIR: eski liste bayatlar.
      h.daemon.oturum.cikis();
      h.daemon.oturum.girisYap("JSESSIONID=p18-yeni", "manuel");
      const d3 = await h.call("durum", { yerel: true });
      assert.ok(d3.oturum.surum > d1.oturum.surum, "yeniden giriş sürümü artırmadı");
      // Eski damgayla taraf sorusu artık reddedilir; portala istek GİTMEZ.
      const once = h.tarafIstekleri();
      await assert.rejects(
        h.call("liste-taraflar", { dosyaId: h.dava.dosyaId, surum: liste.surum }),
        (e: unknown) => (e as { code?: string }).code === "LOGIN_REQUIRED",
      );
      assert.equal(h.tarafIstekleri(), once);
    } finally {
      await h.close();
    }
  });

  test("KABUL 1+2: liste açmak taraf isteği doğurmaz; aynı dosya iki kez sorulunca portala bir kez gidilir", async () => {
    const h = await harness();
    try {
      await h.call("dosyalar-listele", {});
      await h.call("davalarim", { birim: BIRIM, yil: "2026", sira: "7" });
      assert.equal(h.tarafIstekleri(), 0, "liste açılışı taraf isteği doğurmuş");

      const surum = h.daemon.oturum.surum;
      await h.call("liste-taraflar", { dosyaId: h.dava.dosyaId, surum });
      assert.equal(h.tarafIstekleri(), 1);
      await h.call("liste-taraflar", { dosyaId: h.dava.dosyaId, surum });
      assert.equal(h.tarafIstekleri(), 1, "ikinci sorgu portala gitmiş");
    } finally {
      await h.close();
    }
  });
});

// ── P18b — klon/eşitlemede kalıcı taraf ──────────────────────────────────────
describe("P18b registry'ye kalıcı taraf", () => {
  test("klonla taraf yazar; arşiv listesi OTURUMSUZ okunur ve portala istek gitmez", async () => {
    const h = await harness(3);
    try {
      await h.klonla();
      const k = h.kayit();
      assert.deepEqual(k.taraflar, [
        { adi: "SENTETİK ALACAKLI A.Ş.", rol: "Alacaklı", vekil: "Av. Sentetik Vekil" },
        { adi: "SENTETİK BORÇLU BİR", rol: "Borçlu" },
        { adi: "SENTETİK BORÇLU İKİ", rol: "Borçlu" },
      ]);
      assert.ok(k.taraflarAt && !Number.isNaN(Date.parse(k.taraflarAt)));
      assert.equal(h.tarafIstekleri(), 1, "klon başına tek taraf isteği");

      // KABUL 3: oturum kapalıyken arşiv listesi taraflarla gelir, portala
      // hiçbir istek gitmez.
      h.daemon.oturum.cikis();
      const oncekiIstek = h.mock.istekler.length;
      const davalar = (await h.call("davalar")).davalar as DavaKaydi[];
      assert.equal(davalar[0]!.taraflar!.length, 3);
      assert.equal(h.mock.istekler.length, oncekiIstek, "oturumsuz arşiv okuması portala gitmiş");
    } finally {
      await h.close();
    }
  });

  test("KABUL 4: taraf sorgusu HATA verse de eşitleme tamamlanır, evrak sayısı etkilenmez", async () => {
    const h = await harness(3);
    try {
      h.mock.tarafHatasi = true;
      const is = await h.klonla();
      assert.equal(is.durum, "hazir");
      const k = h.kayit();
      assert.equal(k.taraflar, undefined, "hata hâlinde taraf yazılmamalı");
      assert.equal(k.taraflarAt, undefined);
      assert.equal(k.sonEvrakSayisi, 3, "taraf hatası evrak sayısını düşürmüş");

      // Portal düzelince eşitleme değeri doldurur.
      h.mock.tarafHatasi = false;
      await h.esitle();
      assert.equal(h.kayit().taraflar!.length, 3);

      // Portal yeniden bozulursa ESKİ DEĞER KORUNUR; iş yine tamamlanır.
      h.mock.tarafHatasi = true;
      const ikinci = await h.esitle();
      assert.equal(ikinci.durum, "hazir");
      assert.equal(h.kayit().taraflar!.length, 3, "eski taraf değeri silinmiş");
      assert.equal(h.kayit().sonEvrakSayisi, 3);
    } finally {
      await h.close();
    }
  });

  test("YENİDEN KLONLAMA kaydı sıfırdan kurar ama tarafı DÜŞÜRMEZ", async () => {
    const h = await harness(2);
    try {
      await h.klonla();
      const ilkAt = h.kayit().taraflarAt!;
      h.mock.tarafHatasi = true;
      await h.klonla();
      // Literal kaydı yeniden kurar; taşınmayan alan sessizce düşerdi.
      assert.equal(h.kayit().taraflar!.length, 3);
      assert.equal(h.kayit().taraflarAt, ilkAt);
    } finally {
      await h.close();
    }
  });

  test("taraf isteği İŞ SAYACINI artırmaz (fren iş başına sayar, portal isteği başına değil)", async () => {
    const h = await harness(2);
    try {
      const once = (await h.call("durum", { yerel: true })).fren.gunlukSayac;
      await h.klonla();
      const sonra = (await h.call("durum", { yerel: true })).fren.gunlukSayac;
      assert.equal(sonra - once, 1, "tek klon işi sayaçta bir olmalı");
      assert.equal(h.tarafIstekleri(), 1, "klon bir taraf isteği atmalı");
    } finally {
      await h.close();
    }
  });
});
