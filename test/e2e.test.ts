// Uçtan uca test: mock portal + daemon + RPC işleyicileri
// Akış: başlat → giriş → davalarim → klonla (dosya ağacı+manifest+md) →
// esitle (yeni evrak) → sorunlar → oturum bitti davranışı

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MockUyap, opakToken, type MockDava } from "./mock-uyap/sunucu.js";
import { daemonKur, type Daemon } from "../src/server/daemon.js";
import { makeUdf, makeHtml, miniPdf, tmpKok } from "./yardimci.js";

const UYAP_CEREZ = "JSESSIONID=mock1234567890abcdef; NSC_xxxx=abcdef";

function mockDavaKur(): MockDava {
  const dosyaId = opakToken("dosya-2026-928");
  const anaDilekce = opakToken("evrak-dilekce");
  const tebligat = opakToken("evrak-tebligat");
  const vekalet = opakToken("evrak-vekalet");
  const vekaletEk = opakToken("evrak-vekalet-ek");
  const yuklenmemis = opakToken("evrak-yuklenmemis");
  const hatali = opakToken("evrak-hatali");
  const makbuz = opakToken("evrak-makbuz");
  const karar = opakToken("evrak-karar");
  return {
    dosyaId,
    birimAdi: "Test Sulh Hukuk Mahkemesi",
    birimId: "1009999",
    esasNo: "2026/928",
    dosyaTur: "Hukuk Dava Dosyası",
    dosyaDurum: "Açık (2026-09-01 10:00:00.0)",
    yargiTuru: "0",
    evraklar: [
      {
        evrakId: anaDilekce,
        tur: "Cevap Dilekçesi",
        gonderen: "Av. TEST KARŞI",
        tip: "GLN",
        tarih: "04/09/2026",
        birimEvrakNo: "6973",
        durum: "yuklu",
        contentTipi: "application/octet-stream",
        icerik: makeUdf([
          "T.C. TEST SULH HUKUK MAHKEMESİ’NE",
          "",
          "DOSYA NO : 2026/928 E.",
          "Davalı : Ahmet YILMAZ",
          "AÇIKLAMALAR",
          "Cevap dilekçesi örneğidir. 10.000,00 TL alacağa itiraz edilmiştir.",
        ]),
      },
      {
        evrakId: tebligat,
        tur: "Kapalı Tebligat",
        gonderen: "Görevli Memur",
        tip: "GLN",
        tarih: "01/09/2026",
        birimEvrakNo: "6900",
        durum: "yuklu",
        contentTipi: "application/pdf",
        icerik: miniPdf(),
      },
      {
        evrakId: vekalet,
        tur: "Vekaletname",
        gonderen: "Av. TEST KARŞI",
        tip: "GLN",
        tarih: "03/09/2026",
        birimEvrakNo: "6938",
        durum: "yuklu",
        contentTipi: "image/jpeg",
        icerik: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]),
      },
      {
        evrakId: vekaletEk,
        tur: "Vekaletname Ek Evrak - Vekalet Pulu",
        gonderen: "Av. TEST KARŞI",
        tip: "GLN",
        tarih: "03/09/2026",
        birimEvrakNo: "",
        durum: "yuklu",
        contentTipi: "text/html; charset=UTF-8",
        icerik: makeHtml("<div>İDARE: TEST VEFAYI KAMU</div><div>Harç: 100,00 TL</div>", "Vekalet Pulu"),
        anaEvrakId: vekalet,
        ekSira: 0,
      },
      {
        evrakId: yuklenmemis,
        tur: "Delil Dilekçesi",
        gonderen: "Av. TEST KARŞI",
        tip: "GLN",
        tarih: "02/09/2026",
        birimEvrakNo: "6920",
        durum: "yuklenmemis",
        contentTipi: "text/plain; charset=utf-8",
        icerik: Buffer.from("Evrak UYAP sistemine yüklenmemiş.", "utf8"),
      },
      {
        evrakId: hatali,
        tur: "Genel Müzekkere",
        gonderen: "Test Sulh Hukuk Mahkemesi",
        tip: "GDN",
        tarih: "02/09/2026",
        birimEvrakNo: "6921",
        durum: "hata",
        contentTipi: "text/plain",
        icerik: Buffer.from("", "utf8"),
      },
      {
        evrakId: makbuz,
        tur: "Vekalet Pulu Makbuzu",
        gonderen: "AVUKAT PORTAL",
        tip: "GDN",
        tarih: "03/09/2026",
        birimEvrakNo: "6933",
        durum: "yuklu",
        contentTipi: "text/html; charset=UTF-8",
        icerik: makeHtml("<div>İDARE: TEST VEFAİ KAMU</div><div>Tarih: 03/09/2026</div>", "Vekalet Pulu Makbuzu"),
      },
      {
        evrakId: karar,
        tur: "Ertelenme Kararı",
        gonderen: "Test Sulh Hukuk Mahkemesi",
        tip: "GLN",
        tarih: "01/09/2026",
        birimEvrakNo: "6890",
        durum: "yuklu",
        contentTipi: "application/octet-stream",
        icerik: makeUdf([
          "T.C. TEST SULH HUKUK MAHKEMESİ",
          "Ertelenme Kararı",
          "Duruşma ertelenmiştir.",
        ]),
      },
    ],
  };
}

describe("e2e", () => {
  const mock = new MockUyap({
    birimler: [
      { birimId: "1009999", birimAdi: "Test Sulh Hukuk Mahkemesi", yargiTuru: "0" },
      { birimId: "2001111", birimAdi: "Test Asliye Ceza Mahkemesi", yargiTuru: "1" },
    ],
    davalar: [mockDavaKur()],
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
      istekAralikMs: 5,
      gunlukTavan: 100,
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
  async function isBekle(isId: string): Promise<Record<string, unknown>> {
    for (let i = 0; i < 200; i++) {
      const is = (await h("is")({ isId })) as { durum: string };
      if (is.durum === "hazir" || is.durum === "eksikli" || is.durum === "hata" || is.durum === "iptal" || is.durum === "duraklatildi") {
        return is;
      }
      await new Promise((c) => setTimeout(c, 25));
    }
    throw new Error("iş zaman aşımı");
  }

  test("girişsiz çağrı LOGIN_REQUIRED", async () => {
    await assert.rejects(
      () => h("davalarim")({ birim: "Test Sulh Hukuk Mahkemesi", yil: "2026", sira: "928", kapsam: "hepsi" }),
      (e: unknown) => (e as { code?: string }).code === "LOGIN_REQUIRED"
    );
  });

  test("manuel çerez girişi", async () => {
    const son = (await h("giris")({ cerez: UYAP_CEREZ })) as { yontem: string };
    assert.equal(son.yontem, "manuel");
    const durum = (await h("durum")({})) as { oturumDurum: string };
    assert.equal(durum.oturumDurum, "aktif");
  });

  test("giriş doğrulaması: portal rc≠SUCCESS çerezi reddeder, oturum.json yazılmaz", async () => {
    const oturumDosyasi = join(ayar.kok, "oturum.json");
    mock.gecerliCerezRegexAyarla(/hicbiri-uylesin/);
    try {
      await assert.rejects(
        h("giris")({ cerez: "JSESSIONID=kotu; x=1" }),
        (e: unknown) =>
          (e as { code?: string }).code === "LOGIN_REQUIRED" &&
          /doğrulamadı/.test((e as Error).message)
      );
      // doğrulanamayan çerez depoya YAZILMAMALI (varsa da silinir)
      assert.equal(existsSync(oturumDosyasi), false);
    } finally {
      mock.gecerliCerezRegexAyarla(undefined);
      await h("giris")({ cerez: UYAP_CEREZ }); // sonraki testler için toparla
    }
  });

  test("davalarim: iç içe dizi çözülür, dava bulunur", async () => {
    const son = (await h("davalarim")({
      birim: "Test Sulh Hukuk Mahkemesi",
      yil: "2026",
      sira: "928",
      kapsam: "hepsi",
    })) as { adet: number; davalar: { esasNo: string; dosyaId: string }[] };
    assert.equal(son.adet, 1);
    assert.equal(son.davalar[0]?.esasNo, "2026/928");
    assert.ok(son.davalar[0]?.dosyaId.startsWith('"'), "opak token tırnaklı");
  });

  test("klonla: tam dosya ağacı + manifest + md", async () => {
    const son = (await h("klonla")({
      birim: "Test Sulh Hukuk Mahkemesi",
      esas: "2026/928",
      kapsam: "hepsi",
      avukat: "TEST AVUKAT",
    })) as { isId: string };
    const is = await isBekle(son.isId);
    assert.equal(is.durum, "eksikli", `iş hatası: ${JSON.stringify(is.hata)}`);

    const dava = (await h("davalar")({})) as { davalar: { klonYolu?: string; klonAt?: string; sonEvrakSayisi?: number }[] };
    assert.ok(dava.davalar.length === 1);
    const klonYolu = dava.davalar[0]?.klonYolu ?? "";
    assert.ok(existsSync(klonYolu));

    // klasör ağacı
    const kaynak = join(klonYolu, "_kaynak", "evraklar");
    assert.ok(existsSync(join(kaynak, "Gelen", "02-Dilekceler")));
    assert.ok(existsSync(join(kaynak, "Gelen", "03-Tebligatlar")));
    assert.ok(existsSync(join(kaynak, "Gelen", "07-Vekalet-Idari")));
    assert.ok(existsSync(join(kaynak, "Dosya", "01-Kararlar-Tutanaklar")));
    assert.ok(existsSync(join(kaynak, "Giden", "06-Mali")));

    // dosya adı sözleşmesi
    assert.ok(existsSync(join(kaynak, "Gelen", "02-Dilekceler", "2026-09-04_Cevap Dilekçesi_6973.udf")));
    assert.ok(existsSync(join(kaynak, "Gelen", "03-Tebligatlar", "2026-09-01_Kapalı Tebligat_6900.pdf")));
    assert.ok(existsSync(join(kaynak, "Giden", "06-Mali", "2026-09-03_Vekalet Pulu Makbuzu_6933.html")));

    // md çıktıları
    assert.ok(existsSync(join(klonYolu, "evraklar", "Gelen", "02-Dilekceler", "2026-09-04_Cevap Dilekçesi_6973.md")));
    const dilekceMd = readFileSync(
      join(klonYolu, "evraklar", "Gelen", "02-Dilekceler", "2026-09-04_Cevap Dilekçesi_6973.md"),
      "utf8"
    );
    assert.ok(dilekceMd.includes("TEST SULH HUKUK MAHKEMESİ’NE"));
    assert.ok(dilekceMd.includes("2026/928 E."));

    // makbuz md
    assert.ok(existsSync(join(klonYolu, "evraklar", "Giden", "06-Mali", "2026-09-03_Vekalet Pulu Makbuzu_6933.md")));

    // manifest
    const manifest = JSON.parse(readFileSync(join(klonYolu, "uyap-project.json"), "utf8"));
    assert.equal(manifest.mahkeme, "Test Sulh Hukuk Mahkemesi");
    assert.equal(manifest.esasNo, "2026/928");
    const evraklar = manifest.evraklar as { evrakId: string; stableKey: string; mdStatus: string; category: string; sha256: string; yon: string; isEkEvrak: boolean; anaStableKey?: string }[];
    // 8 evraktan 2'si inmedi (yuklenmemis + hata) → 6 kayıt
    assert.equal(evraklar.length, 6);

    // md durumları
    assert.ok(evraklar.some((e) => e.mdStatus === "ok" && e.category === "02-Dilekceler"));
    // P15a: jpg vekaletname artık "gorsel" — sağlam belge, desteklenmeyen biçim
    // değil. `unsupported` bu sürümle hiçbir kayda YAZILMAZ.
    assert.ok(evraklar.some((e) => e.mdStatus === "gorsel" && e.category === "07-Vekalet-Idari"), "jpg vekaletname gorsel");
    assert.ok(!evraklar.some((e) => e.mdStatus === "unsupported"), "unsupported artık yazılmıyor");
    assert.ok(evraklar.some((e) => e.mdStatus === "ok" && e.category === "03-Tebligatlar" && e.yon === "Gelen"), "mini PDF metin katmanlı");

    // P15a gruplamanın dayandığı veri sözleşmesi: ek kayıt isEkEvrak taşır ve
    // anaStableKey'i ana kaydın stableKey'ine EŞİTTİR. web/evrak-durum.js
    // evrakGruplari() yalnız bu iki alana bakar; sözleşme kırılırsa gruplama
    // sessizce düz listeye döner.
    const ana = evraklar.find((e) => !e.isEkEvrak && e.category === "07-Vekalet-Idari");
    const ek = evraklar.find((e) => e.isEkEvrak);
    assert.ok(ana, "vekaletname ana kaydı");
    assert.ok(ek, "vekalet pulu ek kaydı");
    assert.equal(ek!.anaStableKey, ana!.stableKey);

    // registry
    const kayit = dava.davalar[0]!;
    assert.ok(kayit.klonAt !== undefined);
    assert.ok((kayit.sonEvrakSayisi ?? 0) >= 6);

    // evraklar RPC
    const evrakSon = (await h("evraklar")({
      caseKey: "Test Sulh Hukuk Mahkemesi\u00002026/928",
    })) as { adet: number; evraklar: { path: string; kaynakDurum: string }[] };
    assert.equal(evrakSon.adet, 6);
    // P15c — başarılı klondan sonra manifest'teki her yolun karşılığı diskte
    // DURUYOR. Bu satır, rozetin gerçek bir indirme akışında yanlış alarm
    // vermediğinin kanıtıdır (`adet` anlamı değişmedi, yalnız alan eklendi).
    for (const e of evrakSon.evraklar)
      assert.equal(e.kaynakDurum, "var", `${e.path} klon sonrası diskte yok`);
  });

  test("sorunlar: yuklenmemis + hata kaydedildi, yoksayılır", async () => {
    const acik = (await h("sorunlar")({})) as { acik: { sorunId: string; tur: string }[] };
    // 1 yuklenmemis + 1 indirme hatası
    assert.equal(acik.acik.length, 2);
    assert.ok(acik.acik.some((s) => s.tur === "yuklenmemis"));
    assert.ok(acik.acik.some((s) => s.tur === "indirme"));
    const id = acik.acik[0]!.sorunId;
    await h("sorunlar")({ islem: "yoksay", sorunId: id });
    const son2 = (await h("sorunlar")({})) as { acik: unknown[] };
    assert.equal(son2.acik.length, 1);
  });

  test("esitle: yeni evrak tespit edilip iner", async () => {
    // mock'a yeni evrak ekle
    const dava = mock.davalarBul("2026/928", "1009999")!;
    const yeniEvrakId = opakToken("evrak-yeni");
    dava.evraklar.push({
      evrakId: yeniEvrakId,
      tur: "Sonuç Tutanağı",
      gonderen: "Test Sulh Hukuk Mahkemesi",
      tip: "GLN",
      tarih: "05/09/2026",
      birimEvrakNo: "7000",
      durum: "yuklu",
      contentTipi: "application/octet-stream",
      icerik: makeUdf(["SONUÇ TUTANAĞI", "Dava hükme bağlanmıştır."]),
    });
    const son = (await h("esitle")({
      caseKey: "Test Sulh Hukuk Mahkemesi\u00002026/928",
    })) as { isId: string };
    const is = await isBekle(son.isId);
    assert.equal(is.durum, "eksikli", `iş hatası: ${JSON.stringify(is.hata)}`);
    const sonuc = is.sonuc as { yeniEvrak: number };
    assert.equal(sonuc.yeniEvrak, 1);

    const evrakSon = (await h("evraklar")({
      caseKey: "Test Sulh Hukuk Mahkemesi\u00002026/928",
    })) as { adet: number; evraklar: { tur: string }[] };
    assert.equal(evrakSon.adet, 7);
    assert.ok(evrakSon.evraklar.some((e) => e.tur === "Sonuç Tutanağı"));
  });

  // İNCELEMEDE YAKALANAN KUSUR: `SorunDepo.cozuldu()` hiçbir yerden
  // çağrılmıyordu (ölçüm: `grep -rn cozuldu src/ test/` → yalnız tanım).
  // Kullanıcı sorunu GERÇEKTEN düzeltse bile kayıt açık kalıyor, sayaç sonsuza
  // kadar yanıyordu; rozeti söndürmenin tek yolu her kayda "Yoksay" basmaktı.
  // Bu, ROADMAP §14'ün sayaca verdiği anlamı (`arac-yok` sayılır çünkü
  // "brew install poppler ile düzelir") boşa çıkarıyordu.
  test("düzelen sorun KAPANIR: kayıt cozuldu olur, sayaç geri düşer", async () => {
    const caseKey = "Test Sulh Hukuk Mahkemesi\u00002026/928";
    type Kayit = { sorunId: string; tur: string; durum: string; evrakId?: string };
    const sorunlar = () =>
      h("sorunlar")({}) as Promise<{ acik: Kayit[]; hepsi: Kayit[] }>;
    const durum = () => h("durum")({}) as Promise<{ sorunAcik: number; sorunAcikToplam: number }>;

    // 1) BAŞLANGIÇ ÖLÇÜMÜ — varsayım değil: hatalı evrak gerçekten açık bir
    //    `indirme` kaydı bırakmış olmalı.
    const once = await sorunlar();
    const indirmeKaydi = once.acik.find((x) => x.tur === "indirme");
    assert.ok(indirmeKaydi, "hatalı evrak açık indirme kaydı bırakmamış");
    const durumOnce = await durum();
    assert.ok(durumOnce.sorunAcik > 0);

    // 2) DÖNÜŞÜM KAYDI: bu turda inecek YENİ bir evrak için elle açık bir
    //    `donusum` kaydı bırakılır. Kimlik orkestratörün kullandığıyla birebir
    //    aynı (is.caseKey + evrakId); UDF dönüşümü dış araç istemez, yani
    //    sonuç ortamdan bağımsız olarak `ok`tur.
    const dava = mock.davalarBul("2026/928", "1009999")!;
    const donusenId = opakToken("evrak-donusum-duzelen");
    dava.evraklar.push({
      evrakId: donusenId,
      tur: "Bilirkişi Raporu",
      gonderen: "Test Sulh Hukuk Mahkemesi",
      tip: "GLN",
      tarih: "06/09/2026",
      birimEvrakNo: "7010",
      durum: "yuklu",
      contentTipi: "application/octet-stream",
      icerik: makeUdf(["BİLİRKİŞİ RAPORU", "Rapor metni."]),
    });
    const donusumKaydi = daemon.sorunlar.ekle({
      caseKey,
      evrakId: donusenId,
      tur: "donusum",
      hata: "pdftotext bulunamadı (brew install poppler)",
    });

    // 3) KULLANICI/ORTAM DÜZELTTİ: portal artık aynı evrağı veriyor.
    const bozuk = dava.evraklar.find((e) => e.tur === "Genel Müzekkere")!;
    bozuk.durum = "yuklu";
    bozuk.contentTipi = "application/octet-stream";
    bozuk.icerik = makeUdf(["GENEL MÜZEKKERE", "Müzekkere metni."]);

    const is = await isBekle(((await h("esitle")({ caseKey })) as { isId: string }).isId);
    assert.ok(is.durum === "hazir" || is.durum === "eksikli", `iş: ${JSON.stringify(is.hata)}`);

    // 4) İKİ KAYIT DA KAPANDI MI?
    const sonra = await sorunlar();
    for (const [ad, kayit] of [["indirme", indirmeKaydi!], ["donusum", donusumKaydi]] as const) {
      assert.ok(
        !sonra.acik.some((x) => x.sorunId === kayit.sorunId),
        `${ad} kaydı düzeldiği hâlde AÇIK kaldı`,
      );
      assert.equal(
        sonra.hepsi.find((x) => x.sorunId === kayit.sorunId)?.durum,
        "cozuldu",
        `${ad} kaydı listeden silinmiş ya da yanlış duruma geçmiş`,
      );
    }
    // Kayıt LİSTEDEN düşmez, yalnız sayaçtan düşer (P16 sözleşmesi).
    assert.equal(sonra.hepsi.length, once.hepsi.length + 1, "kayıt silinmiş");
    const durumSonra = await durum();
    assert.ok(
      durumSonra.sorunAcik < durumOnce.sorunAcik,
      `sayaç düşmedi: ${durumOnce.sorunAcik} → ${durumSonra.sorunAcik}`,
    );

    // 5) SINIR: hâlâ düzelmemiş kayıt (UYAP'a yüklenmemiş evrak) AÇIK kalır —
    //    kapatma "her şeyi temizle" değil, ölçülmüş bir düzelmedir.
    assert.ok(
      sonra.acik.some((x) => x.tur === "yuklenmemis"),
      "düzelmeyen kayıt da kapatılmış",
    );
  });

  test("klonla yeniden çağrılırsa idempotent (var olan dosya atlanır)", async () => {
    const on = (await h("evraklar")({ caseKey: "Test Sulh Hukuk Mahkemesi\u00002026/928" })) as { adet: number };
    const son = (await h("klonla")({
      birim: "Test Sulh Hukuk Mahkemesi",
      esas: "2026/928",
      kapsam: "hepsi",
      avukat: "TEST AVUKAT",
    })) as { isId: string };
    const is = await isBekle(son.isId);
    assert.equal(is.durum, "eksikli");
    const sonra = (await h("evraklar")({ caseKey: "Test Sulh Hukuk Mahkemesi\u00002026/928" })) as { adet: number };
    assert.equal(sonra.adet, on.adet, "adet değişmemeli");
  });

  test("oturum bittiğinde esitle işi OTURUM_BITTI ile sonlanır", async () => {
    await h("giris")({ cerez: "JSESSIONID=bozuk; x=1" });
    mock.gecerliCerezRegexAyarla(/mock1234567890abcdef/);
    try {
      const sonuc = await h("esitle")({ caseKey: "Test Sulh Hukuk Mahkemesi\u00002026/928" }) as { isId: string };
      const is = await isBekle(sonuc.isId);
      assert.equal(is.durum, "hata");
      assert.equal((is.hata as { code: string })?.code, "OTURUM_BITTI");
    } finally {
      // düzelt
      await h("giris")({ cerez: UYAP_CEREZ });
      mock.gecerliCerezRegexAyarla(undefined);
    }
  });

  test("RPC semasi uç", async () => {
    const b = daemon.rpc.bilgiGetir()!;
    const yanit = await fetch(`http://127.0.0.1:${b.port}/semasi`, {
      headers: { authorization: `Bearer ${b.token}` },
    });
    const sema = (await yanit.json()) as Record<string, unknown>;
    assert.ok(sema["durum"]);
    assert.ok(sema["klonla"]);
  });

  test("davaRef çözümü: klasör adı → caseKey", async () => {
    const { istemciYap } = await import("../src/cli/istemci.js");
    void istemciYap;
    // RPC düzeyinde: yol komutu
    const son = (await h("yol")({ caseKey: "Test Sulh Hukuk Mahkemesi\u00002026/928" })) as { yol: string };
    assert.ok(existsSync(son.yol));
  });
});
