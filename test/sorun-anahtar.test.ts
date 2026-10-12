// Sorun kayıtları KARARLI anahtarla eşlenir (evrakId ile değil).
//
// Gerçek arşivde ölçüldü (12 Eki 2026, sozer-pc): klonlamada fren tavanına
// takılan 87 evrak ertesi gün toplu eşitlemeyle indi, dosyaları diskte ve
// manifestte; ama 88 sorun kaydı AÇIK kaldı. Sebep: portal `evrakId`yi her liste
// yanıtında yeniden üretiyor (P19) ve kayıt `caseKey + evrakId` ile tutuluyordu;
// kapatan tur aynı belgeyi başka kimlikle gördüğü için kaydı hiç bulamıyordu.
// Mock'ta bu davranış `kimlikDoner: true` ile üretilir.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { MockUyap, opakToken, type MockDava, type MockEvrak } from "./mock-uyap/sunucu.js";
import { daemonKur, type Daemon } from "../src/server/daemon.js";
import { SorunDepo } from "../src/jobs/problems.js";
import { kayitAnahtari, sorunAnahtari } from "../src/store/eslestir.js";
import type { ManifestEvrak } from "../src/store/manifest.js";
import { makeHtml, tmpKok } from "./yardimci.js";

const CEREZ = "JSESSIONID=sorunanahtar1234567890";
const BIRIM = "Sentetik Sorun Asliye Hukuk Mahkemesi";
const BIRIM_ID = "9031";
const ESAS = "2026/731";
const CK = `${BIRIM}\u0000${ESAS}`;

describe("sorun anahtarı (birim)", () => {
  const kayit = (k: Partial<ManifestEvrak>): ManifestEvrak =>
    ({
      evrakId: "x",
      stableKey: "ana:1",
      path: "a.html",
      sha256: "0",
      isEkEvrak: false,
      category: "Gelen",
      yon: "Gelen",
      tur: "Müzekkere",
      gonderen: "Kalem",
      tip: "GDN",
      tarih: "01/09/2026",
      birimEvrakNo: "1001",
      dosyaKey: "01/09/2026",
      mdStatus: "ok",
      ...k,
    }) as ManifestEvrak;

  test("numaralı evrakta evrakId'den bağımsız; numarasızda yok", () => {
    const a = sorunAnahtari(kayitAnahtari(kayit({ evrakId: "tur1" })));
    const b = sorunAnahtari(kayitAnahtari(kayit({ evrakId: "tur2" })));
    assert.ok(a !== undefined);
    assert.equal(a, b, "aynı belge, farklı tur kimliği: anahtar değişmemeli");
    assert.notEqual(a, sorunAnahtari(kayitAnahtari(kayit({ gonderen: "Başka Gönderen" }))), "ikincil ölçüt ayırmalı");
    assert.equal(sorunAnahtari(kayitAnahtari(kayit({ birimEvrakNo: "" }))), undefined);
  });

  test("depo: farklı evrakId + aynı anahtar = aynı sorun; tekrar eklemek yığmaz", () => {
    const t = tmpKok();
    try {
      const d = new SorunDepo(join(t.kok, "sorunlar.json"));
      const ilk = d.ekle({ caseKey: CK, evrakId: "e#t1", anahtar: "K", tur: "indirme", hata: "fren" });
      assert.equal(d.acikBul(CK, "e#t2", "indirme", "K")?.sorunId, ilk.sorunId);
      // Anahtarsız arama eski davranıştır: başka turun kimliğiyle bulamaz.
      assert.equal(d.acikBul(CK, "e#t2", "indirme"), undefined);
      const ikinci = d.ekle({ caseKey: CK, evrakId: "e#t2", anahtar: "K", tur: "indirme", hata: "yine" });
      assert.equal(ikinci.sorunId, ilk.sorunId);
      assert.equal(d.acik().length, 1, "aynı belge iki kayıt açtı");
      assert.equal(ikinci.evrakId, "e#t2", "son turun kimliği taşınmalı");
      // Tür ve dava kimliğin parçasıdır.
      assert.equal(d.acikBul(CK, "e#t2", "donusum", "K"), undefined);
      assert.equal(d.acikBul("baska", "e#t2", "indirme", "K"), undefined);
      // Farklı anahtar, aynı evrakId: ayrı belge.
      assert.equal(d.acikBul(CK, "e#t2", "indirme", "BASKA"), undefined);
    } finally {
      t.temizle();
    }
  });

  test("depo: anahtarsız eski kayıt evrakId ile bulunur ve anahtar kazanır", () => {
    const t = tmpKok();
    try {
      const d = new SorunDepo(join(t.kok, "sorunlar.json"));
      const eski = d.ekle({ caseKey: CK, evrakId: "eski", tur: "indirme", hata: "eski sürüm" });
      assert.equal(eski.anahtar, undefined);
      assert.equal(d.acikBul(CK, "eski", "indirme", "K")?.sorunId, eski.sorunId);
      d.ekle({ caseKey: CK, evrakId: "eski", anahtar: "K", tur: "indirme", hata: "yeni sürüm" });
      assert.equal(d.acik().length, 1);
      assert.equal(d.acik()[0]?.anahtar, "K");
      assert.equal(d.acikBul(CK, "baska-tur", "indirme", "K")?.sorunId, eski.sorunId);
    } finally {
      t.temizle();
    }
  });
});

function belge(metin: string): Buffer {
  return makeHtml(`<div>${metin}</div>`, "Sentetik");
}

function davaKur(): MockDava {
  const ana = (ad: string, no: string, durum: MockEvrak["durum"]): MockEvrak => ({
    evrakId: opakToken(`sa-${ad}`),
    tur: "Müzekkere",
    gonderen: "Sentetik Kalem",
    tip: "GDN",
    tarih: "05/09/2026",
    birimEvrakNo: no,
    durum,
    contentTipi: durum === "yuklu" ? "text/html; charset=UTF-8" : "text/plain",
    icerik: durum === "yuklu" ? belge(`Sentetik ${ad} metni.`) : Buffer.from("", "utf8"),
  });
  const sagAna = ana("sag-ana", "8001", "yuklu");
  return {
    dosyaId: opakToken("sa-dosya"),
    birimAdi: BIRIM,
    birimId: BIRIM_ID,
    esasNo: ESAS,
    dosyaTur: "Hukuk Dava Dosyası",
    dosyaDurum: "Açık",
    yargiTuru: "0",
    kimlikDoner: true,
    evraklar: [
      sagAna,
      ana("bozuk-ana", "8002", "hata"),
      {
        evrakId: opakToken("sa-bozuk-ek"),
        tur: "Müzekkere Ek Evrak - Cevap",
        gonderen: "Sentetik Kalem",
        tip: "GDN",
        tarih: "05/09/2026",
        birimEvrakNo: "",
        durum: "hata",
        contentTipi: "text/plain",
        icerik: Buffer.from("", "utf8"),
        anaEvrakId: sagAna.evrakId,
        ekSira: 1,
      },
    ],
    taraflar: [{ adi: "SENTETİK DAVACI", rol: "Davacı" }],
  };
}

describe("sorun anahtarı (uçtan uca, dönen portal kimliği)", () => {
  const dava = davaKur();
  const mock = new MockUyap({
    birimler: [{ birimId: BIRIM_ID, birimAdi: BIRIM, yargiTuru: "0" }],
    davalar: [dava],
  });
  const ayar = tmpKok();
  const kok = tmpKok();
  let daemon: Daemon;
  const h = (ad: string) => daemon.isleyiciler.get(ad)!;

  before(async () => {
    await mock.baslat();
    daemon = daemonKur({
      ayarDir: ayar.kok,
      kok: kok.kok,
      portalUrl: mock.adres(),
      appVersion: "test",
      istekAralikMs: 1,
      gunlukTavan: 500,
    });
    await daemon.rpc.baslat();
    await h("giris")({ cerez: CEREZ });
  });

  after(async () => {
    await daemon.kapat();
    await mock.durdur();
    ayar.temizle();
    kok.temizle();
  });

  async function isBekle(isId: string): Promise<Record<string, unknown>> {
    for (let i = 0; i < 400; i++) {
      const is = (await h("is")({ isId })) as { durum: string };
      if (["hazir", "eksikli", "hata", "iptal", "duraklatildi"].includes(is.durum)) return is;
      await new Promise((c) => setTimeout(c, 10));
    }
    throw new Error("iş zaman aşımı");
  }

  type Kayit = { sorunId: string; tur: string; durum: string; evrakId?: string; anahtar?: string };
  const sorunlar = () => h("sorunlar")({}) as Promise<{ acik: Kayit[]; hepsi: Kayit[] }>;

  test("ana ve ek evrağın indirme sorunu, belge başka kimlikle indiğinde KAPANIR", async () => {
    // 1) Klon: bozuk ana + bozuk ek indirilemez, iki açık indirme kaydı.
    const klon = (await h("klonla")({ birim: BIRIM, esas: ESAS, kapsam: "hepsi" })) as { isId: string };
    const ilk = await isBekle(klon.isId);
    assert.equal(ilk.durum, "eksikli", `klon: ${JSON.stringify(ilk.hata)}`);
    const once = await sorunlar();
    const indirme = once.acik.filter((x) => x.tur === "indirme");
    assert.equal(indirme.length, 2, `açık indirme kaydı: ${JSON.stringify(once.acik)}`);
    for (const k of indirme) assert.ok(k.anahtar, `kayıt anahtarsız açıldı: ${JSON.stringify(k)}`);

    // 2) Portal düzeldi; sonraki listeleme kimlikleri değiştirecek (kimlikDoner).
    for (const e of dava.evraklar.filter((x) => x.durum === "hata")) {
      e.durum = "yuklu";
      e.contentTipi = "text/html; charset=UTF-8";
      e.icerik = belge(`Düzelen ${e.tur} metni.`);
    }
    const es = await isBekle(((await h("esitle")({ caseKey: CK })) as { isId: string }).isId);
    assert.equal(es.durum, "hazir", `eşitleme: ${JSON.stringify(es.hata)}`);

    // 3) İki kayıt da kapandı; kapatan turun kimliği açandan FARKLI (ölçüt kanıtı).
    const sonra = await sorunlar();
    for (const k of indirme) {
      const yeni = sonra.hepsi.find((x) => x.sorunId === k.sorunId);
      assert.equal(yeni?.durum, "cozuldu", `kayıt kapanmadı: ${JSON.stringify(yeni)}`);
    }
    const evraklar = (await h("evraklar")({ caseKey: CK })) as { evraklar: { evrakId: string }[] };
    const simdiki = new Set(evraklar.evraklar.map((e) => e.evrakId));
    for (const k of indirme) assert.ok(!simdiki.has(k.evrakId!), "kimlik dönmedi; test P19 durumunu üretmiyor");
    assert.equal(sonra.acik.filter((x) => x.tur === "indirme").length, 0);
    const durum = (await h("durum")({})) as { sorunAcik: number };
    assert.equal(durum.sorunAcik, 0);
  });
});
