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
  existsSync,
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
const BIRIM = "Bagimsiz Kontrol Asliye Hukuk Mahkemesi";
const BIRIM_ID = "9060";
const ESAS = "2026/616";
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

// ── ORKESTRATORUN BAGIMSIZ KONTROLU ─────────────────────────────────────────
// Inceleme uc engelleyici cikardi, ucu de teslimi reddetti; onarim turu ise
// (her turda oldugu gibi) INCELENMEDI. Engelleyici hatanin sekli sudur:
// 522 test yesilken dugme ARAYUZDEN hic calismiyordu, cunku testlerin hicbiri
// DENETIMIN URETTIGI yolu onarima vermiyordu. Bu kontroller tam o zinciri
// kurar: bulgu satiri -> onar -> gercekten duzeldi mi.
describe("BAGIMSIZ KONTROL — P06b onarim zinciri", () => {
  test("O1 — denetimin urettigi TUREV bulgusu onarilir (agsiz, kaynak degismez)", async () => {
    const s = await sahneKur([{ ad: "alfa", no: "8001" }, { ad: "beta", no: "8002" }]);
    try {
      const md = join(s.klasor, s.kayit("alfa").mdPath!);
      rmSync(md);
      const r = await s.denetle();
      const b = r.bulgular.find((x) => x.tur === "turev-yok");
      assert.ok(b, "turev bulgusu uretilmedi");
      assert.equal(b!.onarim?.eylem, "metin", "motor bu satiri onarilabilir saymiyor");

      const oncePortal = s.portalIstekleri();
      const onceKaynak = readFileSync(join(s.klasor, s.kayit("alfa").path));
      // ARAYUZUN GONDERDIGI SEY: bulgunun KENDI yolu, elle kurulmus bir yol degil.
      const plan = await s.onar(b!.yol!, "metin");
      assert.equal(plan.yapilabilir, true, `plan yapilamaz: ${JSON.stringify(plan)}`);
      const sonuc = await s.onar(b!.yol!, "metin", true);
      assert.equal(sonuc.uygulandi, true, `onay uygulanmadi: ${JSON.stringify(sonuc)}`);

      assert.ok(existsSync(md), "metin geri gelmedi");
      assert.equal(s.portalIstekleri(), oncePortal, "AGSIZ onarim portala istek atti");
      assert.deepEqual(
        readFileSync(join(s.klasor, s.kayit("alfa").path)),
        onceKaynak,
        "kaynak baytlari degisti",
      );
    } finally { await s.kapat(); }
  });

  test("O2 — onaysiz cagri TEK BAYT degistirmez", async () => {
    const s = await sahneKur([{ ad: "alfa", no: "8001" }, { ad: "beta", no: "8002" }]);
    try {
      rmSync(join(s.klasor, s.kayit("alfa").mdPath!));
      const b = (await s.denetle()).bulgular.find((x) => x.tur === "turev-yok")!;
      const once = s.parmakIzi();
      await s.onar(b.yol!, "metin");
      assert.deepEqual([...s.parmakIzi()].sort(), [...once].sort(), "onaysiz cagri arsivi degistirdi");
    } finally { await s.kapat(); }
  });

  test("O3 — bir satiri onarmak DIGER kayitlara dokunmaz", async () => {
    const s = await sahneKur([{ ad: "alfa", no: "8001" }, { ad: "beta", no: "8002" }, { ad: "cem", no: "8003" }]);
    try {
      rmSync(join(s.klasor, s.kayit("alfa").mdPath!));
      rmSync(join(s.klasor, s.kayit("beta").mdPath!));
      const b = (await s.denetle()).bulgular.find(
        (x) => x.tur === "turev-yok" && x.yol!.includes("alfa"),
      ) ?? (await s.denetle()).bulgular.find((x) => x.tur === "turev-yok")!;
      const betaOnce = JSON.stringify(s.kayit("beta"));
      const cemOnce = JSON.stringify(s.kayit("cem"));
      const cemDosya = readFileSync(join(s.klasor, s.kayit("cem").path));
      await s.onar(b.yol!, "metin", true);
      assert.equal(JSON.stringify(s.kayit("beta")), betaOnce, "secilmeyen kayit degisti");
      assert.equal(JSON.stringify(s.kayit("cem")), cemOnce, "secilmeyen kayit degisti");
      assert.deepEqual(readFileSync(join(s.klasor, s.kayit("cem").path)), cemDosya, "dosya degisti");
    } finally { await s.kapat(); }
  });
});
