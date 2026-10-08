// P15b — "yeni" rozeti: eşitleme damgasının motor tarafı.
//
// Bu dosya rozetin GÖRÜNÜŞÜNÜ değil VERİSİNİ sınar: damga ne zaman yazılır, ne
// zaman yazılmaz, ne zaman taşınır. Rozet metni ve satır HTML'i
// test/arsiv-ui.test.ts'tedir. Bütün senaryolar sahte portal + tmp arşiv
// köküyle çalışır; kullanıcının gerçek arşivine dokunulmaz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { daemonKur, type Daemon } from "../src/server/daemon.js";
import { belgeIsleyicileri } from "../src/server/belgeler.js";
import { ManifestDepo, type ManifestEvrak } from "../src/store/manifest.js";
import { caseKeyYap } from "../src/store/registry.js";
import { yeniMi, esitlemeSayaci, esitlemeKimligiSec } from "../src/store/esitleme.js";
import { MockUyap, opakToken, type MockDava, type MockEvrak } from "./mock-uyap/sunucu.js";
import { makeHtml, tmpKok } from "./yardimci.js";
import type { IsKaydi } from "../src/jobs/orchestrator.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BIRIM = "P15b Test Mahkemesi";

function evrak(n: number, govde = `Belge ${n}`): MockEvrak {
  return {
    evrakId: opakToken(`p15b-doc-${n}`),
    tur: `Dilekçe ${n}`,
    gonderen: "Test",
    tip: "GLN",
    tarih: "10/09/2026",
    birimEvrakNo: String(n),
    durum: "yuklu",
    contentTipi: "text/html",
    icerik: makeHtml(`<p>${govde}</p>`),
  };
}

async function harness(evrakSayisi = 2) {
  const t = tmpKok();
  const dava: MockDava = {
    dosyaId: opakToken("p15b-case"),
    birimAdi: BIRIM,
    birimId: "p15b",
    esasNo: "2026/1",
    dosyaTur: "Hukuk Dava Dosyası",
    dosyaDurum: "Açık",
    yargiTuru: "0",
    evraklar: Array.from({ length: evrakSayisi }, (_, i) => evrak(i + 1)),
  };
  const mock = new MockUyap({
    birimler: [{ birimId: "p15b", birimAdi: BIRIM, yargiTuru: "0" }],
    davalar: [dava],
  });
  await mock.baslat();
  const options = {
    ayarDir: t.kok,
    kok: join(t.kok, "archive"),
    portalUrl: mock.adres(),
    istekAralikMs: 15,
    oturumYenileMs: 0,
  };
  let daemon: Daemon = daemonKur(options);
  await daemon.rpc.baslat();
  daemon.oturum.girisYap("JSESSIONID=p15b", "manuel");
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
  // `hazirlik-ozet` daemon'un değil belge işleyicilerinin haritasındadır
  // (web.ts onu orada birleştirir); test de aynı yerden çağırır.
  const belge = async (name: string, body: Record<string, unknown> = {}): Promise<any> =>
    belgeIsleyicileri(daemon, options.kok).get(name)!(body);
  const klasor = () =>
    daemon.registry.oku().davalar.find((d) => d.caseKey === caseKey)!.klonYolu!;
  const manifest = () => new ManifestDepo(join(klasor(), "uyap-project.json")).oku()!;
  const klonla = async () => {
    const is = await call("klonla", { birim: BIRIM, esas: dava.esasNo, kapsam: "hepsi", avukat: "*" });
    await until((j) => j.some((x) => x.isId === is.isId && (x.durum === "hazir" || x.durum === "eksikli")));
    return is as IsKaydi;
  };
  const esitle = async () => {
    const is = await call("esitle", { caseKey });
    await until((j) => j.some((x) => x.isId === is.isId && (x.durum === "hazir" || x.durum === "eksikli")));
    return is as IsKaydi;
  };
  return {
    t, mock, dava, caseKey, call, belge, isler, until, klasor, manifest, klonla, esitle,
    restart: async () => {
      await daemon.kapat();
      daemon = daemonKur(options);
      await daemon.rpc.baslat();
      daemon.oturum.girisYap("JSESSIONID=p15b", "manuel");
    },
    close: async () => {
      await daemon.kapat();
      await mock.durdur();
      t.temizle();
    },
  };
}

/** Manifest'ten rozetli satırları çıkarır — UI'nin yaptığı türetmenin aynısı. */
function rozetliler(m: { evraklar: ManifestEvrak[]; sonEsitleme?: unknown }): string[] {
  return m.evraklar.filter((e) => yeniMi(e, m.sonEsitleme as never) !== null).map((e) => e.tur);
}

test("P15b: ilk indirme damgalar ama ROZETLEMEZ; sonraki eşitlemede yalnız gerçekten inen evrak rozetlenir", async () => {
  const h = await harness(2);
  try {
    await h.klonla();
    const ilk = h.manifest();
    // Damga yazılır (veri dürüst kalır) ama ilkIndirme gösterimi bastırır.
    assert.equal(ilk.evraklar.length, 2);
    assert.ok(ilk.evraklar.every((e) => e.indirmeDamgasi?.esitlemeId === ilk.sonEsitleme!.esitlemeId));
    assert.equal(ilk.sonEsitleme!.ilkIndirme, true);
    assert.equal(ilk.sonEsitleme!.kaynak, "klonla");
    assert.deepEqual(rozetliler(ilk), []);
    // "rozetli satır sayısı = sonEsitleme.yeni + yenilenen" sözleşmesi.
    assert.equal(ilk.sonEsitleme!.yeni, 0);
    assert.equal(ilk.sonEsitleme!.yenilenen, 0);

    // Portalde bir yeni evrak belirir; mevcut ikisi değişmez.
    h.dava.evraklar.push(evrak(3));
    await h.esitle();
    const ikinci = h.manifest();
    assert.equal(ikinci.sonEsitleme!.ilkIndirme, false);
    assert.deepEqual(rozetliler(ikinci), ["Dilekçe 3"]);
    assert.equal(ikinci.sonEsitleme!.yeni, 1);
    assert.equal(ikinci.sonEsitleme!.yenilenen, 0);
    // Kimlik gerçekten değişti; eski damgalar diskte DURUYOR ama artık eşleşmiyor.
    assert.notEqual(ikinci.sonEsitleme!.esitlemeId, ilk.sonEsitleme!.esitlemeId);
    assert.equal(
      ikinci.evraklar.filter((e) => e.indirmeDamgasi?.esitlemeId === ilk.sonEsitleme!.esitlemeId).length,
      2,
    );
  } finally {
    await h.close();
  }
});

test("P15b: hiçbir şeyin değişmediği eşitleme rozetleri DÜŞÜRÜR; korunan evrak eski damgasını kaybetmez", async () => {
  const h = await harness(2);
  try {
    await h.klonla();
    h.dava.evraklar.push(evrak(3));
    await h.esitle();
    const damgali = h.manifest();
    assert.equal(damgali.sonEsitleme!.yeni, 1);

    // Portalde hiçbir şey değişmedi: üç evrak da hash ile korunur.
    await h.esitle();
    const bos = h.manifest();
    assert.deepEqual(rozetliler(bos), []);
    assert.equal(bos.sonEsitleme!.yeni, 0);
    assert.equal(bos.sonEsitleme!.yenilenen, 0);
    // Korunan evrak damgasını KAYBETMEZ (manifestKaydiYap kaydı sıfırdan kurar;
    // taşınmasaydı rozet "bazen kayboluyor" diye görünürdü, hata vermeden).
    assert.equal(bos.evraklar.length, 3);
    for (const e of bos.evraklar) {
      const once = damgali.evraklar.find((x) => x.evrakId === e.evrakId)!;
      assert.deepEqual(e.indirmeDamgasi, once.indirmeDamgasi);
    }
  } finally {
    await h.close();
  }
});

test('P15b: baytları değişen evrak "yenilenen" damgası alır; yeni evraktan ayrı sayılır', async () => {
  const h = await harness(2);
  try {
    await h.klonla();
    // ÖLÇÜLEN DAVRANIŞ: indirici, kayıtlı hash ile diskteki baytlar uyuşuyorsa
    // evrakı YENİDEN İNDİRMEZ — portal içeriğinin aynı evrakId altında
    // değişmesi tek başına "yenilenen" üretmez. `yenilenen` dalı, yerel kaynak
    // manifest'ten AYRILDIĞINDA çalışır (test/p05.test.ts aynı yoldan geçiyor).
    // Rozet bu yüzden "portal bunu değiştirdi" demez, "bu evrak bu eşitlemede
    // yeniden indi" der; damga da tam olarak bunu kaydeder.
    const dizin = h.klasor();
    const hedef = join(dizin, h.manifest().evraklar.find((e) => e.tur === "Dilekçe 1")!.path);
    writeFileSync(hedef, "yerel değişiklik");
    h.dava.evraklar.push(evrak(3));
    await h.esitle();
    const m = h.manifest();
    const tur = (ad: string) => m.evraklar.find((e) => e.tur === ad)!.indirmeDamgasi?.tur;
    assert.equal(tur("Dilekçe 1"), "yenilenen");
    assert.equal(tur("Dilekçe 3"), "yeni");
    assert.equal(tur("Dilekçe 2"), "yeni"); // ilk klondan kalan damga, artık eşleşmiyor
    assert.equal(m.sonEsitleme!.yeni, 1);
    assert.equal(m.sonEsitleme!.yenilenen, 1);
    assert.equal(rozetliler(m).length, 2);
  } finally {
    await h.close();
  }
});

test("P15b: duraklatılan eşitleme rozet UYDURMAZ; devam edip tamamlanınca kısmi indirilenler de rozetlenir", async () => {
  const h = await harness(2);
  try {
    await h.klonla();
    const ilkIsaret = h.manifest().sonEsitleme!.esitlemeId;

    // Üç yeni evrak; ilki indikten sonra duraklat.
    for (const n of [3, 4, 5]) h.dava.evraklar.push(evrak(n));
    const is = await h.call("esitle", { caseKey: h.caseKey });
    await h.until((j) => (j.find((x) => x.isId === is.isId)?.ilerleme.biten ?? 0) >= 3);
    await h.call("duraklat", { isId: is.isId });
    const durdu = await h.until((j) => j.find((x) => x.isId === is.isId)?.durum === "duraklatildi");
    assert.equal(durdu.find((x) => x.isId === is.isId)!.durum, "duraklatildi");

    const yarim = h.manifest();
    // Kısmi kayıtlar ve damgaları DİSKTE — ama işaretçi hâlâ eski denemede.
    assert.equal(yarim.sonEsitleme!.esitlemeId, ilkIsaret);
    assert.deepEqual(rozetliler(yarim), []);
    const acik = yarim.acikEsitleme!.esitlemeId;
    assert.notEqual(acik, ilkIsaret);
    const kismiAdet = yarim.evraklar.filter((e) => e.indirmeDamgasi?.esitlemeId === acik).length;
    assert.ok(kismiAdet >= 1, `kısmi damga bekleniyordu, bulundu ${kismiAdet}`);
    assert.ok(kismiAdet < 3, "duraklatma üç evrakın hepsini indirmiş — senaryo kurulamadı");

    // Devam: kimlik DEVRALINIR, eski damgalar yeniden yazılmadan rozet kazanır.
    const devam = await h.call("devam", { isId: is.isId });
    await h.until((j) => j.some((x) => x.isId === devam.isId && (x.durum === "hazir" || x.durum === "eksikli")));
    const tam = h.manifest();
    assert.equal(tam.sonEsitleme!.esitlemeId, acik);
    assert.equal(tam.acikEsitleme, undefined);
    assert.deepEqual(rozetliler(tam).sort(), ["Dilekçe 3", "Dilekçe 4", "Dilekçe 5"]);
    assert.equal(tam.sonEsitleme!.yeni, 3);
    // Damga `at` değerleri farklı koşulardan gelir; karar kimliktendir, tarihten değil.
    const zamanlar = new Set(
      tam.evraklar.filter((e) => e.indirmeDamgasi?.esitlemeId === acik).map((e) => e.indirmeDamgasi!.at),
    );
    assert.ok(zamanlar.size >= 1);
  } finally {
    await h.close();
  }
});

test("P15b: iptal edilen eşitleme işaretçiyi İLERLETMEZ; kısmi inen evrak rozet almaz", async () => {
  const h = await harness(2);
  try {
    await h.klonla();
    const ilkIsaret = h.manifest().sonEsitleme!.esitlemeId;
    for (const n of [3, 4, 5]) h.dava.evraklar.push(evrak(n));
    const is = await h.call("esitle", { caseKey: h.caseKey });
    await h.until((j) => (j.find((x) => x.isId === is.isId)?.ilerleme.biten ?? 0) >= 3);
    await h.call("iptal", { isId: is.isId });
    await h.until((j) => j.find((x) => x.isId === is.isId)?.durum === "iptal");

    const m = h.manifest();
    assert.equal(m.sonEsitleme!.esitlemeId, ilkIsaret);
    assert.equal(m.sonEsitleme!.ilkIndirme, true);
    assert.deepEqual(rozetliler(m), []);
    // İptal damgayı SİLMEZ — silmek kısmi indirmeyi görünmez kılardı; yalnız
    // işaretçi ilerlemez. Kimlik `acikEsitleme` ile bir sonraki denemeye devrolur.
    assert.ok(typeof m.acikEsitleme?.esitlemeId === "string");
  } finally {
    await h.close();
  }
});

test("P15b: motor yeniden başlatma rozetleri kaybetmez; yeniden klonlama işaretçiyi düşürmez", async () => {
  const h = await harness(2);
  try {
    await h.klonla();
    h.dava.evraklar.push(evrak(3));
    await h.esitle();
    const once = h.manifest();
    assert.deepEqual(rozetliler(once), ["Dilekçe 3"]);

    await h.restart();
    const sonra = h.manifest();
    assert.deepEqual(rozetliler(sonra), ["Dilekçe 3"]);
    assert.equal(sonra.sonEsitleme!.esitlemeId, once.sonEsitleme!.esitlemeId);
    // RPC yanıtı da işaretçiyi taşır (UI karşılaştırmayı burada yapar).
    const yanit = await h.call("evraklar", { caseKey: h.caseKey });
    assert.deepEqual(yanit.sonEsitleme, sonra.sonEsitleme);
    assert.equal(yanit.adet, sonra.evraklar.length);

    // Yeniden klonlama manifest'i sıfırdan kurar; taşınmasaydı arşiv "ilk
    // indirme" sanılır ve bütün rozetler düşerdi.
    await h.klonla();
    const yeniden = h.manifest();
    assert.equal(yeniden.sonEsitleme!.ilkIndirme, false);
    assert.ok(yeniden.lastSyncedAt !== undefined);
    assert.deepEqual(rozetliler(yeniden), []); // hiçbir şey inmedi, rozet düştü
  } finally {
    await h.close();
  }
});

test("P15b: dava satırı sayacı (hazirlik-ozet) manifestten hesaplanır ve rozetli satır sayısıyla birebir eşittir", async () => {
  const h = await harness(2);
  try {
    await h.klonla();
    const ilkOzet = (await h.belge("hazirlik-ozet")).ozetler[0];
    assert.equal(ilkOzet.yeni, 0); // ilk indirme sayaç göstermez
    assert.equal(ilkOzet.yenilenen, 0);
    assert.equal(ilkOzet.toplam, 2); // P15a özeti bozulmadı

    const bozuk = join(h.klasor(), h.manifest().evraklar[0]!.path);
    writeFileSync(bozuk, "yerel değişiklik");
    h.dava.evraklar.push(evrak(3));
    await h.esitle();
    const m = h.manifest();
    const ozet = (await h.belge("hazirlik-ozet")).ozetler[0];
    assert.equal(ozet.yeni, 1);
    assert.equal(ozet.yenilenen, 1);
    assert.equal(ozet.yeni + ozet.yenilenen, rozetliler(m).length);
    assert.deepEqual(
      { yeni: ozet.yeni, yenilenen: ozet.yenilenen },
      esitlemeSayaci(m.evraklar, m.sonEsitleme),
    );
  } finally {
    await h.close();
  }
});

test("P15b: damga hiçbir kaynak baytını değiştirmez; damgasız eski kayda DOKUNULMAZ", async () => {
  const h = await harness(2);
  try {
    await h.klonla();
    const dizin = h.klasor();
    const mOnce = h.manifest();

    // Damgasız "eski" kayıt simülasyonu: bir kaydın damgasını elle sil.
    const elle = { ...mOnce, evraklar: mOnce.evraklar.map((e, i) => (i === 0 ? { ...e, indirmeDamgasi: undefined } : e)) };
    new ManifestDepo(join(dizin, "uyap-project.json")).yaz(elle);
    const damgasiz = h.manifest().evraklar.find((e) => e.indirmeDamgasi === undefined)!;
    assert.ok(damgasiz);
    assert.equal(yeniMi(damgasiz, h.manifest().sonEsitleme), null); // rozetsiz, "eski" diye işaretlenmiyor

    const kaynaklar = mOnce.evraklar.map((e) => {
      const yol = join(dizin, e.path);
      return { yol, sha: e.sha256, boyut: statSync(yol).size, icerik: readFileSync(yol) };
    });

    h.dava.evraklar.push(evrak(3));
    await h.esitle();
    const mSonra = h.manifest();
    for (const k of kaynaklar) {
      assert.deepEqual(readFileSync(k.yol), k.icerik);
      assert.equal(statSync(k.yol).size, k.boyut);
    }
    for (const e of mOnce.evraklar) {
      const sonra = mSonra.evraklar.find((x) => x.evrakId === e.evrakId)!;
      assert.equal(sonra.sha256, e.sha256);
      assert.equal(sonra.path, e.path);
      assert.equal(sonra.mdStatus, e.mdStatus);
      assert.equal(sonra.mdPath, e.mdPath);
    }
    // Elle silinen damga GERİ GELMEDİ: toplu göç yok.
    assert.equal(mSonra.evraklar.find((e) => e.evrakId === damgasiz.evrakId)!.indirmeDamgasi, undefined);
  } finally {
    await h.close();
  }
});

test("P15b: manifest damgasız okunur, eski dosya bozulmaz; kimlik devri saf fonksiyonda ölçülür", async () => {
  const t = tmpKok();
  try {
    // Damgasız (P15b öncesi) manifest'i yaz/oku döngüsü bozmaz.
    const yol = join(t.kok, "uyap-project.json");
    const eski = {
      dosyaId: "d", mahkeme: BIRIM, birimId: "b", esasNo: "2026/9", isIcra: false,
      clonedAt: "2026-01-01T00:00:00.000Z", lastSyncedAt: "2026-02-01T00:00:00.000Z",
      evraklar: [{
        evrakId: "e1", stableKey: "s1", path: "_kaynak/a.html", sha256: "x", isEkEvrak: false,
        category: "02-Dilekceler", yon: "Gelen" as const, tur: "Dilekçe", gonderen: "G",
        tarih: "01/01/2026", dosyaKey: "01/01/2026", mdStatus: "ok" as const,
      }],
    };
    new ManifestDepo(yol).yaz(eski);
    const okunan = new ManifestDepo(yol).oku()!;
    assert.equal(okunan.evraklar[0]!.indirmeDamgasi, undefined);
    assert.equal(okunan.sonEsitleme, undefined);
    assert.equal(okunan.acikEsitleme, undefined);
    assert.equal(yeniMi(okunan.evraklar[0]!, okunan.sonEsitleme), null);
    assert.deepEqual(esitlemeSayaci(okunan.evraklar, okunan.sonEsitleme), { yeni: 0, yenilenen: 0 });

    // Elle bozulmuş/yabancı değerlerde çökmez.
    writeFileSync(yol, JSON.stringify({ ...eski, sonEsitleme: 42, evraklar: [{ ...eski.evraklar[0], indirmeDamgasi: "hmm" }] }));
    const bozuk = new ManifestDepo(yol).oku()!;
    assert.equal(yeniMi(bozuk.evraklar[0]!, bozuk.sonEsitleme as never), null);

    // KARAR 3 — kimlik devri: açık deneme varsa kimlik DEVRALINIR, yoksa üretilir.
    assert.equal(esitlemeKimligiSec({ esitlemeId: "es-abc", at: "" }), "es-abc");
    assert.equal(esitlemeKimligiSec(undefined, () => "es-taze"), "es-taze");
    assert.equal(esitlemeKimligiSec({ esitlemeId: "", at: "" }, () => "es-taze"), "es-taze");
  } finally {
    t.temizle();
  }
});
