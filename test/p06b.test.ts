// P06b — SEÇİLİ ONARIM. Denetim 21 bulgu türü üretiyordu ama hiçbirini
// düzeltemiyordu; kullanıcının elindeki tek çare bütün davayı eşitlemekti.
//
// ── BU DOSYA NEYİ ÖLÇER ─────────────────────────────────────────────────────
// İDDİA DEĞİL ÖLÇÜM. Her onarım testi arşivin PARMAK İZİNİ (her dosyanın
// sha256'sı + boyutu) onarımdan önce ve sonra alır ve İZİN VERİLEN farkın
// dışında tek bayt değişmediğini gösterir. "Yalnız seçtiğim satır değişti"
// cümlesi ancak böyle kanıtlanır.
//
// Ayrıca ölçülenler: metin onarımının portala TEK istek atmadığı ve kaynağın
// sha256'sını değiştirmediği; başarısız indirmenin başarı SAYILMADIĞI; yerelde
// değiştirilmiş kaynağın EZİLMEDİĞİ; kimlik belirsizken işlemin DURDUĞU.
//
// Bütün veriler SENTETİKTİR; gerçek arşive (~/Documents/UYAPAsistan), gerçek
// ayar dizinine ve çalışan motora tek bayt dokunulmaz.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import { MockUyap, opakToken, type MockDava, type MockEvrak } from "./mock-uyap/sunucu.js";
import { daemonKur } from "../src/server/daemon.js";
import { makeHtml, tmpKok } from "./yardimci.js";
import { caseKeyYap } from "../src/store/registry.js";
import { ONARIM_TABLOSU, onarimBilgisi, kimlikBelirsizligi } from "../src/store/onarim.js";
import { sadelestir } from "../src/store/sadelestir.js";
import { IsDepo, IS_DEPO_SURUMU } from "../src/jobs/depo.js";
import type { Bulgu } from "../src/store/denetim.js";
import type { ManifestEvrak } from "../src/store/manifest.js";

const CEREZ = "JSESSIONID=p06bmock1234567890";
const BIRIM = "Sentetik P06b Asliye Hukuk Mahkemesi";
const BIRIM_ID = "9060";
const ESAS = "2026/606";
const TARIH = "05/09/2026";
const sha = (v: Buffer | string) => createHash("sha256").update(v).digest("hex");

interface Tanim {
  ad: string;
  no: string;
  /** Portal bu evrakı nasıl döndürsün? Varsayılan "yuklu". */
  durum?: MockEvrak["durum"];
}

function evrak(t: Tanim): MockEvrak {
  return {
    evrakId: opakToken(`p06b-${t.ad}`),
    tur: "Müzekkere",
    gonderen: "Sentetik Kalem",
    tip: "GDN",
    tarih: TARIH,
    birimEvrakNo: t.no,
    durum: t.durum ?? "yuklu",
    contentTipi: "text/html; charset=UTF-8",
    icerik: makeHtml(`<div>SENTETIK ${t.ad.toUpperCase()} belge metni.</div>`, "Sentetik Belge"),
    // UYAP bazı belgeleri her indirişte yeniden üretir: baytlar değişir, metin
    // aynı kalır. Onarımın "aynı belge mi" sorusuna bayta güvenmemesi gerekir.
    uretimDamgasi: true,
  };
}

/** Klasördeki HER dosyanın içerik özeti + boyutu. Onarımın bekçisi budur. */
function parmakIzi(kok: string): Map<string, string> {
  const tablo = new Map<string, string>();
  const yuru = (dizin: string): void => {
    for (const g of readdirSync(dizin, { withFileTypes: true })) {
      const tam = join(dizin, g.name);
      if (g.isDirectory()) {
        yuru(tam);
        continue;
      }
      if (!g.isFile()) continue;
      tablo.set(relative(kok, tam), `${sha(readFileSync(tam))}:${statSync(tam).size}`);
    }
  };
  yuru(kok);
  return tablo;
}

/** İki parmak izi arasındaki fark: "eklendi/silindi/değişti: yol". */
function fark(once: Map<string, string>, sonra: Map<string, string>): string[] {
  const cikti: string[] = [];
  for (const [k, v] of once) {
    if (!sonra.has(k)) cikti.push(`silindi: ${k}`);
    else if (sonra.get(k) !== v) cikti.push(`değişti: ${k}`);
  }
  for (const k of sonra.keys()) if (!once.has(k)) cikti.push(`eklendi: ${k}`);
  return cikti.sort();
}

interface OnarimYaniti {
  durum: string;
  yapilabilir?: boolean;
  uygulandi?: boolean;
  aciklama?: string;
  mdStatus?: string;
  mdPath?: string;
  kaynakSha?: string;
  yedek?: string;
  isId?: string;
}

interface IsSonucu {
  isId?: string;
  durum: string;
  sonuc?: {
    istenen: number;
    onarilan: number;
    atlanan: number;
    eksikEvrak: number;
    satirlar: { yol: string; durum: string; yeniYol?: string; yerinde?: boolean }[];
  };
}

interface Sahne {
  klasor: string;
  caseKey: string;
  manifest(): { evraklar: ManifestEvrak[] };
  kayit(ad: string): ManifestEvrak;
  parmakIzi(): Map<string, string>;
  portalIstekleri(): number;
  portal(satirlar: Tanim[]): void;
  denetle(): Promise<{ bulgular: Bulgu[]; sayilar: { bulgu: number } }>;
  onar(yol: string, eylem: "metin" | "kaynak", onay?: boolean): Promise<OnarimYaniti>;
  isBekle(isId: string): Promise<IsSonucu>;
  sorunlar(): Promise<{ acik: { tur: string; hata: unknown }[] }>;
  /** Birden çok hedefli onarım işi (UI tek satır gönderir; motor kümeyi alır). */
  onarCoklu(yollar: string[]): Promise<string>;
  devam(isId: string): Promise<string>;
  /** Bu dava için çalışan bir iş varmış gibi gösterir (meşguliyet ölçütü). */
  mesgulTakli(acik: boolean): void;
  ayarDizini: string;
  kapat(): Promise<void>;
}

/** İzole motor + sahte portal + klonlanmış sentetik arşiv. */
async function sahneKur(ilk: Tanim[]): Promise<Sahne> {
  const dava: MockDava = {
    dosyaId: opakToken("p06b-dosya"),
    birimAdi: BIRIM,
    birimId: BIRIM_ID,
    esasNo: ESAS,
    dosyaTur: "Hukuk Dava Dosyası",
    dosyaDurum: "Açık",
    yargiTuru: "1",
    // PORTALIN HİÇBİR KİMLİĞİ KALICI DEĞİL (P20): onarım kimliği her turda
    // yeniden çözmek zorunda; sabit kimlikli bir mock bu yolu hiç sınamazdı.
    kimlikDoner: true,
    evraklar: ilk.map(evrak),
    taraflar: [{ adi: "SENTETİK DAVACI", rol: "Davacı" }],
  };
  const mock = new MockUyap({
    birimler: [{ birimId: BIRIM_ID, birimAdi: BIRIM, yargiTuru: "1" }],
    davalar: [dava],
  });
  await mock.baslat();
  const ayar = tmpKok();
  const kok = tmpKok();
  const daemon = daemonKur({
    ayarDir: ayar.kok,
    kok: kok.kok,
    portalUrl: mock.adres(),
    appVersion: "test",
    istekAralikMs: 1,
    gunlukTavan: 800,
    oturumYenileMs: 0,
  });
  await daemon.rpc.baslat();
  const h = (ad: string) => daemon.isleyiciler.get(ad)!;
  await h("giris")({ cerez: CEREZ });

  const isBekle = async (isId: string): Promise<IsSonucu> => {
    for (let i = 0; i < 600; i++) {
      const is = (await h("is")({ isId })) as IsSonucu;
      if (["hazir", "eksikli", "hata", "iptal", "duraklatildi"].includes(is.durum)) return is;
      await new Promise((c) => setTimeout(c, 10));
    }
    throw new Error("iş zaman aşımı");
  };

  const baslat = (await h("klonla")({ birim: BIRIM, esas: ESAS, kapsam: "hepsi" })) as {
    isId: string;
  };
  const klonIs = await isBekle(baslat.isId);
  assert.equal(klonIs.durum, "hazir", `klon düştü: ${JSON.stringify(klonIs)}`);
  const davalar = (await h("davalar")({})) as { davalar: { klonYolu?: string }[] };
  const klasor = davalar.davalar[0]?.klonYolu ?? "";
  assert.notEqual(klasor, "", "klon yolu bulunamadı");

  const manifest = () =>
    JSON.parse(readFileSync(join(klasor, "uyap-project.json"), "utf8")) as {
      evraklar: ManifestEvrak[];
    };
  const gercekIsler = daemon.orkestrator.islerHepsi.bind(daemon.orkestrator);

  return {
    klasor,
    caseKey: caseKeyYap(BIRIM, ESAS),
    ayarDizini: ayar.kok,
    manifest,
    kayit(ad) {
      const hedef = manifest().evraklar.filter((e) =>
        readFileSync(join(klasor, e.path)).toString("utf8").includes(`SENTETIK ${ad.toUpperCase()} `),
      );
      assert.equal(hedef.length, 1, `kayıt tekil değil: ${ad}`);
      return hedef[0]!;
    },
    parmakIzi: () => parmakIzi(klasor),
    portalIstekleri: () => mock.istekler.length,
    portal(satirlar) {
      dava.evraklar = satirlar.map(evrak);
    },
    async denetle() {
      return (await h("arsiv-denetle")({ caseKey: caseKeyYap(BIRIM, ESAS) })) as {
        bulgular: Bulgu[];
        sayilar: { bulgu: number };
      };
    },
    async onar(yol, eylem, onay = false) {
      return (await h("onar")({
        caseKey: caseKeyYap(BIRIM, ESAS),
        yol,
        eylem,
        onay,
      })) as OnarimYaniti;
    },
    isBekle,
    async onarCoklu(yollar) {
      return daemon.orkestrator.onarBaslat(caseKeyYap(BIRIM, ESAS), yollar).isId;
    },
    async devam(isId) {
      const yeni = (await h("devam")({ isId })) as { isId: string };
      return yeni.isId;
    },
    async sorunlar() {
      return (await h("sorunlar")({})) as { acik: { tur: string; hata: unknown }[] };
    },
    mesgulTakli(acik) {
      const kap = daemon.orkestrator as unknown as Record<string, unknown>;
      if (!acik) {
        kap["islerHepsi"] = gercekIsler;
        return;
      }
      kap["islerHepsi"] = () => [
        ...gercekIsler(),
        {
          isId: "sahte-calisan",
          tur: "esitle",
          caseKey: caseKeyYap(BIRIM, ESAS),
          durum: "calisiyor",
          baslamaAt: new Date().toISOString(),
          ilerleme: { toplam: 0, biten: 0 },
        },
      ];
    },
    async kapat() {
      await daemon.kapat();
      await mock.durdur();
      ayar.temizle();
      kok.temizle();
    },
  };
}

// ── EŞLEME TABLOSU: TEK YER ─────────────────────────────────────────────────
describe("P06b bulgu → eylem eşlemesi motorda, tek yerde", () => {
  test("HER bulgu türü tabloda ve her satırın gerekçesi yazılı", () => {
    const kaynak = readFileSync(new URL("../../src/store/denetim.ts", import.meta.url), "utf8");
    const blok = /export type BulguTuru =([\s\S]*?);\n/.exec(kaynak);
    assert.ok(blok, "BulguTuru birleşimi kaynakta bulunamadı");
    const turler = [...blok[1]!.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]!);
    assert.ok(turler.length >= 21, `beklenenden az tür: ${turler.length}`);
    const eksik = turler.filter((t) => !(t in ONARIM_TABLOSU));
    assert.deepEqual(eksik, [], "eşlemesiz bulgu türü");
    // Tablonun fazlası da olmamalı: ölü satır, kaldırılmış bir türü canlı sanır.
    assert.deepEqual(
      Object.keys(ONARIM_TABLOSU).filter((t) => !turler.includes(t)),
      [],
      "tabloda kaynakta olmayan tür var",
    );
    for (const [tur, o] of Object.entries(ONARIM_TABLOSU)) {
      assert.ok(o.sebep.length > 20, `${tur}: sebep yazılmamış`);
      if (o.eylem === null) {
        assert.equal(o.etiket, "", `${tur}: onarılamaz ama düğme etiketi var`);
        assert.equal(o.ag, false, `${tur}: onarılamaz ama ağ istiyor`);
      } else {
        assert.ok(o.etiket.length > 0, `${tur}: düğme etiketi yok`);
        assert.equal(o.ag, o.eylem === "kaynak", `${tur}: ağ bayrağı eylemle uyuşmuyor`);
      }
    }
  });

  test("ağsız eylemler gerçekten ağsız: yalnız `kaynak` oturum ister", () => {
    assert.equal(onarimBilgisi("turev-yok").ag, false);
    assert.equal(onarimBilgisi("turev-erisilemiyor").ag, false);
    assert.equal(onarimBilgisi("grup-sismis").ag, false);
    assert.equal(onarimBilgisi("kaynak-yok").ag, true);
    assert.equal(onarimBilgisi("hash-uyusmuyor").ag, true);
  });

  // Plan `grup-ikiz`i sadeleştirmeye bağlamayı öneriyordu. ÖLÇÜLDÜ: ikiz
  // grupta manifest sayısı portalınkine EŞİTTİR, sadeleştirme hiçbir satır
  // düşürmez — çizilecek düğme HİÇBİR ŞEY YAPMAYAN bir düğme olurdu.
  test("`grup-ikiz` onarılamaz: sadeleştirme o grupta BOŞ plan döndürür", async () => {
    const kok = tmpKok();
    try {
      const klasor = join(kok.kok, "dava");
      const ham = join(klasor, "_kaynak", "evraklar", "Gelen", "02-Dilekceler");
      const md = join(klasor, "evraklar", "Gelen", "02-Dilekceler");
      mkdirSync(ham, { recursive: true });
      mkdirSync(md, { recursive: true });
      const govde = Buffer.from("ikiz belge baytları");
      const metin = "# ikiz\n\nmetin\n";
      const kayitlar: ManifestEvrak[] = ["a", "b"].map((ad, i) => {
        writeFileSync(join(ham, `${ad}.html`), govde);
        writeFileSync(join(md, `${ad}.md`), metin);
        return {
          evrakId: `OPAK-${ad}`,
          stableKey: "ana:77",
          path: `_kaynak/evraklar/Gelen/02-Dilekceler/${ad}.html`,
          sha256: sha(govde),
          isEkEvrak: false,
          category: "02-Dilekceler",
          yon: "Gelen",
          tur: "Müzekkere",
          gonderen: "Kalem",
          tarih: "01/09/2026",
          birimEvrakNo: "77",
          dosyaKey: "k",
          mdStatus: "ok",
          mdPath: `evraklar/Gelen/02-Dilekceler/${ad}.md`,
          boyut: govde.length + i * 0,
        } as ManifestEvrak;
      });
      writeFileSync(
        join(klasor, "uyap-project.json"),
        JSON.stringify({
          surum: 1,
          dosyaId: "OPAK-dosya",
          mahkeme: "X",
          birimId: "1",
          esasNo: "2026/1",
          isIcra: false,
          clonedAt: "2026-09-01T00:00:00.000Z",
          // Portal bu grup için 2 satır bildiriyor: fazlalık YOK.
          grupSayilari: { "ana\u000077\u0000Müzekkere\u000001/09/2026": 2 },
          evraklar: kayitlar,
        }),
      );
      const plan = await sadelestir(kok.kok, klasor, false);
      assert.equal(plan.once, 2);
      assert.equal(plan.sonra, 2, "ikiz grupta sadeleştirme satır düşürmemeli");
      assert.equal(onarimBilgisi("grup-ikiz").eylem, null);
      assert.match(onarimBilgisi("grup-ikiz").sebep, /yeniden eşitleyin/);
    } finally {
      kok.temizle();
    }
  });

  // ── SATIR DÜĞMESİ SATIRIN SÖZÜNÜ TUTAR (P06b incelemesi, 13 Eylül) ────────
  // ÖLÇÜLDÜ: `sadelestir` dava düzeyinde çalıştığı için tek satırın onayı iki
  // şişmiş gruplu bir davada 6 kaydı 2'ye indiriyor, kullanıcının SEÇMEDİĞİ
  // grubun kayıtları da düşüyordu — kabul ölçütü 2'nin ("yalnız biri seçilince
  // diğer kayıtlar bayt bayt aynı") ve ekranın "onarım satır satır yapılır"
  // cümlesinin ihlali.
  test("iki şişmiş grupta TEK satırın onayı ötekinin kayıtlarına dokunmaz", async () => {
    const kok = tmpKok();
    try {
      const klasor = join(kok.kok, "dava");
      const ham = join(klasor, "_kaynak", "evraklar", "Gelen", "02-Dilekceler");
      const md = join(klasor, "evraklar", "Gelen", "02-Dilekceler");
      mkdirSync(ham, { recursive: true });
      mkdirSync(md, { recursive: true });
      const kayitlar: ManifestEvrak[] = [];
      // İki AYRI evrak numarası, her birinde 3 kayıt / portal 1 satır.
      for (const [no, adlar] of [
        ["77", ["a1", "a2", "a3"]],
        ["88", ["b1", "b2", "b3"]],
      ] as [string, string[]][]) {
        const govde = Buffer.from(`grup ${no} belge baytları`);
        for (const ad of adlar) {
          writeFileSync(join(ham, `${ad}.html`), govde);
          writeFileSync(join(md, `${ad}.md`), `# grup ${no}\n\nbirebir aynı metin\n`);
          kayitlar.push({
            evrakId: `OPAK-${ad}`,
            stableKey: `ana:${no}`,
            path: `_kaynak/evraklar/Gelen/02-Dilekceler/${ad}.html`,
            sha256: sha(govde),
            isEkEvrak: false,
            category: "02-Dilekceler",
            yon: "Gelen",
            tur: "Müzekkere",
            gonderen: "Kalem",
            tarih: "01/09/2026",
            birimEvrakNo: no,
            dosyaKey: "k",
            mdStatus: "ok",
            mdPath: `evraklar/Gelen/02-Dilekceler/${ad}.md`,
            boyut: govde.length,
          } as ManifestEvrak);
        }
      }
      const manifestYolu = join(klasor, "uyap-project.json");
      writeFileSync(
        manifestYolu,
        JSON.stringify({
          surum: 1,
          dosyaId: "OPAK-dosya",
          mahkeme: "X",
          birimId: "1",
          esasNo: "2026/1",
          isIcra: false,
          clonedAt: "2026-09-01T00:00:00.000Z",
          grupSayilari: {
            "ana\u000077\u0000Müzekkere\u000001/09/2026": 1,
            "ana\u000088\u0000Müzekkere\u000001/09/2026": 1,
          },
          evraklar: kayitlar,
        }),
      );
      const oku = () =>
        (JSON.parse(readFileSync(manifestYolu, "utf8")) as { evraklar: ManifestEvrak[] }).evraklar;
      const hedef = "_kaynak/evraklar/Gelen/02-Dilekceler/a1.html";

      // ── ONAYSIZ: PLAN YALNIZ BİR GRUP ───────────────────────────────────
      const plan = await sadelestir(kok.kok, klasor, false, { yol: hedef });
      assert.equal(plan.gruplar.length, 1, "tek satır istendi, iki grup planlandı");
      assert.equal(plan.hedefYol, hedef);
      assert.equal(plan.sonra, 4, "plan seçilmeyen grubu da düşürüyor");

      // ── ONAYLI: ÖTEKİ GRUP BAYT BAYT AYNI ───────────────────────────────
      const once = parmakIzi(klasor);
      const onceki88 = oku().filter((e) => e.birimEvrakNo === "88");
      const uygulanan = await sadelestir(kok.kok, klasor, true, { yol: hedef });
      assert.equal(uygulanan.uygulandi, true);
      assert.deepEqual(
        oku()
          .filter((e) => e.birimEvrakNo === "77")
          .map((e) => e.path),
        [hedef],
        "seçilen grup beklendiği gibi sadeleşmedi",
      );
      assert.deepEqual(
        oku().filter((e) => e.birimEvrakNo === "88"),
        onceki88,
        "SEÇİLMEYEN grubun kayıtları değişti",
      );
      const farklar = fark(once, parmakIzi(klasor)).filter(
        (f) => f !== "değişti: uyap-project.json" && !/^eklendi: uyap-project\.yedek-/.test(f),
      );
      assert.deepEqual(farklar, [], "sadeleştirme belge dosyalarına dokundu");

      // ── BAYAT SATIR DAVA GENELİNE GENİŞLEMEZ ────────────────────────────
      const bayat = await sadelestir(kok.kok, klasor, true, {
        yol: "_kaynak/evraklar/Gelen/02-Dilekceler/artik-yok.html",
      });
      assert.equal(bayat.uygulandi, false);
      assert.match(String(bayat.not), /tek bir kayıt bulunamadı/);
      assert.equal(oku().length, 4, "bayat satır dava geneline genişledi");

      // ── EVRAKLAR EKRANININ DAVA GENELİ DÜĞMESİ DEĞİŞMEDİ ────────────────
      await sadelestir(kok.kok, klasor, true);
      assert.equal(oku().length, 2, "yolsuz çağrı artık dava geneli çalışmıyor");
    } finally {
      kok.temizle();
    }
  });

  test("kimlik belirsizliği ölçütü: numarasız ve kalabalık grup DURDURUR", () => {
    const taban = (over: Partial<ManifestEvrak>): ManifestEvrak =>
      ({
        evrakId: "OPAK",
        stableKey: "ana:5",
        path: "_kaynak/a.html",
        sha256: "0".repeat(64),
        isEkEvrak: false,
        category: "c",
        yon: "Gelen",
        tur: "Müzekkere",
        gonderen: "Kalem",
        tarih: "01/09/2026",
        birimEvrakNo: "5",
        dosyaKey: "k",
        mdStatus: "ok",
        ...over,
      }) as ManifestEvrak;
    const tekil = taban({});
    assert.equal(kimlikBelirsizligi([tekil], tekil), null);
    const numarasiz = taban({ birimEvrakNo: undefined, path: "_kaynak/b.html" });
    assert.match(String(kimlikBelirsizligi([numarasiz], numarasiz)), /numarası yok/);
    const ikinci = taban({ path: "_kaynak/c.html", evrakId: "OPAK2" });
    assert.match(String(kimlikBelirsizligi([tekil, ikinci], tekil)), /2 kayıt var/);
  });
});

// ── (a) METİN ONARIMI — AĞSIZ ───────────────────────────────────────────────
describe("P06b metni yeniden üret: portala TEK istek gitmez", () => {
  test("KABUL 1 — onaysız çağrı tek bayt değiştirmez, onaylı çağrı metni geri getirir", async () => {
    const s = await sahneKur([
      { ad: "alfa", no: "101" },
      { ad: "beta", no: "102" },
      { ad: "gama", no: "103" },
    ]);
    try {
      const alfa = s.kayit("alfa");
      const mdYolu = join(s.klasor, alfa.mdPath!);
      const kaynakSha = alfa.sha256;
      rmSync(mdYolu); // "hazır metin yok" — türev kayboldu, kaynak sağlam.

      const rapor = await s.denetle();
      const bulgu = rapor.bulgular.find((b) => b.tur === "turev-yok");
      assert.ok(bulgu, `türev bulgusu yok: ${JSON.stringify(rapor.bulgular)}`);
      assert.equal(bulgu.onarim.eylem, "metin");
      assert.equal(bulgu.onarim.ag, false);

      // ── ONAYSIZ: PLAN ─────────────────────────────────────────────────────
      const oncekiIz = s.parmakIzi();
      const oncekiIstek = s.portalIstekleri();
      const plan = await s.onar(alfa.path, "metin");
      assert.equal(plan.yapilabilir, true, JSON.stringify(plan));
      assert.equal(plan.uygulandi, false);
      assert.deepEqual(fark(oncekiIz, s.parmakIzi()), [], "onaysız çağrı diske yazdı");
      assert.equal(s.portalIstekleri(), oncekiIstek, "onaysız çağrı portala istek attı");

      // ── ONAYLI: UYGULA ────────────────────────────────────────────────────
      const sonuc = await s.onar(alfa.path, "metin", true);
      assert.equal(sonuc.durum, "onarildi", JSON.stringify(sonuc));
      assert.equal(sonuc.uygulandi, true);
      assert.equal(sonuc.mdStatus, "ok");
      // KABUL 1: portala TEK istek gitmedi ve kaynağın sha256'sı DEĞİŞMEDİ.
      assert.equal(s.portalIstekleri(), oncekiIstek, "metin onarımı portala istek attı");
      assert.equal(sonuc.kaynakSha, kaynakSha);
      const yeniAlfa = s.manifest().evraklar.find((e) => e.path === alfa.path)!;
      assert.equal(yeniAlfa.sha256, kaynakSha, "onarım kaynağın özetini değiştirdi");
      assert.equal(sha(readFileSync(join(s.klasor, alfa.path))), kaynakSha);
      assert.equal(
        readFileSync(mdYolu, "utf8").includes("SENTETIK ALFA"),
        true,
        "metin geri gelmedi",
      );

      // KABUL 2: yalnız SEÇİLEN satır değişti.
      const izinli = new Set([
        `eklendi: ${relative(s.klasor, mdYolu)}`,
        "değişti: uyap-project.json",
      ]);
      const farklar = fark(oncekiIz, s.parmakIzi()).filter(
        (f) => !izinli.has(f) && !/^eklendi: uyap-project\.yedek-/.test(f),
      );
      assert.deepEqual(farklar, [], "onarım seçilmemiş dosyalara dokundu");

      // Bulgu gerçekten kapandı.
      const sonrasi = await s.denetle();
      assert.equal(sonrasi.sayilar.bulgu, 0, JSON.stringify(sonrasi.bulgular));
    } finally {
      await s.kapat();
    }
  });

  // ── ÖLÜ DÜĞME BEKÇİSİ (P06b incelemesi, 13 Eylül) ─────────────────────────
  // Bu paketin bütün onarım testleri hedefi ELLE YAZILAN kaynak yoluyla
  // veriyordu; arayüz ise bulgunun KENDİ yolunu gönderir ve türev bulgusunda
  // o yol `.md`dir. ÖLÇÜLDÜ (izole motor + sentetik arşiv, 13 Eylül): motor
  // kaydı yalnız `path` ile aradığı için düğme HER tıkta `kayit-belirsiz`
  // düşüyor, üstelik suçu "rapor bayatlamış" diye yanlış yere atıyordu.
  // BU TESTİN GİRDİSİ ELLE YAZILMAZ: doğrudan `arsiv-denetle` çıktısındaki
  // satırdır. Rapor ile onarım arasındaki bağ ancak böyle ölçülür.
  test("RAPORUN KENDİ SATIRI onarıma verilince metin geri gelir", async () => {
    const s = await sahneKur([
      { ad: "alfa", no: "401" },
      { ad: "beta", no: "402" },
    ]);
    try {
      const alfa = s.kayit("alfa");
      rmSync(join(s.klasor, alfa.mdPath!));
      const rapor = await s.denetle();
      const bulgu = rapor.bulgular.find((b) => b.tur === "turev-yok");
      assert.ok(bulgu, `türev bulgusu yok: ${JSON.stringify(rapor.bulgular)}`);
      // Rapor KULLANICIYA GÖRÜNEN yolu yazar; türev bulgusunda bu `.md`dir.
      assert.equal(bulgu.yol, alfa.mdPath, "rapor türev yolunu yazmıyor");
      assert.equal(bulgu.onarim.eylem, "metin");

      const once = s.parmakIzi();
      const oncekiIstek = s.portalIstekleri();
      // ARAYÜZÜN YAPTIĞI ÇAĞRININ AYNISI: bulgunun kendi alanları.
      const eylem = bulgu.onarim.eylem as "metin";
      const plan = await s.onar(bulgu.yol, eylem);
      assert.equal(plan.durum, "plan", JSON.stringify(plan));
      assert.equal(plan.yapilabilir, true, JSON.stringify(plan));
      assert.deepEqual(fark(once, s.parmakIzi()), [], "plan diske yazdı");

      const sonuc = await s.onar(bulgu.yol, eylem, true);
      assert.equal(sonuc.durum, "onarildi", JSON.stringify(sonuc));
      assert.equal(sonuc.uygulandi, true);
      assert.equal(
        readFileSync(join(s.klasor, alfa.mdPath!), "utf8").includes("SENTETIK ALFA"),
        true,
        "metin geri gelmedi",
      );
      assert.equal(s.portalIstekleri(), oncekiIstek, "ağsız onarım portala istek attı");
      // Seçilmeyen kayda dokunulmadı; yalnız türev + manifest (+ yedek) değişti.
      const farklar = fark(once, s.parmakIzi()).filter(
        (f) => f !== "değişti: uyap-project.json" && !/^eklendi: uyap-project\.yedek-/.test(f),
      );
      assert.deepEqual(farklar, [`eklendi: ${alfa.mdPath}`], JSON.stringify(farklar));
      // Zincirin sonu: bulgu gerçekten kapandı.
      const sonrasi = await s.denetle();
      assert.equal(sonrasi.bulgular.filter((b) => b.tur === "turev-yok").length, 0);
    } finally {
      await s.kapat();
    }
  });

  test("KABUL 2 — üç bulgudan biri seçilince diğer İKİSİ bayt bayt aynı kalır", async () => {
    const s = await sahneKur([
      { ad: "alfa", no: "201" },
      { ad: "beta", no: "202" },
      { ad: "gama", no: "203" },
    ]);
    try {
      const hedefler = ["alfa", "beta", "gama"].map((ad) => s.kayit(ad));
      for (const k of hedefler) rmSync(join(s.klasor, k.mdPath!));
      const rapor = await s.denetle();
      assert.equal(rapor.bulgular.filter((b) => b.tur === "turev-yok").length, 3);

      const once = s.parmakIzi();
      const oncekiManifest = s.manifest().evraklar;
      await s.onar(hedefler[1]!.path, "metin", true);

      // Diğer iki kaydın satırı BİREBİR aynı (yol, özet, türev durumu).
      const sonra = s.manifest().evraklar;
      for (const ad of ["alfa", "gama"]) {
        const eski = oncekiManifest.find((e) => e.path === s.kayit(ad).path)!;
        const yeni = sonra.find((e) => e.path === eski.path)!;
        assert.deepEqual(yeni, eski, `${ad} kaydı değişti`);
      }
      // Dosya düzleminde: yalnız BETA'nın metni eklendi.
      const farklar = fark(once, s.parmakIzi()).filter(
        (f) => f !== "değişti: uyap-project.json" && !/^eklendi: uyap-project\.yedek-/.test(f),
      );
      assert.equal(farklar.length, 1, JSON.stringify(farklar));
      assert.match(farklar[0]!, /^eklendi: /);
      assert.ok(
        readFileSync(join(s.klasor, hedefler[1]!.mdPath!), "utf8").includes("SENTETIK BETA"),
      );
      // Kalan iki bulgu duruyor: onarım seçim dışını KAPATMAZ.
      const sonrasi = await s.denetle();
      assert.equal(sonrasi.bulgular.filter((b) => b.tur === "turev-yok").length, 2);
    } finally {
      await s.kapat();
    }
  });

  test("BAYAT RAPOR — kaynak değişmişse metin onarımı REDDEDİLİR", async () => {
    const s = await sahneKur([{ ad: "alfa", no: "301" }]);
    try {
      const alfa = s.kayit("alfa");
      rmSync(join(s.klasor, alfa.mdPath!));
      const rapor = await s.denetle();
      assert.ok(rapor.bulgular.some((b) => b.tur === "turev-yok"));
      // Rapor alındıktan SONRA kaynak değişti.
      appendFileSync(join(s.klasor, alfa.path), "\n<!-- avukatın notu -->\n");
      const once = s.parmakIzi();
      const yanit = await s.onar(alfa.path, "metin", true);
      assert.equal(yanit.durum, "kaynak-saglam-degil", JSON.stringify(yanit));
      assert.equal(yanit.uygulandi, false);
      assert.match(String(yanit.aciklama), /önce kaynağı onarın/);
      assert.deepEqual(fark(once, s.parmakIzi()), [], "reddedilen onarım diske yazdı");
    } finally {
      await s.kapat();
    }
  });

  test("kaynağı olmayan satırda metin onarımı yapılmaz (düğme çalışmış gibi görünmez)", async () => {
    const s = await sahneKur([{ ad: "alfa", no: "401" }]);
    try {
      const alfa = s.kayit("alfa");
      rmSync(join(s.klasor, alfa.path));
      const once = s.parmakIzi();
      const plan = await s.onar(alfa.path, "metin");
      assert.equal(plan.yapilabilir, false);
      assert.equal(plan.durum, "kaynak-saglam-degil");
      assert.deepEqual(fark(once, s.parmakIzi()), []);
    } finally {
      await s.kapat();
    }
  });
});

// ── (b) KAYNAK ONARIMI — AĞ ─────────────────────────────────────────────────
describe("P06b kaynağı yeniden edin: eksik belge geri gelir", () => {
  test("KABUL 3 — eksik kaynak portaldan geri getirilir, kayıtlı yoluna yazılır", async () => {
    const s = await sahneKur([
      { ad: "alfa", no: "501" },
      { ad: "beta", no: "502" },
    ]);
    try {
      const alfa = s.kayit("alfa");
      const beta = s.kayit("beta");
      const betaOnce = s.manifest().evraklar.find((e) => e.path === beta.path)!;
      rmSync(join(s.klasor, alfa.path));
      const rapor = await s.denetle();
      const bulgu = rapor.bulgular.find((b) => b.tur === "kaynak-yok");
      assert.ok(bulgu, JSON.stringify(rapor.bulgular));
      assert.equal(bulgu.onarim.eylem, "kaynak");
      assert.equal(bulgu.onarim.ag, true);

      // ONAYSIZ: yalnız plan; portala istek YOK.
      const oncekiIstek = s.portalIstekleri();
      const plan = await s.onar(alfa.path, "kaynak");
      assert.equal(plan.yapilabilir, true, JSON.stringify(plan));
      assert.equal(plan.isId, undefined, "onaysız çağrı iş başlattı");
      assert.equal(s.portalIstekleri(), oncekiIstek, "plan portala istek attı");

      const baslat = await s.onar(alfa.path, "kaynak", true);
      assert.ok(baslat.isId, JSON.stringify(baslat));
      const is = await s.isBekle(baslat.isId!);
      assert.equal(is.durum, "hazir", JSON.stringify(is));
      assert.equal(is.sonuc?.onarilan, 1);
      assert.equal(is.sonuc?.eksikEvrak, 0);
      assert.equal(is.sonuc?.satirlar[0]?.durum, "onarildi");
      assert.equal(is.sonuc?.satirlar[0]?.yerinde, true, "dosya yokken yeni yol açılmış");

      // Belge yerinde ve kaydıyla birebir; UYAP baytları yeniden ürettiği için
      // sha256 DEĞİŞİR — ölçüt "kayıt dosyayı anlatıyor mu"dur.
      const yeni = s.manifest().evraklar.find((e) => e.path === alfa.path)!;
      assert.equal(sha(readFileSync(join(s.klasor, alfa.path))), yeni.sha256);
      assert.ok(readFileSync(join(s.klasor, alfa.path), "utf8").includes("SENTETIK ALFA"));
      // Seçilmeyen kayıt BİREBİR aynı.
      assert.deepEqual(
        s.manifest().evraklar.find((e) => e.path === beta.path),
        betaOnce,
        "seçilmeyen kayıt değişti",
      );
      const sonrasi = await s.denetle();
      assert.equal(sonrasi.sayilar.bulgu, 0, JSON.stringify(sonrasi.bulgular));
    } finally {
      await s.kapat();
    }
  });

  test("KABUL 3b — BAŞARISIZ indirme başarı SAYILMAZ", async () => {
    const s = await sahneKur([{ ad: "alfa", no: "601" }]);
    try {
      const alfa = s.kayit("alfa");
      rmSync(join(s.klasor, alfa.path));
      // Portal artık bu evrakı vermiyor (yüklenmemiş).
      s.portal([{ ad: "alfa", no: "601", durum: "yuklenmemis" }]);
      const kayitOnce = s.manifest().evraklar.find((e) => e.path === alfa.path)!;
      const baslat = await s.onar(alfa.path, "kaynak", true);
      const is = await s.isBekle(baslat.isId!);
      assert.equal(is.durum, "eksikli", `başarısız onarım "hazir" sayıldı: ${JSON.stringify(is)}`);
      assert.equal(is.sonuc?.onarilan, 0);
      assert.equal(is.sonuc?.eksikEvrak, 1);
      assert.equal(is.sonuc?.satirlar[0]?.durum, "yuklenmemis");
      // Kayıt DEĞİŞMEDİ ve belge hâlâ yok: sahte bir "onarıldı" yazılmadı.
      assert.deepEqual(s.manifest().evraklar.find((e) => e.path === alfa.path), kayitOnce);
      const sorunlar = await s.sorunlar();
      assert.ok(
        sorunlar.acik.some((x) => x.tur === "yuklenmemis"),
        "başarısız indirme sorun kaydı açmadı",
      );
      const sonrasi = await s.denetle();
      assert.ok(sonrasi.bulgular.some((b) => b.tur === "kaynak-yok"), "bulgu sessizce kapandı");
    } finally {
      await s.kapat();
    }
  });

  test("KABUL 4 — yerelde DEĞİŞMİŞ kaynak ezilmez: yeni kopya ayrı yola iner", async () => {
    const s = await sahneKur([{ ad: "alfa", no: "701" }]);
    try {
      const alfa = s.kayit("alfa");
      const yol = join(s.klasor, alfa.path);
      const NOT = "<!-- AVUKATIN YEREL NOTU -->";
      appendFileSync(yol, `\n${NOT}\n`);
      const degismisSha = sha(readFileSync(yol));
      const rapor = await s.denetle();
      assert.ok(rapor.bulgular.some((b) => b.tur === "hash-uyusmuyor"));

      const plan = await s.onar(alfa.path, "kaynak");
      assert.equal(plan.yapilabilir, true);
      assert.match(String(plan.aciklama), /EZİLMEYECEK/);

      const baslat = await s.onar(alfa.path, "kaynak", true);
      const is = await s.isBekle(baslat.isId!);
      assert.equal(is.durum, "hazir", JSON.stringify(is));
      assert.equal(is.sonuc?.satirlar[0]?.durum, "onarildi");
      assert.equal(is.sonuc?.satirlar[0]?.yerinde, false, "değişmiş dosya yerinde yazıldı");
      // ESKİ DOSYA OLDUĞU GİBİ DURUYOR — notu dâhil.
      assert.equal(sha(readFileSync(yol)), degismisSha, "yerelde değişmiş kaynak EZİLDİ");
      assert.ok(readFileSync(yol, "utf8").includes(NOT));
      // Yeni kopya AYRI bir yolda ve kayıt onu gösteriyor.
      const yeni = s.manifest().evraklar[0]!;
      assert.notEqual(yeni.path, alfa.path);
      assert.equal(sha(readFileSync(join(s.klasor, yeni.path))), yeni.sha256);
    } finally {
      await s.kapat();
    }
  });

  test("KİMLİK BELİRSİZSE İŞLEM DURUR: onaylı çağrı bile tek istek atmaz", async () => {
    const s = await sahneKur([
      { ad: "alfa", no: "801" },
      { ad: "beta", no: "801" },
    ]);
    try {
      const alfa = s.kayit("alfa");
      rmSync(join(s.klasor, alfa.path));
      const once = s.parmakIzi();
      const oncekiIstek = s.portalIstekleri();
      const plan = await s.onar(alfa.path, "kaynak");
      assert.equal(plan.durum, "kimlik-belirsiz", JSON.stringify(plan));
      assert.equal(plan.yapilabilir, false);
      const onayli = await s.onar(alfa.path, "kaynak", true);
      assert.equal(onayli.isId, undefined, "belirsiz kimlikte iş başlatıldı");
      assert.equal(s.portalIstekleri(), oncekiIstek, "belirsiz kimlikte portala istek gitti");
      assert.deepEqual(fark(once, s.parmakIzi()), []);
    } finally {
      await s.kapat();
    }
  });

  test("BAYAT RAPOR — kaynak yerine geldiyse iş hiçbir portal isteği atmaz", async () => {
    const s = await sahneKur([{ ad: "alfa", no: "901" }]);
    try {
      const alfa = s.kayit("alfa");
      const once = s.parmakIzi();
      const oncekiIstek = s.portalIstekleri();
      const baslat = await s.onar(alfa.path, "kaynak", true);
      // Plan yerel ölçümde "zaten yerinde" der; iş hiç başlamaz.
      assert.equal(baslat.durum, "zaten-yerinde", JSON.stringify(baslat));
      assert.equal(baslat.isId, undefined);
      assert.equal(s.portalIstekleri(), oncekiIstek);
      assert.deepEqual(fark(once, s.parmakIzi()), []);
    } finally {
      await s.kapat();
    }
  });

  // İŞ DÜZEYİNDE ÖN ÖLÇÜM: RPC'nin plan kapısı tek hedefte zaten durduruyor,
  // ama devam ettirilen ya da çok hedefli bir iş doğrudan başlar. Orada da
  // hedefler ÖNCE yerelde ölçülür; hepsi yerindeyse portal listesi bile
  // istenmez.
  test("BAYAT RAPOR (iş düzeyi) — hedeflerin hepsi yerindeyse portala istek gitmez", async () => {
    const s = await sahneKur([
      { ad: "alfa", no: "131" },
      { ad: "beta", no: "132" },
    ]);
    try {
      const yollar = [s.kayit("alfa").path, s.kayit("beta").path];
      const once = s.parmakIzi();
      const oncekiIstek = s.portalIstekleri();
      const is = await s.isBekle(await s.onarCoklu(yollar));
      assert.equal(is.durum, "hazir", JSON.stringify(is));
      assert.equal(is.sonuc?.atlanan, 2);
      assert.equal(is.sonuc?.onarilan, 0);
      assert.equal(s.portalIstekleri(), oncekiIstek, "yapılacak iş yokken portala istek gitti");
      assert.deepEqual(fark(once, s.parmakIzi()), [], "yapılacak iş yokken diske yazıldı");
    } finally {
      await s.kapat();
    }
  });

  // KABUL 7 — "tamamlanan kısım korunur". Yarım kalan bir onarımda inen belge
  // diske YAZILMIŞTIR ve devam ettirilen iş onu yeniden indirmez.
  test("KABUL 7 — yarım kalan onarımda tamamlanan korunur, devam edilebilir", async () => {
    const s = await sahneKur([
      { ad: "alfa", no: "121" },
      { ad: "beta", no: "122" },
    ]);
    try {
      const alfa = s.kayit("alfa");
      const beta = s.kayit("beta");
      rmSync(join(s.klasor, alfa.path));
      rmSync(join(s.klasor, beta.path));
      // BETA portalda yüklü değil: iş yarım kalacak.
      s.portal([
        { ad: "alfa", no: "121" },
        { ad: "beta", no: "122", durum: "yuklenmemis" },
      ]);
      const ilk = await s.isBekle((await s.onarCoklu([alfa.path, beta.path]))!);
      assert.equal(ilk.durum, "eksikli", JSON.stringify(ilk));
      assert.equal(ilk.sonuc?.onarilan, 1);
      assert.equal(ilk.sonuc?.eksikEvrak, 1);
      // ALFA gerçekten yerinde ve kaydıyla birebir.
      const alfaKayit = s.manifest().evraklar.find((e) => e.path === alfa.path)!;
      assert.equal(sha(readFileSync(join(s.klasor, alfa.path))), alfaKayit.sha256);
      const alfaIz = sha(readFileSync(join(s.klasor, alfa.path)));

      // DEVAM: aynı hedefler yeniden denenir; tamamlanan yeniden İNDİRİLMEZ.
      const devam = await s.devam(ilk.isId!);
      const ikinci = await s.isBekle(devam);
      assert.equal(ikinci.durum, "eksikli", JSON.stringify(ikinci));
      assert.equal(ikinci.sonuc?.atlanan, 1, "tamamlanan satır yeniden indirildi");
      assert.equal(ikinci.sonuc?.onarilan, 0);
      assert.equal(
        sha(readFileSync(join(s.klasor, alfa.path))),
        alfaIz,
        "devam eden iş tamamlanmış belgeyi değiştirdi",
      );
    } finally {
      await s.kapat();
    }
  });

  // Denetim ve sadeleştirmeyle AYNI `mesgul` ölçütü: yarı yazılmış bir
  // manifest üzerinde onarım yanlış satırı hedefleyebilir.
  test("KABUL 6 — eşitlemesi süren dosyada onarım REDDEDİLİR (metin de, kaynak da)", async () => {
    const s = await sahneKur([{ ad: "alfa", no: "111" }]);
    try {
      const alfa = s.kayit("alfa");
      rmSync(join(s.klasor, alfa.mdPath!));
      const once = s.parmakIzi();
      s.mesgulTakli(true);
      try {
        await assert.rejects(() => s.onar(alfa.path, "metin", true), /eşitleme sürüyor/);
        await assert.rejects(() => s.onar(alfa.path, "kaynak", true), /eşitleme sürüyor/);
      } finally {
        s.mesgulTakli(false);
      }
      assert.deepEqual(fark(once, s.parmakIzi()), [], "reddedilen onarım diske yazdı");
      // Meşguliyet bitince aynı çağrı çalışır: ret KALICI bir engel değil.
      const sonuc = await s.onar(alfa.path, "metin", true);
      assert.equal(sonuc.durum, "onarildi", JSON.stringify(sonuc));
    } finally {
      await s.kapat();
    }
  });
});

// ── İŞ GEÇMİŞİ: YENİ TÜR ESKİYİ BOZMAZ ──────────────────────────────────────
describe("P06b iş deposu: yeni `onar` türü eski geçmişi bozmaz", () => {
  test("`onar` kaydı hedefleriyle yazılıp okunur", () => {
    const ayar = tmpKok();
    try {
      const depo = new IsDepo(ayar.kok);
      depo.yaz([
        {
          isId: "is-1",
          tur: "onar",
          caseKey: "X\u00002026/1",
          durum: "hazir",
          baslamaAt: "2026-09-13T10:00:00.000Z",
          ilerleme: { toplam: 1, biten: 1 },
          parametreler: { onar: { hedefler: ["_kaynak/evraklar/Gelen/a.html"] } },
        },
      ]);
      const okunan = new IsDepo(ayar.kok).oku();
      assert.equal(okunan.length, 1);
      assert.equal(okunan[0]!.tur, "onar");
      assert.deepEqual(okunan[0]!.parametreler?.onar?.hedefler, [
        "_kaynak/evraklar/Gelen/a.html",
      ]);
    } finally {
      ayar.temizle();
    }
  });

  test("hedefsiz `onar` kaydı ve kök dışına çıkan yol REDDEDİLİR", () => {
    const ayar = tmpKok();
    try {
      const depo = new IsDepo(ayar.kok);
      const taban = {
        isId: "is-2",
        tur: "onar" as const,
        caseKey: "X\u00002026/1",
        durum: "hazir" as const,
        baslamaAt: "2026-09-13T10:00:00.000Z",
        ilerleme: { toplam: 1, biten: 1 },
      };
      assert.throws(() => depo.yaz([taban]), /geçersiz kayıt/);
      assert.throws(
        () => depo.yaz([{ ...taban, parametreler: { onar: { hedefler: ["../disari"] } } }]),
        /geçersiz kayıt/,
      );
      assert.throws(
        () => depo.yaz([{ ...taban, parametreler: { onar: { hedefler: ["/etc/passwd"] } } }]),
        /geçersiz kayıt/,
      );
    } finally {
      ayar.temizle();
    }
  });

  test("P06b ÖNCESİ iş geçmişi (klonla + esitle) hâlâ açılır", () => {
    const ayar = tmpKok();
    try {
      // ESKİ SÜRÜMÜN yazdığı dosya, birebir: yeni tür eklendi diye eski
      // geçmişin okunamaz olması kullanıcının bütün iş kaydını yakardı.
      writeFileSync(
        join(ayar.kok, "isler.json"),
        JSON.stringify({
          surum: IS_DEPO_SURUMU,
          isler: [
            {
              isId: "is-eski-1",
              tur: "klonla",
              caseKey: "Eski Mahkeme\u00002025/7",
              durum: "hazir",
              baslamaAt: "2025-09-01T08:00:00.000Z",
              bitisAt: "2025-09-01T08:01:00.000Z",
              ilerleme: { toplam: 3, biten: 3 },
              parametreler: {
                klonla: {
                  birimAdi: "Eski Mahkeme",
                  esasNo: "2025/7",
                  kapsam: "hepsi",
                  avukat: "AVUKAT",
                },
              },
            },
            {
              isId: "is-eski-2",
              tur: "esitle",
              caseKey: "Eski Mahkeme\u00002025/7",
              durum: "eksikli",
              baslamaAt: "2025-09-02T08:00:00.000Z",
              ilerleme: { toplam: 3, biten: 2 },
              sonuc: { yeniEvrak: 1, eksikEvrak: 1 },
            },
          ],
        }),
      );
      const okunan = new IsDepo(ayar.kok).oku();
      assert.equal(okunan.length, 2);
      assert.deepEqual(
        okunan.map((x) => x.tur),
        ["klonla", "esitle"],
      );
      assert.equal(okunan[0]!.parametreler?.klonla?.esasNo, "2025/7");
    } finally {
      ayar.temizle();
    }
  });

  // ── GERİ DÖNÜŞ (P06b incelemesi, 13 Eylül) ────────────────────────────────
  // ROADMAP §4 P06b madde 4: "Eski iş geçmişi açılabilmelidir." Yukarıdaki
  // test yalnız İLERİ yönü ölçüyordu (eski dosya yeni sürümde açılıyor mu).
  // ÖLÇÜLDÜ: doğrulama HEPSİ-YA-HİÇBİRİ olduğu için, tanımadığı TEK bir `tur`
  // taşıyan depo `INTERNAL: iş deposu bozuk` fırlatıyor ve o hata
  // `depoYukle()` üzerinden MOTORUN AÇILIŞINI reddediyordu — yani bir üst
  // sürümün yazdığı tek iş, klonla/esitle geçmişini de motoru da götürüyordu.
  //
  // SINIR (dürüstlük payı): bu düzeltme BU SÜRÜMÜN okumasını kurtarır. P06b
  // ÖNCESİNE dönen kullanıcının ikilisi eski koddadır ve sonradan yazılan
  // kodla değiştirilemez; kazanılan şey, bundan sonraki her sürüm farkında
  // geçmişin AÇIK kalmasıdır.
  test("GERİ DÖNÜŞ — tanınmayan `tur` yalnız KENDİ satırını düşürür", () => {
    const ayar = tmpKok();
    try {
      const kayit = (isId: string, tur: string, ek: Record<string, unknown> = {}) => ({
        isId,
        tur,
        caseKey: "Eski Mahkeme\u00002025/7",
        durum: "hazir",
        baslamaAt: "2026-09-13T08:00:00.000Z",
        ilerleme: { toplam: 1, biten: 1 },
        ...ek,
      });
      const govde = JSON.stringify({
        surum: IS_DEPO_SURUMU,
        isler: [
          kayit("is-1", "klonla", {
            parametreler: {
              klonla: { birimAdi: "Eski Mahkeme", esasNo: "2025/7", kapsam: "hepsi", avukat: "AV" },
            },
          }),
          kayit("is-2", "esitle"),
          // Bu sürümün TANIMADIĞI tür (yarının "onar"ının ikizi).
          kayit("is-3", "gelecek-turu", { parametreler: { gelecek: { hedefler: ["x"] } } }),
        ],
      });
      writeFileSync(join(ayar.kok, "isler.json"), govde);
      writeFileSync(join(ayar.kok, "isler.json.yedek"), govde);

      const depo = new IsDepo(ayar.kok);
      const okunan = depo.oku();
      assert.deepEqual(
        okunan.map((x) => x.isId),
        ["is-1", "is-2"],
        "tanınmayan tek kayıt bütün geçmişi götürdü",
      );
      assert.equal(depo.elenenKayitSayisi(), 1, "elenen kayıt sayılmadı");
      // Yedekten kurtarma DEĞİL: ana dosya okundu, yalnız bir satır elendi.
      assert.equal(depo.kurtarmaGerekiyor(), false);
      // YAZIM KAPISI GEVŞEMEDİ: geçersiz kayıt hâlâ dosyaya yazılamaz.
      assert.throws(
        () =>
          depo.yaz([
            { ...kayit("is-4", "onar"), parametreler: { onar: { hedefler: ["/etc/passwd"] } } },
          ] as never),
        /geçersiz kayıt/,
      );
    } finally {
      ayar.temizle();
    }
  });
});

// ── ARAYÜZ: SAF ÜRETİCİLER ──────────────────────────────────────────────────
describe("P06b denetim sekmesi: onarım kartı", () => {
  let M: Record<string, (...a: unknown[]) => unknown> & Record<string, unknown>;
  // FIXTURE MOTORUN ÜRETTİĞİ ŞEKİLDE: türev bulgusunda yol `.md`dir
  // (src/store/denetim.ts `turevOlc`), kaynak bulgusunda `_kaynak/…`. Eskiden
  // her tür için kaynak yolu yazılıyordu; motorun hiç üretmediği bir girdiyle
  // sınanan arayüz, ölü düğmeyi göremedi (P06b incelemesi, 13 Eylül).
  const turevMi = (tur: string) => tur.startsWith("turev");
  const ornek = (tur: string): Record<string, unknown> => ({
    tur,
    eksen: turevMi(tur) ? "turev" : "kaynak",
    agirlik: "bulgu",
    onarim: onarimBilgisi(tur as never),
    caseKey: "X",
    dava: "X Mahkemesi 2026/1",
    yol: turevMi(tur)
      ? "evraklar/Gelen/02-Dilekceler/a.md"
      : "_kaynak/evraklar/Gelen/02-Dilekceler/a.udf",
    aciklama: "Sentetik açıklama.",
  });

  test("modül yüklenir", async () => {
    M = (await import(new URL("../../web/denetim.js", import.meta.url).href)) as never;
    assert.equal(typeof M["onarimAlaniHTML"], "function");
  });

  test("kapalı satırda TEK düğme, açık kartta ONAYLA + VAZGEÇ", () => {
    const f = M["onarimAlaniHTML"] as (b: unknown, i: number, k: unknown) => string;
    const b = ornek("turev-yok");
    const kapali = f(b, 2, null);
    assert.equal((kapali.match(/<button/g) ?? []).length, 1);
    assert.match(kapali, /data-onar-asama="plan"/);

    const anahtar = (M["onarimAnahtari"] as (b: unknown) => string)(b);
    const acik = f(b, 2, {
      anahtar,
      asama: "plan",
      veri: { yapilabilir: true, aciklama: "Hazır metin yeniden üretilecek." },
    });
    assert.match(acik, /Onayla/);
    assert.match(acik, /Vazgeç/);
    assert.match(acik, /Hazır metin yeniden üretilecek/);
  });

  test("YAPILAMAZ plan ONAYLA düğmesi çizmez", () => {
    const f = M["onarimAlaniHTML"] as (b: unknown, i: number, k: unknown) => string;
    const b = ornek("kaynak-yok");
    const anahtar = (M["onarimAnahtari"] as (b: unknown) => string)(b);
    const html = f(b, 0, {
      anahtar,
      asama: "plan",
      veri: { yapilabilir: false, aciklama: "Kimlik belirsiz; onarım durdu." },
    });
    assert.ok(!html.includes("Onayla"), "yapılamaz planda onay düğmesi çizildi");
    assert.match(html, /Kapat/);
    assert.match(html, /Kimlik belirsiz/);
  });

  test("onarılamaz bulguda düğme yok, sebep yazılı; kararsız satırda İDDİA da yok", () => {
    const f = M["onarimAlaniHTML"] as (b: unknown, i: number, k: unknown) => string;
    const html = f(ornek("manifest-bozuk"), 0, null);
    assert.ok(!html.includes("<button"));
    assert.match(html, /Bu bulgu onarılamaz:/);
    // Eski motor yanıtı (karar alanı YOK): ne düğme ne "onarılamaz" damgası.
    assert.equal(f({ tur: "kaynak-yok" }, 0, null), "");
  });

  // Satır düğmesi YALNIZ kendi grubunu sadeleştirir; cümle bunu söylemek
  // zorunda, yoksa aynı sayı iki farklı kapsam için okunur.
  test("sadeleştirme özeti KAPSAMI yazar ve sebebi yutmaz", () => {
    const f = M["onarimOzetMetni"] as (e: string, v: unknown) => string;
    const satir = f("sadelestir", { once: 6, sonra: 4, hedefYol: "_kaynak/a.html" });
    assert.match(satir, /Bu satırın grubundan 2 fazla kayıt manifestten düşecek/);
    assert.match(
      f("sadelestir", { once: 6, sonra: 4, hedefYol: "_kaynak/a.html", uygulandi: true }),
      /Bu satırın grubundan 2 fazla kayıt manifestten düştü/,
    );
    // Dava geneli çağrıda kapsam cümlesi YOKTUR (Evraklar ekranı).
    assert.ok(!f("sadelestir", { once: 6, sonra: 4 }).startsWith("Bu satırın"));
    // Boş planın SEBEBİ varsa o yazılır, genel cümle onun yerini almaz.
    assert.match(
      f("sadelestir", { once: 4, sonra: 4, not: "Bu yolu gösteren tek bir kayıt bulunamadı." }),
      /tek bir kayıt bulunamadı/,
    );
  });

  test("sadeleştirme planı tek cümleye çevrilir", () => {
    const f = M["onarimOzetMetni"] as (e: string, v: unknown) => string;
    assert.match(f("sadelestir", { once: 5, sonra: 3 }), /2 fazla kayıt manifestten düşecek/);
    assert.match(f("sadelestir", { once: 5, sonra: 3, uygulandi: true }), /düştü/);
    assert.match(f("sadelestir", { once: 3, sonra: 3 }), /ölçülemedi/);
    const y = M["onarimYapilabilirMi"] as (e: string, v: unknown) => boolean;
    assert.equal(y("sadelestir", { once: 3, sonra: 3 }), false);
    assert.equal(y("sadelestir", { once: 3, sonra: 2 }), true);
    assert.equal(y("metin", { yapilabilir: true }), true);
    assert.equal(y("metin", {}), false);
  });

  // TEK EŞLEME TABLOSU: arayüz "hangi bulgu nasıl onarılır" sorusuna kendi
  // yanıtını yazarsa iki tablo ayrışır ve kullanıcı motorun yapmayacağı bir
  // düğme görür. Bekçi: düğme etiketleri web modülünde GEÇMEZ.
  test("arayüzde İKİNCİ eşleme tablosu yok: etiketler motordan gelir", () => {
    const kaynak = readFileSync(new URL("../../web/denetim.js", import.meta.url), "utf8");
    for (const o of Object.values(ONARIM_TABLOSU)) {
      if (o.etiket === "") continue;
      assert.ok(
        !kaynak.includes(o.etiket),
        `düğme etiketi arayüze kopyalanmış: ${o.etiket}`,
      );
    }
    // Hangi RPC'nin çağrılacağı da tek bir yerden, `onarim.eylem`den türer.
    assert.match(kaynak, /onarim\?\.eylem/, "eylem kararı `onarim.eylem`den türemiyor");
    assert.equal((kaynak.match(/api\("onar"/g) ?? []).length, 1);
    assert.equal((kaynak.match(/api\("sadelestir"/g) ?? []).length, 1);
  });

  // SATIRIN YOLU HER İKİ ÇAĞRIDA DA GİDER. Yolsuz `sadelestir` davanın BÜTÜN
  // şişmiş gruplarını sadeleştirir (ÖLÇÜLDÜ, 13 Eylül: iki gruplu davada 6
  // kayıt 2'ye düştü), yolsuz `onar` ise hedefsiz kalır. Motor tarafı bunu
  // ölçüyor; burada ölçülen, arayüzün yolu GÖNDERDİĞİ.
  test("her iki onarım çağrısı da SATIRIN yolunu gönderir", () => {
    const kaynak = readFileSync(new URL("../../web/denetim.js", import.meta.url), "utf8");
    for (const ad of ["onar", "sadelestir"]) {
      const cagri = new RegExp(`api\\("${ad}", \\{([^}]*)\\}`).exec(kaynak);
      assert.ok(cagri, `${ad} çağrısı bulunamadı`);
      assert.match(cagri[1]!, /yol: b\.yol/, `${ad} çağrısı satırın yolunu göndermiyor`);
    }
  });
});
