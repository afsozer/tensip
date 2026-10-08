// P19 — HER EŞİTLEMEDE MANİFEST'İN ŞİŞMESİ.
//
// Kusur GERÇEK ARŞİVDE ölçüldü (12 Eylül): portalda hiçbir şey değişmediği
// hâlde aynı dosyanın manifesti 108 → 114 → 116 kayda çıktı, bir grup 1 → 3 → 5
// satır oldu, her eşitleme "2 yeni evrak" dedi. Üç ölçüm kusuru belirliyor:
//   1. Portalın HİÇBİR kimliği kalıcı değil (`evrakId` de `ggEvrakId` de her
//      İSTEKTE değişiyor) → mock'ta `kimlikDoner`.
//   2. `(birimEvrakNo, tur, tarih)` üçlüsü tekil değil; aynı üçlüyü taşıyan
//      iki satır GERÇEKTEN FARKLI belge olabilir → birleştirme YASAK.
//   3. UYAP bazı belgeleri her indirişte yeniden üretiyor: baytlar ve sha256
//      farklı, çıkarılan METİN aynı → içerik hash'i "bende zaten var mı"
//      sorusunu yanıtlayamaz → mock'ta `uretimDamgasi`.
//
// Bu dosyadaki bütün veriler SENTETİKTİR; gerçek arşive tek bayt dokunulmaz.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { MockUyap, opakToken, type MockDava, type MockEvrak } from "./mock-uyap/sunucu.js";
import { daemonKur, type Daemon } from "../src/server/daemon.js";
import { makeHtml, tmpKok } from "./yardimci.js";
import { arsiviDenetle } from "../src/store/denetim.js";
import { sadelestir } from "../src/store/sadelestir.js";
import { caseKeyYap, type DavaKaydi } from "../src/store/registry.js";
import { evraklariEslestir, grupOzeti, kayitAnahtari } from "../src/store/eslestir.js";
import type { ManifestEvrak } from "../src/store/manifest.js";
import { htmlToMd } from "../src/convert/htmlmd.js";

/** Arşivdeki her dosyanın içerik özeti + boyutu. Salt-okunurluk bekçisi. */
function parmak(kok: string): string {
  const satirlar: string[] = [];
  const gez = (d: string) => {
    for (const g of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const t = join(d, g.name);
      if (g.isDirectory()) gez(t);
      else if (g.isFile())
        satirlar.push(`${t}:${createHash("sha256").update(readFileSync(t)).digest("hex")}:${statSync(t).size}`);
    }
  };
  gez(kok);
  return satirlar.join("\n");
}

/** Bir ağaçtaki dosya yollarının sıralı kümesi. */
function dosyaKumesi(kok: string): string[] {
  const cikti: string[] = [];
  const gez = (d: string) => {
    for (const g of readdirSync(d, { withFileTypes: true })) {
      const t = join(d, g.name);
      if (g.isDirectory()) gez(t);
      else if (g.isFile()) cikti.push(t);
    }
  };
  gez(kok);
  return cikti.sort();
}

/** Grup anahtarı — `kayitAnahtari().grup` ile AYNI biçim (NUL ayraçlı). */
const GRUP = (no: string, tur: string, tarih: string) => ["ana", no, tur, tarih].join("\u0000");


const CEREZ = "JSESSIONID=p19mock1234567890";
const BIRIM = "Sentetik P19 Asliye Hukuk Mahkemesi";
const BIRIM_ID = "9019";
const ESAS = "2026/519";

/** HTML gövde: `htmlToMd` çıkardığında metin bu cümledir. */
function belge(metin: string): Buffer {
  return makeHtml(`<div>${metin}</div>`, "Sentetik Belge");
}

function evrak(sec: Partial<MockEvrak> & { ad: string; no: string; tarih: string; metin: string }): MockEvrak {
  return {
    evrakId: opakToken(`p19-${sec.ad}`),
    tur: sec.tur ?? "Müzekkere",
    gonderen: sec.gonderen ?? "Sentetik Kalem",
    tip: sec.tip ?? "GDN",
    tarih: sec.tarih,
    birimEvrakNo: sec.no,
    durum: "yuklu",
    contentTipi: "text/html; charset=UTF-8",
    icerik: belge(sec.metin),
    uretimDamgasi: sec.uretimDamgasi ?? false,
  };
}

/**
 * Sentetik dava — gerçek arşivde ölçülen üç durumu birlikte taşır:
 *   • `tekil`      : üçlüsü tekil, kimliği dönen sıradan evrak.
 *   • `belirsiz-1/2`: AYNI (birimEvrakNo, tur, tarih), her indirişte yeniden
 *     üretilen (baytı değişen, metni aynı) iki satır — asıl şişme kaynağı.
 *   • `ikiz-1/2`   : AYNI üçlü ama GERÇEKTEN FARKLI iki belge (metinleri
 *     ayrı). Bunlar asla tek kayda indirgenmemeli.
 */
function davaKur(): MockDava {
  return {
    dosyaId: opakToken("p19-dosya"),
    birimAdi: BIRIM,
    birimId: BIRIM_ID,
    esasNo: ESAS,
    dosyaTur: "Hukuk Dava Dosyası",
    dosyaDurum: "Açık",
    yargiTuru: "1",
    kimlikDoner: true,
    evraklar: [
      evrak({ ad: "tekil", no: "1001", tarih: "01/09/2026", metin: "Sentetik tekil evrak metni." }),
      evrak({ ad: "belirsiz-1", no: "5981", tarih: "02/09/2026", metin: "Sentetik sablon metni.", uretimDamgasi: true }),
      evrak({ ad: "belirsiz-2", no: "5981", tarih: "02/09/2026", metin: "Sentetik sablon metni.", uretimDamgasi: true }),
      evrak({ ad: "ikiz-1", no: "4234", tarih: "03/09/2026", metin: "Sentetik BIRINCI ikiz metni." }),
      evrak({ ad: "ikiz-2", no: "4234", tarih: "03/09/2026", metin: "Sentetik IKINCI ikiz metni." }),
    ],
    taraflar: [{ adi: "SENTETİK DAVACI", rol: "Davacı" }],
  };
}

describe("P19 eşitleme manifest'i şişirmiyor", () => {
  const dava = davaKur();
  const mock = new MockUyap({
    birimler: [{ birimId: BIRIM_ID, birimAdi: BIRIM, yargiTuru: "1" }],
    davalar: [dava],
  });
  const ayar = tmpKok();
  const kok = tmpKok();
  let daemon: Daemon;
  let klonYolu = "";

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

  const h = (ad: string) => daemon.isleyiciler.get(ad)!;

  async function isBekle(isId: string): Promise<Record<string, unknown>> {
    for (let i = 0; i < 400; i++) {
      const is = (await h("is")({ isId })) as { durum: string };
      if (["hazir", "eksikli", "hata", "iptal", "duraklatildi"].includes(is.durum)) return is;
      await new Promise((c) => setTimeout(c, 10));
    }
    throw new Error("iş zaman aşımı");
  }

  function manifest(): { evraklar: { path: string; birimEvrakNo?: string; tur: string; tarih: string; sha256: string; mdPath?: string }[] } {
    return JSON.parse(readFileSync(join(klonYolu, "uyap-project.json"), "utf8"));
  }

  function kaynakSayisi(): number {
    let n = 0;
    const gez = (d: string) => {
      for (const g of readdirSync(d, { withFileTypes: true })) {
        const t = join(d, g.name);
        if (g.isDirectory()) gez(t);
        else if (g.isFile()) n++;
      }
    };
    gez(join(klonYolu, "_kaynak"));
    return n;
  }

  function grupSayisi(no: string): number {
    return manifest().evraklar.filter((e) => e.birimEvrakNo === no).length;
  }

  async function esitle(
    beklenenDurum = "hazir",
  ): Promise<{ yeniEvrak: number; korunanEvrak: number; yenilenenEvrak: number; eksikEvrak: number }> {
    const caseKey = `${BIRIM}\u0000${ESAS}`;
    const baslat = (await h("esitle")({ caseKey })) as { isId: string };
    const is = (await isBekle(baslat.isId)) as { durum: string; sonuc?: Record<string, number> };
    assert.equal(is.durum, beklenenDurum, `eşitleme beklenmedik durumda bitti: ${JSON.stringify(is)}`);
    return is.sonuc as { yeniEvrak: number; korunanEvrak: number; yenilenenEvrak: number; eksikEvrak: number };
  }

  test("sahte portal kusuru ÜRETEBİLİYOR: kimlik her listede değişir, bayt her indirişte değişir, METİN aynı kalır", async () => {
    // BEKÇİNİN BEKÇİSİ. Mock bu iki davranışı yitirirse aşağıdaki kabul
    // testleri "geçer" ama hiçbir şey ölçmez: P19 kusuru sabit kimlikli,
    // sabit baytlı bir portalda ÜRETİLEMEZ. Sorgu doğrudan sahte portala
    // gider (motor katmanı karışmasın).
    const listele = async (): Promise<{ evrakId: string; birimEvrakNo: string }[]> => {
      const r = await fetch(`${mock.adres()}/list_dosya_evraklar.ajx`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: CEREZ },
        body: JSON.stringify({ dosyaId: dava.dosyaId, pageNumber: 1 }),
      });
      const g = (await r.json()) as { tumEvraklar: { ana: { evrakId: string; birimEvrakNo: string }[] } };
      return g.tumEvraklar.ana;
    };
    const indir = async (evrakId: string): Promise<Buffer> => {
      const r = await fetch(
        `${mock.adres()}/view_document_brd.uyap?evrakId=${encodeURIComponent(evrakId)}` +
          `&dosyaId=${encodeURIComponent(dava.dosyaId)}`,
        { headers: { cookie: CEREZ } },
      );
      return Buffer.from(await r.arrayBuffer());
    };

    const ilk = await listele();
    const ikinci = await listele();
    assert.equal(ilk.length, ikinci.length);
    const ayniKalan = ilk.filter((e, i) => e.evrakId === ikinci[i]!.evrakId).length;
    assert.equal(ayniKalan, 0, "portal kimliği dönmüyor; gerçek portalda 0/113 aynı kalmıştı");

    const hedef = ikinci.find((e) => e.birimEvrakNo === "5981")!;
    const a = await indir(hedef.evrakId);
    const b = await indir(hedef.evrakId);
    assert.notEqual(
      createHash("sha256").update(a).digest("hex"),
      createHash("sha256").update(b).digest("hex"),
      "baytlar her indirişte değişmiyor: yeniden üretim taklit edilmiyor",
    );
    assert.equal(
      htmlToMd(a.toString("utf8")).md,
      htmlToMd(b.toString("utf8")).md,
      "çıkarılan metin değişti: bu artık 'aynı belge' değil",
    );
  });

  test("klon: 5 portal satırı → 5 kayıt", async () => {
    const baslat = (await h("klonla")({ birim: BIRIM, esas: ESAS, kapsam: "hepsi" })) as { isId: string };
    const is = await isBekle(baslat.isId);
    assert.equal(is.durum, "hazir", `klon düştü: ${JSON.stringify(is)}`);
    const davalar = (await h("davalar")({})) as { davalar: { klonYolu?: string }[] };
    klonYolu = davalar.davalar[0]?.klonYolu ?? "";
    assert.ok(existsSync(klonYolu));
    assert.equal(manifest().evraklar.length, 5);
  });

  test("KABUL 1 — arka arkaya üç eşitlemede kayıt sayısı SABİT, 'yeni' ikinci ve üçüncüde SIFIR", async () => {
    const oncekiKayit = manifest().evraklar.length;
    const oncekiDosya = kaynakSayisi();
    const olcum: { kayit: number; dosya: number; yeni: number; yenilenen: number; korunan: number }[] = [];
    for (let tur = 0; tur < 3; tur++) {
      const s = await esitle();
      olcum.push({
        kayit: manifest().evraklar.length,
        dosya: kaynakSayisi(),
        yeni: s.yeniEvrak,
        yenilenen: s.yenilenenEvrak,
        korunan: s.korunanEvrak,
      });
    }
    assert.deepEqual(
      olcum.map((o) => o.kayit),
      [oncekiKayit, oncekiKayit, oncekiKayit],
      `manifest şişti: ${JSON.stringify(olcum)}`,
    );
    assert.deepEqual(
      olcum.map((o) => o.dosya),
      [oncekiDosya, oncekiDosya, oncekiDosya],
      `kaynak dosya çoğaldı: ${JSON.stringify(olcum)}`,
    );
    assert.deepEqual(
      olcum.map((o) => o.yeni),
      [0, 0, 0],
      `"yeni" sayacı yalan söylüyor: ${JSON.stringify(olcum)}`,
    );
    assert.deepEqual(
      olcum.map((o) => o.yenilenen),
      [0, 0, 0],
      `belge boşuna yeniden indirildi: ${JSON.stringify(olcum)}`,
    );
    assert.equal(olcum[2]!.korunan, 5);
  });

  test("KABUL 2 — aynı üçlüdeki GERÇEKTEN FARKLI iki belge ayrı kayıt olarak duruyor", () => {
    assert.equal(grupSayisi("4234"), 2, "iki farklı belge tek kayda indirgendi");
    const metinler = manifest()
      .evraklar.filter((e) => e.birimEvrakNo === "4234")
      .map((e) => readFileSync(join(klonYolu, e.mdPath!), "utf8"));
    assert.equal(new Set(metinler).size, 2, "iki ikizin metni birbirine karıştı");
    assert.ok(metinler.some((m) => m.includes("BIRINCI")));
    assert.ok(metinler.some((m) => m.includes("IKINCI")));
    // Belirsiz grup da ikiye sabitlenmeli: ne şişti ne de birleşti.
    assert.equal(grupSayisi("5981"), 2);
  });

  test("KABUL 3 — portal gruba belge eklerse o belge GERÇEKTEN iner (metin ölçülür, sayı değil)", async () => {
    // ÖNCEKİ HÂLİ SAYI ÖLÇÜYORDU ve kusuru göremiyordu: yeni satırı listenin
    // SONUNA ekliyor, üstelik METİNLERİ AYNI olan 5981 grubunu büyütüyordu.
    // Sıra bazlı eşleşme o iki koşulda tesadüfen doğru sonuç veriyor. Kusur
    // izole motorda ölçüldü: yeni satır listenin BAŞINDA olduğunda portalın
    // yeni belgesi HİÇ inmiyor, yerine kardeşinin ikinci kopyası kaydediliyor
    // ve grup doyduğu için belge bir daha ASLA inmiyordu.
    //
    // Bu yüzden ölçüt SAYI DEĞİL METİN: eşitleme sonrası her portal satırının
    // metni arşivde ayrı bir .md türevinde DURMALI.
    const grupMetinleri = (no: string): string[] =>
      manifest()
        .evraklar.filter((e) => e.birimEvrakNo === no)
        .map((e) => readFileSync(join(klonYolu, e.mdPath!), "utf8"));
    const metinVar = (no: string, kelime: string): boolean =>
      grupMetinleri(no).some((m) => m.includes(kelime));

    // ── VARYANT A: yeni satır listenin BAŞINDA, grup üyeleri GERÇEKTEN FARKLI
    // belgeler (4234). Kusurun tam şekli budur.
    const ucuncuIkiz = evrak({ ad: "ikiz-3", no: "4234", tarih: "03/09/2026", metin: "Sentetik UCUNCU ikiz metni." });
    const ilk = dava.evraklar.findIndex((e) => e.birimEvrakNo === "4234");
    dava.evraklar.splice(ilk, 0, ucuncuIkiz);

    const s = await esitle();
    assert.equal(grupSayisi("4234"), 3, "grup üç kayda çıkmalıydı");
    assert.equal(manifest().evraklar.length, 6);
    for (const kelime of ["BIRINCI", "IKINCI", "UCUNCU"]) {
      assert.ok(metinVar("4234", kelime), `${kelime} ikizi arşivde yok: belge KAYBOLDU`);
    }
    assert.equal(new Set(grupMetinleri("4234")).size, 3, "bir belgenin kopyası ikinci kez kaydedilmiş");
    // Belirsiz grubun satırları TAZELENİR (sıra tahminine güvenilmez) ama
    // İNDİRMEK YAZMAK DEĞİLDİR: inen iki eski belgenin metni eldeki kayıtları
    // birebir tuttuğu için o kayıtlar ve DOSYALARI korunur. P20 öncesinde bu
    // eşitleme "2 yenilenen" diyordu ve iki dosya boşuna yeniden yazılıyordu.
    assert.equal(s.yeniEvrak, 1, "tam olarak bir kayıt eklenmeliydi");
    assert.equal(s.yenilenenEvrak, 0, "metni tanınan belge boşuna yeniden yazıldı");
    assert.equal(s.korunanEvrak, 5, "metni tanınan belge korunan sayılmadı");

    // Ardından gelen eşitleme HİÇBİR ŞEY YAZMAMALI. (Portala istek gider —
    // belirsiz grup her turda ölçülür — ama arşiv tek bayt değişmez.)
    const s2 = await esitle();
    assert.equal(s2.yeniEvrak, 0);
    assert.equal(s2.yenilenenEvrak, 0, "doygun grup boşuna yeniden yazıldı");
    assert.equal(s2.korunanEvrak, 6);
    assert.equal(manifest().evraklar.length, 6);

    // ── VARYANT B: yeni satır listenin SONUNDA, metinleri AYNI olan grup.
    dava.evraklar.push(
      evrak({ ad: "belirsiz-3", no: "5981", tarih: "02/09/2026", metin: "Sentetik ucuncu sablon metni.", uretimDamgasi: true }),
    );
    const s3 = await esitle();
    assert.equal(grupSayisi("5981"), 3);
    assert.equal(manifest().evraklar.length, 7);
    assert.ok(metinVar("5981", "ucuncu sablon"), "üçüncü şablon inmedi");
    assert.equal(s3.yeniEvrak, 1);
    assert.equal(s3.korunanEvrak, 6, "metni tanınan belge korunan sayılmadı");
    const s4 = await esitle();
    assert.equal(s4.yeniEvrak, 0);
    assert.equal(s4.yenilenenEvrak, 0);
    assert.equal(manifest().evraklar.length, 7);
  });

  test("KABUL 3b — DÜŞEN indirme düzelince belge iner: M<N durumu kopyayla kapatılmaz", async () => {
    // Daha gerçekçi yol: bir indirme düşmüş (portal 500), kullanıcı yeniden
    // eşitliyor. Liste sırası HİÇ DEĞİŞMEZ, yani "yeniden sıralama" varsayımı
    // gerekmiyor — yine de manifest grubu portalınkinden EKSİK kalıyor.
    // Eski kod boşta kalan satırı sıradan seçtiği için eksik belgenin yerine
    // KARDEŞİNİN İKİNCİ KOPYASI iniyordu.
    const dorduncu = evrak({ ad: "ikiz-4", no: "4234", tarih: "03/09/2026", metin: "Sentetik DORDUNCU ikiz metni." });
    dorduncu.durum = "hata"; // portal bu satırda 500 döndürür
    dava.evraklar.splice(dava.evraklar.findIndex((e) => e.birimEvrakNo === "4234"), 0, dorduncu);
    const s = await esitle("eksikli");
    assert.equal(s.eksikEvrak, 1, "sahte portal düşen indirmeyi üretemedi");
    assert.equal(grupSayisi("4234"), 3, "düşen indirme kayıt eklememeli");

    // Portal düzeliyor: belge artık inebilmeli.
    dorduncu.durum = "yuklu";
    await esitle();
    assert.equal(grupSayisi("4234"), 4);
    const metinler = manifest()
      .evraklar.filter((e) => e.birimEvrakNo === "4234")
      .map((e) => readFileSync(join(klonYolu, e.mdPath!), "utf8"));
    for (const kelime of ["BIRINCI", "IKINCI", "UCUNCU", "DORDUNCU"]) {
      assert.ok(metinler.some((m) => m.includes(kelime)), `${kelime} arşivde yok: belge KAYBOLDU`);
    }
    assert.equal(new Set(metinler).size, 4, "bir belgenin kopyası ikinci kez kaydedilmiş");

    // Temizlik: sonraki testler altı kayıtlık dosyayı bekliyor.
    dava.evraklar = dava.evraklar.filter((e) => e.evrakId !== opakToken("p19-ikiz-3") && e.evrakId !== opakToken("p19-ikiz-4"));
  });

  test("KABUL 4 — portal gruptan bir satır düşürse eldeki kayıt SİLİNMEZ", async () => {
    dava.evraklar = dava.evraklar.filter((e) => e.evrakId !== opakToken("p19-belirsiz-3"));
    const oncekiYollar = manifest().evraklar.map((e) => e.path).sort();
    const s = await esitle();
    assert.equal(s.yeniEvrak, 0);
    assert.deepEqual(manifest().evraklar.map((e) => e.path).sort(), oncekiYollar, "kayıt silindi");
    for (const y of oncekiYollar) {
      assert.ok(statSync(join(klonYolu, y)).isFile(), `kaynak dosya kayboldu: ${y}`);
    }
  });

  test("KABUL 4 (geriye uyum) — P19 ÖNCESİ şişmiş manifest çökmeden açılır, BÜYÜMEZ ve onayla sadeleşir", async () => {
    // Kullanıcının gerçek dosyasının şekli: bir grupta portalın bildirdiğinden
    // fazla kayıt birikmiş ve manifestte `grupSayilari` YOK (eski sürüm yazdı).
    const manifestYolu = join(klonYolu, "uyap-project.json");
    const ham = JSON.parse(readFileSync(manifestYolu, "utf8")) as {
      grupSayilari?: unknown;
      evraklar: Record<string, string>[];
    };
    delete ham.grupSayilari; // P19 öncesi manifest
    const ornek = ham.evraklar.find((e) => e["birimEvrakNo"] === "5981")!;
    for (let n = 1; n <= 3; n++) {
      const kopyaYol = ornek["path"]!.replace(/\.(\w+)$/, `_sisme${n}.$1`);
      const kopyaMd = ornek["mdPath"]!.replace(/\.md$/, `_sisme${n}.md`);
      writeFileSync(join(klonYolu, kopyaYol), readFileSync(join(klonYolu, ornek["path"]!)));
      writeFileSync(join(klonYolu, kopyaMd), readFileSync(join(klonYolu, ornek["mdPath"]!)));
      ham.evraklar.push({ ...ornek, evrakId: `"ESKI-SISME-${n}"`, path: kopyaYol, mdPath: kopyaMd });
    }
    writeFileSync(manifestYolu, JSON.stringify(ham, null, 2));
    const sismisKayit = manifest().evraklar.length;
    const sismisDosya = kaynakSayisi();

    // 1) Şişmiş manifest ÇÖKMEDEN eşitlenir ve BÜYÜMEZ.
    const s = await esitle();
    assert.equal(s.yeniEvrak, 0);
    assert.equal(manifest().evraklar.length, sismisKayit, "şişmiş manifest daha da şişti");
    assert.equal(kaynakSayisi(), sismisDosya, "şişmiş arşive yeni dosya eklendi");
    // Eşitleme portalın grup sayımını YAZDI: fazlalık artık ölçülebilir.
    const sayilar = (JSON.parse(readFileSync(manifestYolu, "utf8")) as {
      grupSayilari?: Record<string, number>;
    }).grupSayilari;
    const portalSatiri = sayilar?.[GRUP("5981", "Müzekkere", "02/09/2026")];
    assert.equal(portalSatiri, 2, "portal grup sayımı manifeste yazılmadı");
    const fazla = grupSayisi("5981") - portalSatiri!;
    assert.ok(fazla > 0, "kurulum şişkin değil");

    // 2) Onaysız sadeleştirme yalnız planı gösterir.
    const kuru = await sadelestir(kok.kok, klonYolu, false);
    assert.equal(kuru.uygulandi, false);
    assert.equal(kuru.once, sismisKayit);
    assert.equal(kuru.sonra, sismisKayit - fazla);
    assert.equal(manifest().evraklar.length, sismisKayit, "onaysız çağrı kayıt düşürdü");

    // 3) Onaylı sadeleştirme fazlalığı düşürür, BELGELERE dokunmaz.
    const islak = await sadelestir(kok.kok, klonYolu, true);
    assert.equal(islak.uygulandi, true);
    assert.equal(manifest().evraklar.length, sismisKayit - fazla);
    assert.equal(grupSayisi("5981"), portalSatiri, "portalın bildirdiği kadar kayıt kalmalı");
    assert.equal(kaynakSayisi(), sismisDosya, "sadeleştirme belge dosyası sildi");
    assert.ok(existsSync(join(klonYolu, islak.yedek!)), "yedek bırakılmadı");

    // 4) Sonraki eşitleme geri getirmez: sayı sabit, yeni SIFIR.
    const son = await esitle();
    assert.equal(son.yeniEvrak, 0, "sadeleştirilen kayıt geri indi");
    assert.equal(manifest().evraklar.length, sismisKayit - fazla);
  });
});

// ── P19b/P19c — birikmiş şişkinlik: bildir, sonra onayla temizle ────────────
//
// Buradaki arşiv, KUSURUN ETKİSİNİ TAŞIYAN bir arşivdir: aynı grupta metni
// birebir aynı fazladan kayıtlar (baytları FARKLI — UYAP belgeyi her indirişte
// yeniden ürettiği için) manifeste birikmiş durumda. Kurulum sentetiktir;
// düzeltme öncesi eşitlemenin ürettiği duruma birebir benzer.

describe("P19b/P19c birikmiş şişkinlik", () => {
  const kok = tmpKok();
  let klasor = "";
  let davalar: DavaKaydi[] = [];

  const BIRIM2 = "Sentetik P19b Asliye Hukuk Mahkemesi";
  const ESAS2 = "2026/611";
  const SISMIS_GRUP = GRUP("5981", "Müzekkere", "02/09/2026");

  interface Satir {
    ad: string;
    no: string;
    tarih?: string;
    /** null = görsel evrak: metin katmanı yok, aynılık ÖLÇÜLEMEZ. */
    metin: string | null;
    /** Baytları farklılaştırır — UYAP'ın üretim damgasının taklidi. */
    baytEki: string;
    /** `birimEvrakNo` YAZILMAZ: gruplanamayan (numarasız) ana evrak. */
    numarasiz?: boolean;
  }

  function arsivKur(satirlar: Satir[], grupSayilari?: Record<string, number>): void {
    klasor = join(kok.kok, "Avukat UYAP", "AVUKAT", "Hukuk", "HUKUK MAHKEMESI", `${BIRIM2} 2026-611`);
    rmSync(klasor, { recursive: true, force: true });
    mkdirSync(klasor, { recursive: true });
    const kayitlar = satirlar.map((s, i) => {
      const rel = `_kaynak/evraklar/Dosya/03-Kararlar/${s.ad}.html`;
      const tam = join(klasor, rel);
      mkdirSync(join(tam, ".."), { recursive: true });
      const govde = `<html><body><div>${s.metin ?? "gorsel"}</div><!-- ${s.baytEki} --></body></html>`;
      writeFileSync(tam, govde);
      const mdRel = `evraklar/Dosya/03-Kararlar/${s.ad}.md`;
      if (s.metin !== null) {
        const mdTam = join(klasor, mdRel);
        mkdirSync(join(mdTam, ".."), { recursive: true });
        writeFileSync(mdTam, `${s.metin}\n`);
      }
      return {
        evrakId: `"OPAK-P19B-${i}-abc123"`,
        stableKey: `ana:${s.no}`,
        path: rel,
        sha256: createHash("sha256").update(govde).digest("hex"),
        isEkEvrak: false,
        category: "03-Kararlar",
        yon: "Dosya",
        tur: "Müzekkere",
        tip: "GDN",
        gonderen: "Sentetik Kalem",
        tarih: s.tarih ?? "02/09/2026",
        ...(s.numarasiz === true ? {} : { birimEvrakNo: s.no }),
        dosyaKey: "sentetik",
        mdStatus: s.metin === null ? "gorsel" : "ok",
        ...(s.metin === null ? {} : { mdPath: mdRel }),
        boyut: Buffer.byteLength(govde),
      };
    });
    writeFileSync(
      join(klasor, "uyap-project.json"),
      JSON.stringify(
        {
          surum: 1,
          dosyaId: '"OPAK-P19B-DOSYA"',
          mahkeme: BIRIM2,
          birimId: "9019",
          esasNo: ESAS2,
          isIcra: false,
          clonedAt: "2026-09-01T10:00:00.000Z",
          ...(grupSayilari ? { grupSayilari } : {}),
          evraklar: kayitlar,
        },
        null,
        2,
      ),
    );
    davalar = [
      {
        caseKey: caseKeyYap(BIRIM2, ESAS2),
        portal: "avukat",
        kaynak: ["sentetik"],
        dosyaNo: ESAS2,
        birimAdi: BIRIM2,
        birimId: "9019",
        group: "Hukuk",
        kod: "HUKUK MAHKEMESI",
        yargiTuru: "1",
        isIcra: false,
        isCbs: false,
        kapsam: "hepsi",
        portalGoruldu: "2026-09-01T10:00:00.000Z",
        klonYolu: klasor,
      },
    ];
  }

  /** Şişmiş grup: portal 2 satır bildiriyor, manifestte 5 kayıt birikmiş. */
  const SISMIS: Satir[] = [
    { ad: "sablon-1", no: "5981", metin: "Ayni sablon metni.", baytEki: "uretim 1" },
    { ad: "sablon-2", no: "5981", metin: "Ayni sablon metni.", baytEki: "uretim 22" },
    { ad: "sablon-3", no: "5981", metin: "Ayni sablon metni.", baytEki: "uretim 333" },
    { ad: "sablon-4", no: "5981", metin: "Ayni sablon metni.", baytEki: "uretim 4444" },
    { ad: "sablon-5", no: "5981", metin: "Ayni sablon metni.", baytEki: "uretim 55555" },
    // Aynı üçlü, FARKLI metin: iki gerçek belge, dokunulmamalı.
    { ad: "ikiz-1", no: "4234", tarih: "03/09/2026", metin: "Birinci ikiz.", baytEki: "a" },
    { ad: "ikiz-2", no: "4234", tarih: "03/09/2026", metin: "Ikinci ikiz.", baytEki: "b" },
    // Görsel: metni ölçülemez, otomatik temizliğe GİRMEZ.
    { ad: "tarama-1", no: "7777", metin: null, baytEki: "g1" },
    { ad: "tarama-2", no: "7777", metin: null, baytEki: "g2" },
  ];

  after(() => kok.temizle());

  test("KABUL 6 — denetim şişmiş grubu BULGU olarak gösterir", async () => {
    arsivKur(SISMIS, { [SISMIS_GRUP]: 2 });
    const s = await arsiviDenetle({ kok: kok.kok, davalar });
    const bulgular = s.bulgular.filter((b) => b.tur === "grup-sismis");
    assert.equal(bulgular.length, 1, `bulgular: ${JSON.stringify(s.bulgular.map((b) => b.tur))}`);
    assert.equal(bulgular[0]!.agirlik, "bulgu");
    assert.equal(bulgular[0]!.eksen, "kayit");
    assert.equal(bulgular[0]!.adet, 5);
    assert.match(bulgular[0]!.aciklama, /Portal bu grup için 2 satır bildiriyor; 3 kayıt fazla/);
    // Farklı metinli ikizler ve görsel evrak bu bulguyu DOĞURMAZ.
    assert.ok(!bulgular[0]!.yol.includes("ikiz"));
    assert.ok(!bulgular[0]!.yol.includes("tarama"));
    assert.ok(s.sayilar.bulgu >= 1);
  });

  test("portal sayısı bilinmeyen ESKİ manifestte bulgu var ama sadeleştirme kayıt DÜŞÜRMEZ", async () => {
    arsivKur(SISMIS); // grupSayilari YOK — P19 öncesi manifest
    const s = await arsiviDenetle({ kok: kok.kok, davalar });
    const bulgu = s.bulgular.find((b) => b.tur === "grup-sismis");
    assert.ok(bulgu, "eski manifestte de bulgu görünmeli");
    assert.match(bulgu!.aciklama, /kayıtlı değil/);
    const once = parmak(kok.kok);
    const plan = await sadelestir(kok.kok, klasor, true);
    assert.equal(plan.uygulandi, false, "ölçülemeyen fazlalık silinmemeli");
    assert.equal(plan.sonra, plan.once);
    assert.equal(plan.olcusuzGrup, 1);
    assert.equal(parmak(kok.kok), once, "onaylı çağrı bile ölçüsüz grupta yazmamalı");
  });

  test("KABUL 5 — onaysız sadeleştirme TEK BAYT değiştirmez", async () => {
    arsivKur(SISMIS, { [SISMIS_GRUP]: 2 });
    const once = parmak(kok.kok);
    const plan = await sadelestir(kok.kok, klasor, false);
    assert.equal(plan.uygulandi, false);
    assert.equal(plan.once, 9);
    assert.equal(plan.sonra, 6);
    assert.equal(plan.gruplar.length, 1);
    assert.equal(plan.gruplar[0]!.dusen.length, 3);
    assert.equal(parmak(kok.kok), once, "onaysız çağrı arşivi değiştirdi");
  });

  test("KABUL 5 — onaylı sadeleştirme YEDEK bırakır, satır düşer, BELGE DOSYASI DURUR", async () => {
    arsivKur(SISMIS, { [SISMIS_GRUP]: 2 });
    const belgelerOnce = dosyaKumesi(join(klasor, "_kaynak"));
    const plan = await sadelestir(kok.kok, klasor, true);
    assert.equal(plan.uygulandi, true);
    assert.ok(plan.yedek !== undefined && /^uyap-project\.yedek-\d+\.json$/.test(plan.yedek));
    assert.ok(existsSync(join(klasor, plan.yedek!)), "yedek yazılmadı");

    const man = JSON.parse(readFileSync(join(klasor, "uyap-project.json"), "utf8")) as {
      evraklar: { birimEvrakNo: string }[];
    };
    assert.equal(man.evraklar.length, 6);
    // Portalın bildirdiği kadarı KALIR: 5981 grubunda 2 kayıt.
    assert.equal(man.evraklar.filter((e) => e.birimEvrakNo === "5981").length, 2);
    // Farklı metinli iki belge ve iki görsel evrak DOKUNULMADAN duruyor.
    assert.equal(man.evraklar.filter((e) => e.birimEvrakNo === "4234").length, 2);
    assert.equal(man.evraklar.filter((e) => e.birimEvrakNo === "7777").length, 2);
    // HİÇBİR BELGE DOSYASI SİLİNMEDİ.
    assert.deepEqual(dosyaKumesi(join(klasor, "_kaynak")), belgelerOnce);
    // Yedek eski hâli birebir taşıyor: geri dönülebilir.
    const yedek = JSON.parse(readFileSync(join(klasor, plan.yedek!), "utf8")) as { evraklar: unknown[] };
    assert.equal(yedek.evraklar.length, 9);
  });

  test("sadeleştirme sonrası denetim: şişme bulgusu KAPANIR, dosyalar yetim (bilgi) olur", async () => {
    arsivKur(SISMIS, { [SISMIS_GRUP]: 2 });
    await sadelestir(kok.kok, klasor, true);
    const s = await arsiviDenetle({ kok: kok.kok, davalar });
    assert.equal(s.bulgular.filter((b) => b.tur === "grup-sismis").length, 0);
    const yetim = s.bulgular.filter((b) => b.tur === "yetim-dosya");
    assert.equal(yetim.length, 3, "düşen kayıtların dosyaları kayıtsız dosya olarak görünmeli");
    for (const y of yetim) assert.equal(y.agirlik, "bilgi", "yetim dosya ARIZA değildir");
  });

  test("grup-ikiz — BAYT BAYT aynı iki kayıt bulgudur: sayı doğru ama kardeş belge eksik", async () => {
    // İnceleme bu hâli ölçtü: düzeltme öncesi eşitleme, büyüyen grupta
    // portalın yeni belgesini indirmek yerine kardeşinin İKİNCİ KOPYASINI
    // kaydediyordu. Kayıt sayısı portalınkine EŞİT kaldığı için `grup-sismis`
    // susuyor, yollar farklı olduğu için `mukerrer-kayit` de susuyordu:
    // denetim eksik belgeli arşive "sağlam" diyordu.
    arsivKur(
      [
        // Aynı grupta, BİREBİR AYNI baytlar, AYRI dosyalar.
        { ad: "kopya-1", no: "4234", tarih: "03/09/2026", metin: "Ikinci ikiz.", baytEki: "ayni" },
        { ad: "kopya-2", no: "4234", tarih: "03/09/2026", metin: "Ikinci ikiz.", baytEki: "ayni" },
        { ad: "tekil", no: "1001", tarih: "01/09/2026", metin: "Tekil metin.", baytEki: "t" },
      ],
      { [GRUP("4234", "Müzekkere", "03/09/2026")]: 2 },
    );
    const s = await arsiviDenetle({ kok: kok.kok, davalar });
    const ikiz = s.bulgular.filter((b) => b.tur === "grup-ikiz");
    assert.equal(ikiz.length, 1, `bulgular: ${JSON.stringify(s.bulgular.map((b) => b.tur))}`);
    assert.equal(ikiz[0]!.agirlik, "bulgu");
    assert.equal(ikiz[0]!.eksen, "kayit");
    assert.equal(ikiz[0]!.adet, 2);
    assert.match(ikiz[0]!.aciklama, /BAŞKA bir belgesi arşivde eksik olabilir/);
    assert.ok(s.sayilar.bulgu >= 1, "denetim hâlâ 'bulgu yok' diyor");
    // Şişme eleği bu arşivde SUSAR: kayıt sayısı portalınkini AŞMIYOR.
    assert.equal(s.bulgular.filter((b) => b.tur === "grup-sismis").length, 0);
  });

  test("grup-ikiz — baytları FARKLI iki kayıt bulgu DEĞİLDİR (UYAP yeniden üretimi)", async () => {
    // Yanlış pozitif bekçisi: kullanıcının gerçek arşivinde bir grupta portal
    // iki satır bildiriyor ve iki kaydın metni aynı, BAYTLARI farklı (UYAP
    // belgeyi her indirişte yeniden üretiyor). Bu DOĞRU hâldir; `grup-ikiz`
    // buna yanmamalı, yoksa denetim kendi doğru davranışını arıza gösterir.
    arsivKur(
      [
        { ad: "sablon-1", no: "5981", metin: "Ayni sablon metni.", baytEki: "uretim 1" },
        { ad: "sablon-2", no: "5981", metin: "Ayni sablon metni.", baytEki: "uretim 22" },
      ],
      { [SISMIS_GRUP]: 2 },
    );
    const s = await arsiviDenetle({ kok: kok.kok, davalar });
    assert.equal(s.bulgular.filter((b) => b.tur === "grup-ikiz").length, 0);
    assert.equal(s.sayilar.bulgu, 0, `bulgular: ${JSON.stringify(s.bulgular.map((b) => b.tur))}`);
  });

  test("grup-olculemez — numarasız evrakta sessiz birikme GÖRÜNÜR olur (bilgi, bulgu değil)", async () => {
    // ROADMAP T13: numarasız ana evrak gruplanmaz, çünkü orada "kaç tane
    // olmalı" ölçülemez. Bedeli izole motorda ölçüldü — böyle bir satır her
    // eşitlemede yeniden inip yeni kayıt oluyor (beş eşitlemede 2 → 7 kayıt)
    // ve düzeltme öncesi HİÇBİR elek bunu göremiyordu.
    arsivKur([
      { ad: "numarasiz-1", no: "", metin: "Ayni numarasiz metin.", baytEki: "n1", numarasiz: true },
      { ad: "numarasiz-2", no: "", metin: "Ayni numarasiz metin.", baytEki: "n2", numarasiz: true },
      { ad: "numarasiz-3", no: "", metin: "Ayni numarasiz metin.", baytEki: "n3", numarasiz: true },
      { ad: "tekil", no: "1001", tarih: "01/09/2026", metin: "Tekil metin.", baytEki: "t" },
    ]);
    const s = await arsiviDenetle({ kok: kok.kok, davalar });
    const y = s.bulgular.filter((b) => b.tur === "grup-olculemez");
    assert.equal(y.length, 1, `bulgular: ${JSON.stringify(s.bulgular.map((b) => b.tur))}`);
    // AĞIRLIK `bilgi`: kimlik tahmin edilmiyor, yalnız görünür kılınıyor.
    assert.equal(y[0]!.agirlik, "bilgi");
    assert.equal(y[0]!.adet, 3);
    assert.match(y[0]!.aciklama, /Sadeleştirme bunlara DOKUNMAZ/);
    assert.equal(s.sayilar.bulgu, 0, "ölçülemeyen birikme kırmızı bulgu sayılmamalı");
  });

  test("grup-olculemez — metinleri FARKLI numarasız kayıtlar birikme sayılmaz", async () => {
    arsivKur([
      { ad: "numarasiz-1", no: "", metin: "Birinci numarasiz.", baytEki: "n1", numarasiz: true },
      { ad: "numarasiz-2", no: "", metin: "Ikinci numarasiz.", baytEki: "n2", numarasiz: true },
    ]);
    const s = await arsiviDenetle({ kok: kok.kok, davalar });
    assert.equal(s.bulgular.filter((b) => b.tur === "grup-olculemez").length, 0);
  });

  test("sağlam arşivde şişme bulgusu YOK: portal iki satır diyorsa iki kayıt fazlalık değildir", async () => {
    arsivKur(SISMIS.slice(0, 2).concat(SISMIS.slice(5)), { [SISMIS_GRUP]: 2 });
    const s = await arsiviDenetle({ kok: kok.kok, davalar });
    assert.equal(s.bulgular.filter((b) => b.tur === "grup-sismis").length, 0);
  });
});

// ── eşleştirici (saf modül) ─────────────────────────────────────────────────
describe("P19 eşleştirici", () => {
  const kayit = (evrakId: string, no: string, gonderen = "A"): ManifestEvrak => ({
    evrakId,
    stableKey: `ana:${no}`,
    path: `_kaynak/${evrakId}.udf`,
    sha256: "0".repeat(64),
    isEkEvrak: false,
    category: "02-Dilekceler",
    yon: "Gelen",
    tur: "Dilekçe",
    gonderen,
    tarih: "01/09/2026",
    birimEvrakNo: no,
    dosyaKey: "k",
    mdStatus: "ok",
  });
  const girdi = (k: ManifestEvrak) => ({ anahtar: kayitAnahtari(k), kayit: k });

  test("kimlik dönmüyorsa her satır kendi kaydına düşer", () => {
    const a = kayit("id-1", "10");
    const b = kayit("id-2", "20");
    const s = evraklariEslestir([kayitAnahtari(a), kayitAnahtari(b)], [girdi(a), girdi(b)]);
    assert.equal(s.esler.get(0), a);
    assert.equal(s.esler.get(1), b);
  });

  test("kimlik dönse bile belirsiz grup BİREBİR eşlenir: iki satır, iki kayıt", () => {
    const a = kayit("eski-1", "5981");
    const b = kayit("eski-2", "5981");
    const p1 = { ...kayitAnahtari(a), evrakId: "yeni-1" };
    const p2 = { ...kayitAnahtari(b), evrakId: "yeni-2" };
    const s = evraklariEslestir([p1, p2], [girdi(a), girdi(b)]);
    assert.equal(s.esler.size, 2);
    assert.notEqual(s.esler.get(0), s.esler.get(1), "iki satır aynı kayda bağlandı");
    assert.equal(s.gruplar.get(p1.grup!)?.portal, 2);
    assert.equal(s.gruplar.get(p1.grup!)?.manifest, 2);
  });

  test("grup büyüdüyse YALNIZ fark eşleşmez: üçüncü satır yeni iner", () => {
    const a = kayit("eski-1", "5981");
    const b = kayit("eski-2", "5981");
    const p = [1, 2, 3].map((n) => ({ ...kayitAnahtari(a), evrakId: `yeni-${n}` }));
    const s = evraklariEslestir(p, [girdi(a), girdi(b)]);
    assert.equal(s.esler.size, 2);
    assert.equal(grupOzeti(s.gruplar).eksik, 1);
  });

  test("grup BÜYÜDÜĞÜNDE hiçbir satır 'yerinde doğrulandı' sayılmaz: hepsi TAZELENİR", () => {
    // Eski kural yalnız SAYIYI ölçüyordu; hangi satırın hangi kayda düştüğü
    // ölçülmediği için portalın yeni belgesi eldeki bir kayda düşüp hiç
    // inmeyebiliyordu. Büyümüş grupta sıra tahmini KANIT değildir.
    const a = kayit("eski-1", "5981");
    const b = kayit("eski-2", "5981");
    const p = [1, 2, 3].map((n) => ({ ...kayitAnahtari(a), evrakId: `yeni-${n}` }));
    const s = evraklariEslestir(p, [girdi(a), girdi(b)]);
    // Eşleşen İKİ satır tazelenir; üçüncü satırın tutunacağı kayıt zaten yok,
    // o normal yoldan iner. Böylece grubun ÜÇ satırı da bu turda indirilir.
    assert.deepEqual([...s.tazele].sort(), [0, 1], "büyümüş grupta tahmine güvenilmiş");
    assert.equal([...s.esler.keys()].filter((i) => !s.tazele.has(i)).length, 0,
      "indirilmeden 'korunan' sayılacak satır kaldı");
  });

  test("P20 — DOYGUN ama BELİRSİZ grup da TAZELENİR: boy aynı kalıp üye değişebilir", () => {
    // Eski kural yalnız BÜYÜMEYİ tetikleyici sayıyordu ve şu hâli kaçırıyordu:
    // arşivde [ALFA, BETA], portal [ALFA, GAMA]. Boy aynı (2 = 2), tetikleyici
    // susuyor, GAMA hiç inmiyor ve grup doygun sayıldığı için bir daha da
    // inmiyor. Ölçüt BÜYÜME değil BELİRSİZLİKTİR.
    const a = kayit("eski-1", "5981");
    const b = kayit("eski-2", "5981");
    const p = [1, 2].map((n) => ({ ...kayitAnahtari(a), evrakId: `yeni-${n}` }));
    const s = evraklariEslestir(p, [girdi(a), girdi(b)]);
    assert.deepEqual([...s.tazele].sort(), [0, 1], "belirsiz grupta tahmine güvenilmiş");
  });

  test("P20 — grup KÜÇÜLSE bile belirsizse tazelenir: eksilen satır değişmiş de olabilir", () => {
    // Portal iki satır yerine bir satır bildiriyor. Kalan satırın eldeki İKİ
    // kayıttan hangisi olduğu tahmindir; kalan satır GERÇEKTE üçüncü, hiç
    // inmemiş bir belge de olabilir. Manifest tarafı belirsizse tazeleme
    // maliyeti ödenir; karşılığında hiçbir belge sessizce eksik kalmaz.
    const a = kayit("eski-1", "5981");
    const b = kayit("eski-2", "5981");
    const s = evraklariEslestir([{ ...kayitAnahtari(a), evrakId: "yeni-1" }], [girdi(a), girdi(b)]);
    assert.deepEqual([...s.tazele], [0]);
  });

  test("TEKİL grup tazelenmez: arşivin tamamı her eşitlemede yeniden inmez", () => {
    // P20'nin bilerek çizdiği sınır. Portalda 1, manifestte 1 satır varsa
    // (birimEvrakNo, tür, tarih) üçlüsü portalın verebildiği en yakın
    // kimliktir (gerçek dosyada 112/113 tekil). Burayı da tazelemek, 113
    // belgelik bir arşivin TAMAMINI her eşitlemede yeniden indirmek demektir.
    const a = kayit("eski-1", "1001");
    const s = evraklariEslestir([{ ...kayitAnahtari(a), evrakId: "yeni-1" }], [girdi(a)]);
    assert.equal(s.esler.get(0), a);
    assert.equal(s.tazele.size, 0);
  });

  test("portal KALICI kimlik döndürüyorsa büyüyen grupta bile tazeleme YOK", () => {
    // Kimlik dönmeyen portalda tahmin yoktur: eski satırlar kimlikle birebir
    // eşleşir, yalnız gerçekten yeni satır iner. Tazeleme oraya yayılırsa
    // maliyet gereksiz yere ödenir.
    const a = kayit("eski-1", "5981");
    const b = kayit("eski-2", "5981");
    const s = evraklariEslestir(
      [kayitAnahtari(a), kayitAnahtari(b), { ...kayitAnahtari(a), evrakId: "yepyeni" }],
      [girdi(a), girdi(b)],
    );
    assert.equal(s.esler.get(0), a);
    assert.equal(s.esler.get(1), b);
    assert.equal(s.tazele.size, 0, "kimlikle eşleşen satır boşuna yeniden indiriliyor");
  });

  test("grup küçüldüyse fazla kayıt eşleşmez ama eşleştirici HİÇBİR ŞEY silmez", () => {
    const a = kayit("eski-1", "5981");
    const b = kayit("eski-2", "5981");
    const c = kayit("eski-3", "5981");
    const s = evraklariEslestir(
      [{ ...kayitAnahtari(a), evrakId: "yeni-1" }],
      [girdi(a), girdi(b), girdi(c)],
    );
    assert.equal(s.esler.size, 1);
    assert.equal(grupOzeti(s.gruplar).fazla, 2);
  });

  test("gönderen/tip ipucu metadata'nın karışmasını önler", () => {
    const a = kayit("eski-1", "5981", "Kalem A");
    const b = kayit("eski-2", "5981", "Kalem B");
    const p1 = { ...kayitAnahtari(b), evrakId: "yeni-1" }; // Kalem B
    const p2 = { ...kayitAnahtari(a), evrakId: "yeni-2" }; // Kalem A
    const s = evraklariEslestir([p1, p2], [girdi(a), girdi(b)]);
    assert.equal(s.esler.get(0), b);
    assert.equal(s.esler.get(1), a);
  });

  test("numarasız ana evrak GRUPLANMAZ: eski temkin aynen sürer", () => {
    const a = kayit("eski-1", "");
    delete (a as { birimEvrakNo?: string }).birimEvrakNo;
    const s = evraklariEslestir([{ ...kayitAnahtari(a), evrakId: "yeni-1" }], [girdi(a)]);
    assert.equal(s.esler.size, 0);
    assert.equal(s.gruplar.size, 0);
  });
});
