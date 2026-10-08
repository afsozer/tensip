// Otomasyon freni + oturum testleri

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Fren } from "../src/core/fren.js";
import { Hata } from "../src/core/errors.js";
import { OturumDepo, OturumYoneticisi } from "../src/uyap/session.js";
import { geciciKokler } from "./yardimci.js";
import { join } from "node:path";
import { writeFileSync } from "node:fs";

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

describe("fren — portal yükü (8 Eki 2026)", () => {
  // Saat ve bekleme sahte: istenen gecikmeler gerçek zaman beklemeden ölçülür.
  function sahteSaat(rastgele: () => number = () => 0.5) {
    let simdi = Date.parse("2026-10-08T09:00:00Z");
    const beklemeler: number[] = [];
    const f = (sec: ConstructorParameters<typeof Fren>[0] = {}) => new Fren({
      simdi: () => simdi,
      rastgele,
      bekle: async (ms) => { beklemeler.push(ms); simdi += ms; },
      ...sec,
    });
    return { f, beklemeler, ilerlet: (ms: number) => { simdi += ms; }, ayarla: (t: number) => { simdi = t; } };
  }

  test("varsayılan aralık 3–5 sn: ilk istek beklemez, sonrakiler 3000 + sapma bekler", async () => {
    const degerler = [0, 0.999, 0.5];
    let i = 0;
    const s = sahteSaat(() => degerler[i++ % degerler.length]!);
    const f = s.f();
    for (let n = 0; n < 4; n++) await f.istek(async () => undefined);
    assert.deepEqual(s.beklemeler, [3000, 4998, 4000], "ilk istek beklememeli, sonrakiler [3000, 5000) aralığında");
    for (const b of s.beklemeler) assert.ok(b >= 3000 && b < 5000);
    assert.equal(f.durum().istekAralikMs, 3000);
    assert.equal(f.durum().istekSapmaMs, 2000);
  });

  test("sapma her istekte yeniden çekilir; sabit ritim oluşmaz", async () => {
    const s = sahteSaat(Math.random);
    const f = s.f();
    for (let n = 0; n < 30; n++) await f.istek(async () => undefined);
    assert.equal(s.beklemeler.length, 29);
    assert.ok(new Set(s.beklemeler).size > 10, `beklemeler çeşitlenmeli: ${s.beklemeler.join(",")}`);
    assert.ok(s.beklemeler.every((b) => b >= 3000 && b < 5000));
  });

  test("aralık değişince sapma onunla ölçeklenir; açık sapma verilirse o kullanılır", () => {
    assert.equal(new Fren({ istekAralikMs: 6000 }).durum().istekSapmaMs, 4000);
    assert.equal(new Fren({ istekAralikMs: 6000, istekSapmaMs: 500 }).durum().istekSapmaMs, 500);
    assert.equal(new Fren({ istekAralikMs: 0 }).durum().istekSapmaMs, 0);
  });

  test("istek sürerken geçen zaman beklemeden düşülür (aralık bitişten sayılır)", async () => {
    const s = sahteSaat(() => 0);
    const f = s.f();
    await f.istek(async () => undefined);
    s.ilerlet(1200); // kullanıcı 1,2 sn sonra yeni bir şey istedi
    await f.istek(async () => undefined);
    assert.deepEqual(s.beklemeler, [1800]);
  });

  test("günlük portal isteği tavanı: dolunca istek portala HİÇ gitmez", async () => {
    const s = sahteSaat();
    const f = s.f({ gunlukIstekTavan: 3 });
    let giden = 0;
    for (let n = 0; n < 3; n++) await f.istek(async () => { giden++; });
    await assert.rejects(
      f.istek(async () => { giden++; }),
      (e: unknown) => (e as Hata).code === "OTOMASYON_BUTCESI" && /3 portal isteği/.test((e as Error).message),
    );
    assert.equal(giden, 3);
    assert.equal(f.durum().gunlukIstek, 3);
    assert.equal(f.durum().gunlukIstekTavan, 3);
    // Tavan reddi sırayı kilitlemez; reddedilen istek sayılmaz.
    await assert.rejects(f.istek(async () => 1));
    assert.equal(f.durum().gunlukIstek, 3);
  });

  test("varsayılan günlük istek tavanı 500", () => {
    assert.equal(new Fren().durum().gunlukIstekTavan, 500);
  });

  test("hata veren istek de sayılır (portala gitti)", async () => {
    const s = sahteSaat();
    const f = s.f({ gunlukIstekTavan: 10 });
    await assert.rejects(f.istek(async () => { throw new Error("koptu"); }));
    assert.equal(f.durum().gunlukIstek, 1);
  });

  test("istek sayacı kalıcıdır, İstanbul gece yarısında sıfırlanır", async () => {
    const { kok } = tmpKok();
    const dosya = join(kok, "fren.json");
    const s = sahteSaat();
    s.ayarla(Date.parse("2026-10-08T20:59:00Z")); // İstanbul 23:59
    const f = s.f({ dosya, gunlukIstekTavan: 2 });
    f.yukle();
    await f.istek(async () => undefined);
    await f.istek(async () => undefined);
    const ikinci = s.f({ dosya, gunlukIstekTavan: 2 });
    ikinci.yukle();
    assert.equal(ikinci.durum().gunlukIstek, 2, "yeni süreç sayacı devralmalı");
    await assert.rejects(ikinci.istek(async () => undefined), (e: unknown) => (e as Hata).code === "OTOMASYON_BUTCESI");
    s.ayarla(Date.parse("2026-10-08T21:00:01Z")); // İstanbul 00:00
    await ikinci.istek(async () => undefined);
    assert.equal(ikinci.durum().gunlukIstek, 1);
    assert.equal(ikinci.durum().gun, "2026-10-09");
  });

  test("istek sayacı olmayan eski fren.json yüklenir ve 0'dan başlar", () => {
    const { kok } = tmpKok();
    const dosya = join(kok, "fren.json");
    writeFileSync(dosya, JSON.stringify({ surum: 1, gun: "2026-10-08", gunlukSayac: 3, cooldownBitis: 0 }));
    const f = new Fren({ dosya, simdi: () => Date.parse("2026-10-08T09:00:00Z") });
    f.yukle();
    assert.equal(f.durum().gunlukSayac, 3);
    assert.equal(f.durum().gunlukIstek, 0);
  });

  test("bozuk istek sayacı sıfırlanmaz, yükleme durur", () => {
    const { kok } = tmpKok();
    const dosya = join(kok, "fren.json");
    writeFileSync(dosya, JSON.stringify({ surum: 1, gun: "2026-10-08", gunlukSayac: 0, gunlukIstek: -4, cooldownBitis: 0 }));
    assert.throws(() => new Fren({ dosya }).yukle(), /fren\.json korunuyor/);
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
