// Otomasyon freni + oturum testleri

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Fren } from "../src/core/fren.js";
import { Hata } from "../src/core/errors.js";
import { OturumDepo, OturumYoneticisi } from "../src/uyap/session.js";
import { geciciKokler } from "./yardimci.js";
import { join } from "node:path";

const tmpKok = geciciKokler();

describe("fren", () => {
  test("istek aralığı bekletir", async () => {
    const f = new Fren({ istekAralikMs: 30 });
    const t0 = Date.now();
    await f.istek(async () => undefined);
    await f.istek(async () => undefined);
    const gecen = Date.now() - t0;
    assert.ok(gecen >= 25, `aralık korunmalı (geçen ${gecen} ms)`);
  });

  // UYAP üst üste binen sorguya belge yerine "Eş zamanlı olarak birden fazla sorgulama
  // yapamazsınız!" döndürür; aralıktan uzun süren istek bitmeden sıradaki yola çıkmamalı.
  test("yavaş istek bitmeden sıradaki başlamaz, aralık bitişten sayılır", async () => {
    const f = new Fren({ istekAralikMs: 30 });
    let ucusta = 0, enCok = 0;
    const olaylar: { bas: number; bit: number }[] = [];
    const is = (sureMs: number) => async () => {
      enCok = Math.max(enCok, ++ucusta);
      const bas = Date.now();
      await new Promise(c => setTimeout(c, sureMs));
      olaylar.push({ bas, bit: Date.now() });
      ucusta--;
    };
    await Promise.all([f.istek(is(120)), f.istek(is(10)), f.istek(is(10))]);
    assert.equal(enCok, 1, "uçuşta aynı anda tek istek olmalı");
    assert.ok(olaylar[1]!.bas - olaylar[0]!.bit >= 25, "aralık önceki isteğin bitişinden sayılmalı");
    assert.ok(olaylar[2]!.bas - olaylar[1]!.bit >= 25);
  });

  test("hata veren istek sırayı kilitlemez, hatası çağırana döner", async () => {
    const f = new Fren({ istekAralikMs: 1 });
    await assert.rejects(f.istek(async () => { throw new Error("koptu"); }), /koptu/);
    assert.equal(await f.istek(async () => 7), 7);
  });

  test("günlük tavan aşıldığında OTOMASYON_BUTCESI", () => {
    const f = new Fren({ gunlukTavan: 2, istekAralikMs: 1 });
    f.isBaslamadan();
    f.isBitti();
    f.isBaslamadan();
    f.isBitti();
    assert.throws(() => f.isBaslamadan(), (e: unknown) => (e as Hata).code === "OTOMASYON_BUTCESI");
  });

  test("bekleyen tavan", () => {
    const f = new Fren({ bekleyenTavan: 1, gunlukTavan: 100, istekAralikMs: 1 });
    f.isBaslamadan(); // bekleyen=1
    assert.throws(() => f.isBaslamadan(), (e: unknown) => (e as Hata).code === "OTOMASYON_BUTCESI");
    f.isBitti();
    f.isBaslamadan();
  });

  test("cooldown", () => {
    const f = new Fren({ cooldownMs: 50_000, gunlukTavan: 100, istekAralikMs: 1 });
    f.cooldownBaslat();
    assert.throws(() => f.isBaslamadan(), (e: unknown) => (e as Hata).code === "OTOMASYON_BUTCESI");
    assert.ok(f.durum().cooldownKalanSn > 0);
  });
});

describe("oturum", () => {
  function kur() {
    const { kok } = tmpKok();
    const depo = new OturumDepo(kok);
    let rc = "SUCCESS";
    const yonetici = new OturumYoneticisi(depo, {
      json: async () => ({ durum: 200, rc, govde: "{}" }),
    });
    return { yonetici, depo, kok, rcAyarla: (v: string) => (rc = v) };
  }

  test("girişsiz durum", async () => {
    const { yonetici } = kur();
    assert.equal(yonetici.durum, "giris_gerekiyor");
    await yonetici.probe();
    assert.equal(yonetici.durum, "giris_gerekiyor");
  });

  // İSTEK KURALI (duzeltme-istegi-2026-09-05-c): oturum.json YOKKEN portala
  // istek gitmemeli — giriş bekleyen kullanıcı için pano yoklaması bile
  // portalı rahatsız etmemeli (ve dış probe ara oturumu bozuyor).
  test("oturum yokken probe/probeTaze portala İSTEK ATMAMALI", async () => {
    const { kok } = tmpKok();
    const depo = new OturumDepo(kok);
    let sayac = 0;
    const yonetici = new OturumYoneticisi(depo, {
      json: async () => {
        sayac++;
        return { durum: 200, rc: "SUCCESS", govde: "{}" };
      },
    });
    await yonetici.probe();
    await yonetici.probeTaze();
    assert.equal(sayac, 0, "oturum.json yokken portala istek gitmemeli");
    assert.equal(yonetici.durum, "giris_gerekiyor");
  });

  test("çerezle giriş → aktif probe", async () => {
    const { yonetici } = kur();
    yonetici.girisYap("JSESSIONID=abc; X=1", "manuel");
    assert.equal(yonetici.durum, "aktif");
    const d = await yonetici.probe();
    assert.equal(d, "aktif");
    assert.equal(yonetici.gerektigiGibi(), "JSESSIONID=abc; X=1");
  });

  test("rc oturum bitti → bitti", async () => {
    const { yonetici, rcAyarla } = kur();
    yonetici.girisYap("JSESSIONID=abc", "manuel");
    rcAyarla("PRTL_GNL_10000-2");
    // istemci tarafı OTURUM_BITTI fırlatır; mock burada yalnız rc döner,
    // yani yönetici rc!=SUCCESS'i 'bitti' sayar
    const d = await yonetici.probe();
    assert.equal(d, "bitti");
  });

  test("JSESSIONID'siz çerez reddedilir", () => {
    const { yonetici } = kur();
    assert.throws(() => yonetici.girisYap("baska=1", "manuel"), /JSESSIONID/);
  });

  test("çıkış", async () => {
    const { yonetici, kok } = kur();
    yonetici.girisYap("JSESSIONID=abc", "manuel");
    yonetici.cikis();
    assert.equal(yonetici.durum, "giris_gerekiyor");
    assert.throws(() => yonetici.gerektigiGibi(), /giriş yapılmadı/);
    void kok;
    void join;
  });

  test("cerezDogrula: SUCCESS → true, depoya YAZMAZ, verilen çerezi kullanır", async () => {
    const { kok } = tmpKok();
    const depo = new OturumDepo(kok);
    const gelenCerezler: (string | undefined)[] = [];
    const yonetici = new OturumYoneticisi(depo, {
      json: async (_yol, _govde, cerez) => {
        gelenCerezler.push(cerez);
        return { durum: 200, rc: "SUCCESS", govde: "{}", contentType: "application/json" };
      },
    });
    assert.equal(await yonetici.cerezDogrula("JSESSIONID=gercek"), true);
    assert.equal(depo.oku(), null, "cerezDogrula depoya yazmamalı");
    assert.equal(gelenCerezler[0], "JSESSIONID=gercek", "depolanan değil VERİLEN çerez probe edilmeli");
  });

  test("cerezDogrula: katı kapı — html/rc'siz-JSON-olmayan/4xx/hata → false", async () => {
    const { kok } = tmpKok();
    const depo = new OturumDepo(kok);
    type Y = { durum: number; rc?: string; govde: string; contentType?: string };
    let yanit: Y = { durum: 200, govde: "<html>Giriş Sayfası</html>", contentType: "text/html" };
    let firlat: Error | null = null;
    const yonetici = new OturumYoneticisi(depo, {
      json: async () => {
        if (firlat) throw firlat;
        return yanit;
      },
    });
    // giriş sayfası HTML'i → ara (oturumsuz) çerez doğrulanamaz
    assert.equal(await yonetici.cerezDogrula("JSESSIONID=ara"), false);
    // rc'siz JSON 200 → taşıma rc başlığı koymuyorsa başarı sayılır
    yanit = { durum: 200, govde: "{}", contentType: "application/json" };
    assert.equal(await yonetici.cerezDogrula("JSESSIONID=ara"), true);
    // yönlendirme (302) → doğrulanmamış
    yanit = { durum: 302, govde: "", contentType: "text/html" };
    assert.equal(await yonetici.cerezDogrula("JSESSIONID=ara"), false);
    // oturum bitti hatası → false
    firlat = new Hata("OTURUM_BITTI", "portal oturumu bitti");
    assert.equal(await yonetici.cerezDogrula("JSESSIONID=ara"), false);
    // ağ hatası → false (bilinmezlik = doğrulanmamış)
    firlat = new Error("ağ hatası");
    assert.equal(await yonetici.cerezDogrula("JSESSIONID=ara"), false);
    assert.equal(depo.oku(), null);
  });
});
