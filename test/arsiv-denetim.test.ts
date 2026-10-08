// P06a — yerel arşiv denetimi. Bütün veriler SENTETİKTİR; gerçek arşive
// (~/Documents/UYAPAsistan), gerçek ayar dizinine ve çalışan motora
// dokunulmaz. Portala tek istek gitmez (bu dosyada portal istemcisi hiç
// yüklenmez).
//
// EN ÖNEMLİ BEKÇİ: `parmakIzi()`. Denetimden ÖNCE ve SONRA arşivdeki HER
// dosyanın sha256'sı, boyutu ve izin biti kaydedilir; iki tablo birebir eşit
// olmalıdır. "Denetim hiçbir şey yazmaz" bu üründe bir iddia değil, ölçümdür.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { arsiviDenetle, VARSAYILAN_SINIRLAR, type Bulgu } from "../src/store/denetim.js";
import { onarimBilgisi } from "../src/store/onarim.js";
import { RegistryDepo, caseKeyYap, type DavaKaydi } from "../src/store/registry.js";
import { tmpKok } from "./yardimci.js";

const sha = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");

/** Arşivdeki her dosyanın içerik özeti + boyut + izin biti. */
function parmakIzi(kok: string): Map<string, string> {
  const tablo = new Map<string, string>();
  const yuru = (dizin: string) => {
    let girdiler;
    try {
      girdiler = readdirSync(dizin, { withFileTypes: true });
    } catch {
      tablo.set(`${relative(kok, dizin)}/`, "<dizin-okunamadi>");
      return;
    }
    for (const g of girdiler) {
      const tam = join(dizin, g.name);
      const rel = relative(kok, tam);
      if (g.isSymbolicLink()) {
        tablo.set(rel, "<symlink>");
        continue;
      }
      if (g.isDirectory()) {
        yuru(tam);
        continue;
      }
      const bilgi = statSync(tam);
      let ozet: string;
      try {
        ozet = sha(readFileSync(tam));
      } catch {
        // 000 izinli dosya: içeriği okunamaz ama boyutu ve izni izlenir.
        ozet = "<okunamadi>";
      }
      tablo.set(rel, `${ozet}:${bilgi.size}:${(bilgi.mode & 0o777).toString(8)}`);
    }
  };
  yuru(kok);
  return tablo;
}

function esitMi(once: Map<string, string>, sonra: Map<string, string>): string[] {
  const farklar: string[] = [];
  for (const [k, v] of once) {
    if (!sonra.has(k)) farklar.push(`silindi: ${k}`);
    else if (sonra.get(k) !== v) farklar.push(`değişti: ${k}`);
  }
  for (const k of sonra.keys()) if (!once.has(k)) farklar.push(`eklendi: ${k}`);
  return farklar;
}

interface EvrakTanim {
  ad: string;
  icerik: string;
  kategori?: string;
  /** "ok" ise türev dosyası da yazılır (aksi belirtilmedikçe). */
  mdStatus?: string;
  /** false ise mdStatus "ok" olsa bile türev dosyası YAZILMAZ (kırık türev). */
  turevYaz?: boolean;
  /** Manifest'e yazılacak sha256 (verilmezse gerçek içerikten hesaplanır). */
  sha?: string;
  /** Manifest'e yazılacak yol (verilmezse gerçek yol). */
  yol?: string;
}

const OPAK = (ad: string) => `OPAK-TOKEN-${ad}-9f3a1c7d2b`;

function davaKur(
  kok: string,
  birimAdi: string,
  esasNo: string,
  evraklar: EvrakTanim[],
  sec: { manifestHam?: string; manifestYazma?: boolean } = {},
): { kayit: DavaKaydi; klasor: string } {
  const klasor = join(
    kok,
    "Avukat UYAP",
    "AVUKAT",
    "Hukuk",
    "HUKUK MAHKEMESI",
    `${birimAdi} ${esasNo.replace("/", "-")}`,
  );
  mkdirSync(klasor, { recursive: true });
  const satirlar = evraklar.map((e, i) => {
    const kat = e.kategori ?? "02-Dilekceler";
    const rel = `_kaynak/evraklar/Gelen/${kat}/${e.ad}`;
    const tam = join(klasor, rel);
    mkdirSync(join(tam, ".."), { recursive: true });
    writeFileSync(tam, e.icerik);
    const mdStatus = e.mdStatus ?? "ok";
    const mdRel = `evraklar/Gelen/${kat}/${e.ad.replace(/\.[^.]+$/, "")}.md`;
    if (mdStatus === "ok" && e.turevYaz !== false) {
      const mdTam = join(klasor, mdRel);
      mkdirSync(join(mdTam, ".."), { recursive: true });
      writeFileSync(mdTam, `# ${e.ad}\n\nsentetik metin\n`);
    }
    return {
      evrakId: OPAK(e.ad),
      stableKey: `ana:${100 + i}`,
      path: e.yol ?? rel,
      sha256: e.sha ?? sha(e.icerik),
      isEkEvrak: false,
      category: kat,
      yon: "Gelen",
      tur: "Dilekçe",
      gonderen: "Sentetik Gönderen",
      tarih: `0${(i % 9) + 1}/09/2026`,
      birimEvrakNo: String(100 + i),
      dosyaKey: "sentetik-dosya-key",
      mdStatus,
      ...(mdStatus === "ok" ? { mdPath: mdRel } : {}),
      boyut: Buffer.byteLength(e.icerik),
    };
  });
  if (sec.manifestYazma !== false) {
    const ham =
      sec.manifestHam ??
      JSON.stringify(
        {
          surum: 1,
          dosyaId: OPAK(`dosya-${esasNo}`),
          mahkeme: birimAdi,
          birimId: "7000",
          esasNo,
          isIcra: false,
          clonedAt: "2026-09-01T10:00:00.000Z",
          evraklar: satirlar,
        },
        null,
        2,
      );
    writeFileSync(join(klasor, "uyap-project.json"), ham);
  }
  const kayit: DavaKaydi = {
    caseKey: caseKeyYap(birimAdi, esasNo),
    portal: "avukat",
    kaynak: ["sentetik"],
    dosyaNo: esasNo,
    birimAdi,
    birimId: "7000",
    group: "Hukuk",
    kod: "HUKUK MAHKEMESI",
    yargiTuru: "1",
    isIcra: false,
    isCbs: false,
    kapsam: "hepsi",
    portalGoruldu: "2026-09-01T10:00:00.000Z",
    klonYolu: klasor,
  };
  return { kayit, klasor };
}

const turleri = (b: Bulgu[]) => b.map((x) => x.tur).sort();
const tur = (b: Bulgu[], t: string) => b.filter((x) => x.tur === t);

// ── KABUL 1 ─────────────────────────────────────────────────────────────────
describe("P06a sağlam arşiv: temiz sonuç ve DEĞİŞMEYEN baytlar", () => {
  const kok = tmpKok(),
    ayar = tmpKok();
  let davalar: DavaKaydi[] = [];
  before(() => {
    const a = davaKur(kok.kok, "Test Hukuk Mahkemesi", "2026/11", [
      { ad: "dilekce.udf", icerik: "birinci belge" },
      { ad: "rapor.pdf", icerik: "ikinci belge", mdStatus: "gorsel" },
      { ad: "zabit.udf", icerik: "üçüncü belge" },
    ]);
    davalar = [a.kayit];
    // Registry GERÇEKTEN yazılır: kabul ölçütü "manifest ve registry baytları
    // aynı" diyor, bellekteki nesne bunu kanıtlamaz.
    const depo = new RegistryDepo(join(ayar.kok, "davalarim.json"));
    depo.koy(a.kayit);
  });
  after(() => {
    kok.temizle();
    ayar.temizle();
  });

  test("temiz sonuç ve doğru sayılar", async () => {
    const s = await arsiviDenetle({ kok: kok.kok, davalar });
    assert.equal(s.tamamlandi, true, JSON.stringify(s.kismiSebep));
    assert.deepEqual(s.bulgular, []);
    assert.equal(s.sayilar.dava, 1);
    assert.equal(s.sayilar.denetlenen, 1);
    assert.equal(s.sayilar.kayit, 3);
    assert.equal(s.sayilar.saglam, 3);
    assert.equal(s.sayilar.bulgu, 0);
    assert.equal(s.sayilar.bilgi, 0);
    assert.equal(s.sayilar.yetim, 0);
    // 3 kaynak + 2 türev (gorsel olanın türevi yok) + manifest
    assert.equal(s.sayilar.dosya, 6);
    assert.equal(s.sayilar.turev, 2);
    assert.equal(s.davalar[0]!.durum, "denetlendi");
    assert.equal(s.davalar[0]!.saglam, 3);
    assert.equal(
      s.sayilar.olculenBayt,
      ["birinci belge", "ikinci belge", "üçüncü belge"].reduce(
        (a, b) => a + Buffer.byteLength(b),
        0,
      ),
    );
  });

  test("DENETİM HİÇBİR BAYTI DEĞİŞTİRMEZ: arşiv + registry parmak izi aynı", async () => {
    const arsivOnce = parmakIzi(kok.kok);
    const ayarOnce = parmakIzi(ayar.kok);
    assert.ok(arsivOnce.size >= 6, "sentetik arşiv kurulamadı");
    await arsiviDenetle({ kok: kok.kok, davalar });
    await arsiviDenetle({ kok: kok.kok, davalar, caseKey: davalar[0]!.caseKey });
    assert.deepEqual(esitMi(arsivOnce, parmakIzi(kok.kok)), []);
    assert.deepEqual(esitMi(ayarOnce, parmakIzi(ayar.kok)), []);
  });

  test("opak portal tokenı rapora GİRMEZ", async () => {
    const s = await arsiviDenetle({ kok: kok.kok, davalar });
    const metin = JSON.stringify(s);
    assert.ok(!metin.includes("OPAK-TOKEN"), "opak token rapora sızdı");
    assert.ok(metin.includes("Test Hukuk Mahkemesi 2026/11"));
  });
});

// ── KABUL 2 ─────────────────────────────────────────────────────────────────
describe("P06a beş ayrı bulgu: eksik / değişmiş / kırık türev / bozuk JSON / okunamayan", () => {
  const kok = tmpKok();
  let davalar: DavaKaydi[] = [];
  let klasorA = "";
  let okunamayan = "";
  before(() => {
    const a = davaKur(kok.kok, "A Mahkemesi", "2026/21", [
      { ad: "silinen.udf", icerik: "silinecek belge" },
      { ad: "degisen.udf", icerik: "özgün içerik" },
      { ad: "turevi-kirik.udf", icerik: "türevi silinecek" },
      { ad: "izinsiz.udf", icerik: "okunamayacak belge" },
      { ad: "saglam.udf", icerik: "bu sağlam" },
    ]);
    klasorA = a.klasor;
    const b = davaKur(kok.kok, "B Mahkemesi", "2026/22", [], {
      manifestHam: '{"surum":1,"dosyaId":"x","evraklar":[ BOZUK',
    });
    davalar = [a.kayit, b.kayit];
    const kaynak = (ad: string) =>
      join(klasorA, "_kaynak", "evraklar", "Gelen", "02-Dilekceler", ad);
    rmSync(kaynak("silinen.udf"));
    writeFileSync(kaynak("degisen.udf"), "elle değiştirilmiş içerik");
    rmSync(join(klasorA, "evraklar", "Gelen", "02-Dilekceler", "turevi-kirik.md"));
    okunamayan = kaynak("izinsiz.udf");
    chmodSync(okunamayan, 0o000);
  });
  after(() => {
    try {
      chmodSync(okunamayan, 0o600);
    } catch {
      /* */
    }
    kok.temizle();
  });

  test("beş bozukluk BEŞ AYRI doğru bulgu üretir ve eksenleri karışmaz", async () => {
    const s = await arsiviDenetle({ kok: kok.kok, davalar });
    assert.equal(tur(s.bulgular, "kaynak-yok").length, 1);
    assert.match(tur(s.bulgular, "kaynak-yok")[0]!.yol, /silinen\.udf$/);
    assert.equal(tur(s.bulgular, "hash-uyusmuyor").length, 1);
    const h = tur(s.bulgular, "hash-uyusmuyor")[0]!;
    assert.match(h.yol, /degisen\.udf$/);
    assert.equal(h.beklenen, sha("özgün içerik"));
    assert.equal(h.olculen, sha("elle değiştirilmiş içerik"));
    assert.equal(tur(s.bulgular, "turev-yok").length, 1);
    assert.match(tur(s.bulgular, "turev-yok")[0]!.yol, /turevi-kirik\.md$/);
    assert.equal(tur(s.bulgular, "manifest-bozuk").length, 1);
    assert.equal(tur(s.bulgular, "kaynak-erisilemiyor").length, 1);
    assert.equal(tur(s.bulgular, "kaynak-erisilemiyor")[0]!.errno, "EACCES");
    // "dosya yok" ile "okuma izni yok" AYRIDIR: aynı türe düşmezler.
    assert.notEqual(
      tur(s.bulgular, "kaynak-yok")[0]!.tur,
      tur(s.bulgular, "kaynak-erisilemiyor")[0]!.tur,
    );
    // Kaynak hatası ile "metin çıkarılamıyor" aynı kutuda değildir.
    assert.equal(tur(s.bulgular, "turev-yok")[0]!.eksen, "turev");
    assert.equal(tur(s.bulgular, "kaynak-yok")[0]!.eksen, "kaynak");
    assert.equal(tur(s.bulgular, "manifest-bozuk")[0]!.eksen, "kayit");
    // Bozuk manifest'li dava "sağlam" SAYILMAZ ve rapor kısmi olur.
    assert.equal(s.davalar.find((d) => d.dava.startsWith("B"))!.durum, "denetlenemedi");
    assert.equal(s.tamamlandi, false);
    assert.equal(s.sayilar.denetlenen, 1);
    assert.equal(s.sayilar.dava, 2);
    // saglam.udf VE turevi-kirik.udf: ikincisinin KAYNAĞI yerinde ve özeti
    // tutuyor, kırılan yalnız türevi. İki eksenin ayrı olmasının ölçüsü budur.
    assert.equal(s.sayilar.saglam, 2, "kaynağı sağlam olan iki kayıt");
  });

  test("bozuk arşivde de HİÇBİR BAYT değişmez", async () => {
    const once = parmakIzi(kok.kok);
    await arsiviDenetle({ kok: kok.kok, davalar });
    assert.deepEqual(esitMi(once, parmakIzi(kok.kok)), []);
  });
});

// ── KABUL 3 ─────────────────────────────────────────────────────────────────
describe("P06a mükerrer kayıt raporlanır, aynı adlı farklı belgeler BİRLEŞTİRİLMEZ", () => {
  const kok = tmpKok();
  after(() => kok.temizle());

  test("aynı adlı ama farklı iki belge mükerrer SAYILMAZ", async () => {
    const a = davaKur(kok.kok, "C Mahkemesi", "2026/31", [
      { ad: "karar.udf", icerik: "gelen karar", kategori: "02-Dilekceler" },
      { ad: "karar.udf", icerik: "giden karar", kategori: "03-Kararlar" },
    ]);
    const s = await arsiviDenetle({ kok: kok.kok, davalar: [a.kayit] });
    assert.deepEqual(turleri(s.bulgular), []);
    assert.equal(s.sayilar.saglam, 2, "iki ayrı belge de kendi hâliyle sağlam");
  });

  test("kimliği farklı, geri kalanı aynı iki kayıt: TEK mükerrer bulgusu", async () => {
    const a = davaKur(kok.kok, "D Mahkemesi", "2026/32", [
      { ad: "tek.udf", icerik: "tek belge" },
    ]);
    const manifest = join(a.klasor, "uyap-project.json");
    const m = JSON.parse(readFileSync(manifest, "utf8"));
    m.evraklar.push({ ...m.evraklar[0], evrakId: OPAK("ikinci-kimlik") });
    writeFileSync(manifest, JSON.stringify(m, null, 2));
    const s = await arsiviDenetle({ kok: kok.kok, davalar: [a.kayit] });
    assert.equal(tur(s.bulgular, "mukerrer-kayit").length, 1);
    assert.equal(tur(s.bulgular, "mukerrer-kayit")[0]!.adet, 2);
    assert.equal(tur(s.bulgular, "yol-cakismasi").length, 0);
    // Denetim BİRLEŞTİRMEZ: iki satır da ayrı ayrı ölçülmeye devam eder.
    assert.equal(s.sayilar.kayit, 2);
    // İNCELEMEDE YAKALANDI: bu durum ÜRÜNÜN KENDİ KURALIYLA oluşuyor —
    // tekrar.ts portal iki kimliği de döndürürken kaydı bilerek daraltmıyor.
    // Kırmızı bulgu sayılırsa denetim kendi doğru davranışını arıza gösterir.
    assert.equal(tur(s.bulgular, "mukerrer-kayit")[0]!.agirlik, "bilgi");
    // Sekme sayacına GİRMEZ. (Bu tmp kökünde başka testlerin klasörleri de
    // durduğu için toplam sayaç sıfır değil; iddia MÜKERRER KAYDIN kendisi.)
    assert.ok(
      !s.bulgular.some((b) => b.tur === "mukerrer-kayit" && b.agirlik === "bulgu"),
      "mükerrer kayıt sekme sayacını yakmamalı",
    );
    // Çelişen kayıt AYRI ve kırmızı kalır (aşağıdaki test onu ölçer).
  });

  test("aynı dosyayı gösteren ÇELİŞEN iki kayıt ayrı bulgudur", async () => {
    const a = davaKur(kok.kok, "E Mahkemesi", "2026/33", [
      { ad: "celiskili.udf", icerik: "asıl içerik" },
    ]);
    const manifest = join(a.klasor, "uyap-project.json");
    const m = JSON.parse(readFileSync(manifest, "utf8"));
    m.evraklar.push({
      ...m.evraklar[0],
      evrakId: OPAK("celisen"),
      sha256: sha("bambaşka içerik"),
      tur: "Bilirkişi Raporu",
    });
    writeFileSync(manifest, JSON.stringify(m, null, 2));
    const s = await arsiviDenetle({ kok: kok.kok, davalar: [a.kayit] });
    assert.equal(tur(s.bulgular, "yol-cakismasi").length, 1);
    assert.equal(tur(s.bulgular, "mukerrer-kayit").length, 0);
    assert.equal(tur(s.bulgular, "hash-uyusmuyor").length, 1);
    // Fazladan kayıt bilgi, ÇELİŞEN kayıt bulgudur — ayrım burada tutuluyor.
    assert.equal(tur(s.bulgular, "yol-cakismasi")[0]!.agirlik, "bulgu");
  });
});

// ── KABUL 4 ─────────────────────────────────────────────────────────────────
describe("P06a kök dışı okuma reddedilir, dış dosya içeriği rapora SIZMAZ", () => {
  const kok = tmpKok(),
    dis = tmpKok();
  const SIR = "MUVEKKIL-SIRRI-BU-METIN-RAPORA-GIRMEMELI";
  after(() => {
    kok.temizle();
    dis.temizle();
  });

  test("kök dışını gösteren kayıt ve symlink kapsam-disi olur, içerik sızmaz", async () => {
    writeFileSync(join(dis.kok, "disarida.txt"), SIR);
    const a = davaKur(kok.kok, "F Mahkemesi", "2026/41", [
      { ad: "normal.udf", icerik: "içeride" },
    ]);
    const manifest = join(a.klasor, "uyap-project.json");
    const m = JSON.parse(readFileSync(manifest, "utf8"));
    m.evraklar.push({
      ...m.evraklar[0],
      evrakId: OPAK("kacak"),
      path: relative(a.klasor, join(dis.kok, "disarida.txt")),
      mdStatus: "bekliyor",
      mdPath: undefined,
    });
    writeFileSync(manifest, JSON.stringify(m, null, 2));
    // Arşivin İÇİNDEN dışarı bakan symlink: takip EDİLMEZ.
    symlinkSync(
      join(dis.kok, "disarida.txt"),
      join(a.klasor, "_kaynak", "evraklar", "Gelen", "02-Dilekceler", "kacak-link.udf"),
    );
    const s = await arsiviDenetle({ kok: kok.kok, davalar: [a.kayit] });
    const kacaklar = tur(s.bulgular, "kapsam-disi");
    assert.equal(kacaklar.length, 2, JSON.stringify(turleri(s.bulgular)));
    assert.deepEqual(
      kacaklar.map((b) => b.eksen).sort(),
      ["kaynak", "yetim"],
    );
    const rapor = JSON.stringify(s);
    assert.ok(!rapor.includes(SIR), "dış dosya içeriği rapora sızdı");
    assert.ok(!rapor.includes(dis.kok), "arşiv dışı mutlak yol rapora sızdı");
    assert.equal(s.sayilar.saglam, 1);
  });

  test("hiçbir bulgu MUTLAK yol taşımaz (arşiv düzeni sızmaz)", async () => {
    const a = davaKur(kok.kok, "G Mahkemesi", "2026/42", [
      { ad: "x.udf", icerik: "x" },
    ]);
    rmSync(join(a.klasor, "_kaynak", "evraklar", "Gelen", "02-Dilekceler", "x.udf"));
    const s = await arsiviDenetle({
      kok: kok.kok,
      davalar: [a.kayit],
      caseKey: a.kayit.caseKey,
    });
    assert.deepEqual(turleri(s.bulgular), ["kaynak-yok"]);
    for (const b of s.bulgular) {
      assert.ok(!b.yol.startsWith("/"), `mutlak yol: ${b.yol}`);
      assert.ok(!b.aciklama.includes(kok.kok));
    }
  });
});

// ── KABUL 6 ─────────────────────────────────────────────────────────────────
describe("P06a kısmi sonuç korunur ve KISMİ olduğu görünür", () => {
  const kok = tmpKok();
  let davalar: DavaKaydi[] = [];
  before(() => {
    const a = davaKur(kok.kok, "H Mahkemesi", "2026/51", [
      { ad: "bir.udf", icerik: "bir" },
      { ad: "iki.udf", icerik: "iki" },
      { ad: "uc.udf", icerik: "üç" },
    ]);
    rmSync(join(a.klasor, "_kaynak", "evraklar", "Gelen", "02-Dilekceler", "bir.udf"));
    davalar = [a.kayit];
  });
  after(() => kok.temizle());

  test("iptal edilen denetim ELDEKİ raporu korur, 'tamamlandı' demez", async () => {
    let cagri = 0;
    const s = await arsiviDenetle({
      kok: kok.kok,
      davalar,
      // İlk kayıt işlendikten sonra iptal: bulgu elde var, tarama yarım.
      iptal: () => ++cagri > 2,
    });
    assert.equal(s.tamamlandi, false);
    assert.match(s.kismiSebep ?? "", /durduruldu/);
    assert.equal(tur(s.bulgular, "kaynak-yok").length, 1, "eldeki bulgu kayboldu");
    assert.equal(s.davalar[0]!.durum, "kismi");
    assert.equal(s.sayilar.denetlenen, 0, "kısmi dava 'denetlendi' sayılmaz");
  });

  test("süre bütçesi dolarsa sonuç kısmi döner ve sebebi yazılır", async () => {
    let t = 0;
    const s = await arsiviDenetle({
      kok: kok.kok,
      davalar,
      simdi: () => (t += 5000),
      sinirlar: { sureTavaniMs: 1000 },
    });
    assert.equal(s.tamamlandi, false);
    assert.match(s.kismiSebep ?? "", /süre bütçesi/);
  });
});

// ── KABUL 7 + eşitleme sürerken ─────────────────────────────────────────────
describe("P06a tek dosyaya bakıp bütün arşiv 'sağlam' işaretlenmez", () => {
  const kok = tmpKok();
  let davalar: DavaKaydi[] = [];
  before(() => {
    const a = davaKur(kok.kok, "I Mahkemesi", "2026/61", [
      { ad: "tarihsel.udf", icerik: "canlı dosyadan gelen" },
    ]);
    const b = davaKur(kok.kok, "J Mahkemesi", "2026/62", [
      { ad: "ikinci.udf", icerik: "ikinci dava" },
    ]);
    // Üçüncü kayıt: registry'de var, klasörü YOK.
    const c: DavaKaydi = { ...b.kayit, caseKey: caseKeyYap("K Mahkemesi", "2026/63"), birimAdi: "K Mahkemesi", dosyaNo: "2026/63", klonYolu: join(kok.kok, "Avukat UYAP", "AVUKAT", "Hukuk", "HUKUK MAHKEMESI", "K Mahkemesi 2026-63") };
    davalar = [a.kayit, b.kayit, c];
  });
  after(() => kok.temizle());

  test("klasörü olmayan dava 'denetlendi' sayılmaz; sayılar kaç dosyanın ölçüldüğünü söyler", async () => {
    const s = await arsiviDenetle({ kok: kok.kok, davalar });
    assert.equal(s.sayilar.dava, 3);
    assert.equal(s.sayilar.denetlenen, 2);
    assert.equal(tur(s.bulgular, "klasor-yok").length, 1);
    assert.equal(s.tamamlandi, false, "eksik kapsam 'tamamlandı' gösterilemez");
  });

  test("EŞİTLEME SÜRERKEN o dava atlanır ve rapor kısmi olur", async () => {
    const mesgul = (caseKey: string) => caseKey === davalar[1]!.caseKey;
    const s = await arsiviDenetle({ kok: kok.kok, davalar, mesgul });
    const j = s.davalar.find((d) => d.dava.startsWith("J"))!;
    assert.equal(j.durum, "atlandi-mesgul");
    assert.equal(j.kayit, 0, "meşgul dava hiç ölçülmedi");
    assert.equal(s.tamamlandi, false);
    assert.match(s.kismiSebep ?? "", /eşitleme/i);
    // Diğer dava yine de ölçülür: bir dosya yüzünden bütün rapor kaybolmaz.
    assert.equal(s.davalar.find((d) => d.dava.startsWith("I"))!.durum, "denetlendi");
  });

  test("denetim SIRASINDA başlayan eşitleme o dosyanın sonucunu geçersiz kılar", async () => {
    let cagri = 0;
    const tek = [davalar[0]!];
    const s = await arsiviDenetle({
      kok: kok.kok,
      davalar: tek,
      // İlk soruda boşta, ikinci soruda (dava bitince) meşgul.
      mesgul: () => cagri++ > 0,
    });
    assert.equal(s.davalar[0]!.durum, "atlandi-mesgul");
    assert.match(s.davalar[0]!.not ?? "", /Denetim sırasında/);
    assert.equal(s.tamamlandi, false);
    assert.equal(s.sayilar.denetlenen, 0);
  });
});

// ── yetim / yedek / türev sınıfları ─────────────────────────────────────────
describe("P06a yetim dosya ÇÖP DEĞİLDİR; türev ve yedek yetim sayılmaz", () => {
  const kok = tmpKok();
  let davalar: DavaKaydi[] = [];
  before(() => {
    const a = davaKur(kok.kok, "L Mahkemesi", "2026/71", [
      { ad: "kayitli.udf", icerik: "kayıtlı belge" },
    ]);
    const dizin = join(a.klasor, "_kaynak", "evraklar", "Gelen", "02-Dilekceler");
    writeFileSync(join(dizin, "korunmus-eski-kaynak.udf"), "eski sürüm");
    // Türev: manifest'te KAYITLI DEĞİL ama yetim sayılmaz (ayrı sınıf).
    writeFileSync(
      join(a.klasor, "evraklar", "Gelen", "02-Dilekceler", "artik-kayitsiz.md"),
      "# eski metin",
    );
    // Manifest yedeği: yetim sayılmaz.
    writeFileSync(join(a.klasor, "uyap-project.yedek-1788714155481.json"), "{}");
    // Gizli dosya: hiç taranmaz.
    writeFileSync(join(a.klasor, ".DS_Store"), "mac");
    davalar = [a.kayit];
  });
  after(() => kok.temizle());

  test("yalnız kayıtsız KAYNAK yetimdir; bilgi ağırlığında ve 'çöp' denmez", async () => {
    const s = await arsiviDenetle({ kok: kok.kok, davalar });
    const yetimler = tur(s.bulgular, "yetim-dosya");
    assert.equal(yetimler.length, 1, JSON.stringify(s.bulgular.map((b) => b.yol)));
    assert.match(yetimler[0]!.yol, /korunmus-eski-kaynak\.udf$/);
    assert.equal(yetimler[0]!.agirlik, "bilgi");
    assert.match(yetimler[0]!.aciklama, /ÇÖP DEĞİLDİR/);
    assert.equal(s.sayilar.bulgu, 0, "yetim bir arıza değildir");
    assert.equal(s.sayilar.bilgi, 1);
    assert.equal(s.sayilar.yedek, 1);
    assert.equal(s.sayilar.turev, 2, "kayıtlı + kayıtsız .md");
    assert.equal(s.sayilar.atlanan, 1, ".DS_Store taranmadı");
    // Bilgi kaydı raporu "kısmi" YAPMAZ; kapsam tamamen ölçüldü.
    assert.equal(s.tamamlandi, true);
  });
});

// ── ölçek sınırı ────────────────────────────────────────────────────────────
describe("P06a dosya tavanını aşan kayıt SESSİZCE sağlam sayılmaz", () => {
  const kok = tmpKok();
  after(() => kok.temizle());
  test("tavanı aşan dosya 'olculmedi-buyuk' olur ve sağlam sayılmaz", async () => {
    const a = davaKur(kok.kok, "M Mahkemesi", "2026/81", [
      { ad: "kucuk.udf", icerik: "kısa" },
      { ad: "buyuk.udf", icerik: "x".repeat(4096) },
    ]);
    const s = await arsiviDenetle({
      kok: kok.kok,
      davalar: [a.kayit],
      sinirlar: { dosyaTavani: 1024 },
    });
    const b = tur(s.bulgular, "olculmedi-buyuk");
    assert.equal(b.length, 1);
    assert.match(b[0]!.yol, /buyuk\.udf$/);
    assert.equal(b[0]!.agirlik, "bilgi");
    assert.equal(b[0]!.boyut, 4096);
    assert.equal(s.sayilar.saglam, 1, "ölçülmeyen dosya sağlam sayılmış");
    assert.equal(s.sinirlar.dosyaTavani, 1024);
  });
  test("varsayılan tavan portalın yanıt tavanının en az iki katıdır", () => {
    // Gerekçe (src/store/denetim.ts): indirilen hiçbir evrak 128 MiB'ı geçemez.
    assert.ok(VARSAYILAN_SINIRLAR.dosyaTavani >= 2 * 128 * 1024 * 1024);
    assert.ok(VARSAYILAN_SINIRLAR.sureTavaniMs < 30_000, "web istek zaman aşımı 30 sn");
  });
});

// ── registry ile disk arasındaki iki yönlü fark ─────────────────────────────
describe("P06a 'kayıtlı ama klasörü yok' ile 'klasör var ama kayıtsız' AYRIDIR", () => {
  const kok = tmpKok();
  let davalar: DavaKaydi[] = [];
  before(() => {
    const a = davaKur(kok.kok, "N Mahkemesi", "2026/91", [
      { ad: "n.udf", icerik: "n" },
    ]);
    // Diskte duran ama registry'de OLMAYAN ikinci dava klasörü.
    davaKur(kok.kok, "O Mahkemesi", "2026/92", [{ ad: "o.udf", icerik: "o" }]);
    davalar = [a.kayit];
  });
  after(() => kok.temizle());

  test("tüm arşiv denetiminde kayıtsız klasör bulgu olur", async () => {
    const s = await arsiviDenetle({ kok: kok.kok, davalar });
    const k = tur(s.bulgular, "kayitsiz-klasor");
    assert.equal(k.length, 1);
    assert.match(k[0]!.yol, /O Mahkemesi 2026-92$/);
    assert.equal(k[0]!.caseKey, "");
    assert.ok(!k[0]!.yol.startsWith("/"));
  });

  test("tek dava denetiminde arşiv keşfi YAPILMAZ (kapsam genişlemez)", async () => {
    const s = await arsiviDenetle({
      kok: kok.kok,
      davalar,
      caseKey: davalar[0]!.caseKey,
    });
    assert.equal(tur(s.bulgular, "kayitsiz-klasor").length, 0);
    assert.equal(s.kapsam.tumArsiv, false);
  });

  test("manifest'i olmayan klasör 'manifest-yok' der, evrakları uydurulmaz", async () => {
    const b = davaKur(kok.kok, "P Mahkemesi", "2026/93", [], {
      manifestYazma: false,
    });
    const s = await arsiviDenetle({
      kok: kok.kok,
      davalar: [b.kayit],
      caseKey: b.kayit.caseKey,
    });
    assert.deepEqual(turleri(s.bulgular), ["manifest-yok"]);
    assert.equal(s.sayilar.kayit, 0);
    assert.equal(s.davalar[0]!.durum, "denetlenemedi");
  });
});

// ── kaydı boşalmış dava ─────────────────────────────────────────────────────
// `kayitsiz-klasor`un AYNASI: orada klasör registry'de yok, burada klasör
// kayıtlı ama manifest hiç evrak bildirmiyor. Kullanıcı için sonuç aynı —
// belgeler diskte durur, sol listede "0 evrak" görünür. Tek tek yetim satırı
// `bilgi` kalır (korunmuş eski kaynak olabilir), ama HİÇ kaydı olmayan davada
// duran kaynak bir tutarsızlıktır ve sekme sayacına girmelidir.
describe("P06a kaydı boşalmış dava 'bilgi' değil BULGU üretir", () => {
  const kok = tmpKok();
  after(() => kok.temizle());

  /** Manifest geçerli JSON kalır, yalnız `evraklar` BOŞALTILIR; belgeler durur. */
  function kayitlariBosalt(klasor: string): void {
    const yol = join(klasor, "uyap-project.json");
    const ham = JSON.parse(readFileSync(yol, "utf8")) as { evraklar: unknown[] };
    ham.evraklar = [];
    writeFileSync(yol, JSON.stringify(ham, null, 2));
  }

  test("kayıt sayısı 0 ama klasörde kaynak duruyorsa BULGU çıkar", async () => {
    const a = davaKur(kok.kok, "R Mahkemesi", "2026/103", [
      { ad: "bir.udf", icerik: "bir", mdStatus: "gorsel" },
      { ad: "iki.udf", icerik: "iki", mdStatus: "gorsel" },
    ]);
    kayitlariBosalt(a.klasor);
    const s = await arsiviDenetle({
      kok: kok.kok,
      davalar: [a.kayit],
      caseKey: a.kayit.caseKey,
    });
    const b = tur(s.bulgular, "kayitlar-eksik");
    assert.equal(b.length, 1, JSON.stringify(turleri(s.bulgular)));
    assert.equal(b[0]!.agirlik, "bulgu");
    assert.equal(b[0]!.eksen, "kayit");
    assert.match(b[0]!.aciklama, /kayıtsız 2 belge/);
    assert.equal(s.sayilar.kayit, 0);
    assert.equal(s.sayilar.bulgu, 1, "bulgu sekme sayacına girmedi");
    assert.equal(s.davalar[0]!.bulgu, 1);
    // Tek tek yetim satırları BİLGİ kalır: hiçbirine "çöp" denmez.
    assert.equal(tur(s.bulgular, "yetim-dosya").length, 2);
    assert.equal(s.sayilar.bilgi, 2);
  });

  test("NEGATİF: kayıt VARKEN duran kayıtsız kaynak bu bulguyu doğurmaz", async () => {
    const b = davaKur(kok.kok, "S Mahkemesi", "2026/104", [
      { ad: "kayitli.udf", icerik: "kayıtlı", mdStatus: "gorsel" },
    ]);
    writeFileSync(
      join(b.klasor, "_kaynak", "evraklar", "Gelen", "02-Dilekceler", "korunmus.udf"),
      "korunmuş eski kaynak",
    );
    const s = await arsiviDenetle({
      kok: kok.kok,
      davalar: [b.kayit],
      caseKey: b.kayit.caseKey,
    });
    assert.equal(tur(s.bulgular, "kayitlar-eksik").length, 0);
    assert.equal(tur(s.bulgular, "yetim-dosya").length, 1);
    assert.equal(s.sayilar.bulgu, 0, "korunmuş eski kaynak arıza sayıldı");
  });

  test("NEGATİF: gerçekten boş dava (kayıt yok, dosya yok) bulgu üretmez", async () => {
    const c = davaKur(kok.kok, "T Mahkemesi", "2026/105", []);
    const s = await arsiviDenetle({
      kok: kok.kok,
      davalar: [c.kayit],
      caseKey: c.kayit.caseKey,
    });
    assert.deepEqual(s.bulgular, []);
    assert.equal(s.tamamlandi, true);
  });
});

// ── arayüz: saf üreticiler ──────────────────────────────────────────────────
describe("P06a denetim sekmesi: saf üreticiler", () => {
  let M: Record<string, (...a: unknown[]) => unknown> & Record<string, unknown>;
  before(async () => {
    M = (await import(new URL("../../web/denetim.js", import.meta.url).href)) as never;
  });

  // P06b — `onarim` alanı MOTORDAN gelir; fixture da onu motorun tablosundan
  // türetir. Elle yazılsaydı arayüz testi tabloyla ayrışabilirdi.
  const ornek = (over: Partial<Bulgu> = {}): Bulgu => {
    const tur = over.tur ?? "kaynak-yok";
    return {
      tur,
      eksen: "kaynak",
      agirlik: "bulgu",
      onarim: onarimBilgisi(tur),
      caseKey: "X",
      dava: "X Mahkemesi 2026/1",
      yol: "_kaynak/evraklar/Gelen/02-Dilekceler/a.udf",
      aciklama: "Kaynak belge arşivde yok.",
      ...over,
    };
  };

  test("bulgular EKSENE göre sabit sırayla gruplanır; boş eksen düşer", () => {
    const gruplar = (M["denetimGruplari"] as (b: Bulgu[]) => { eksen: string }[])([
      ornek({ eksen: "yetim", tur: "yetim-dosya", agirlik: "bilgi" }),
      ornek({ eksen: "turev", tur: "turev-yok" }),
      ornek(),
    ]);
    assert.deepEqual(
      gruplar.map((g) => g.eksen),
      ["kaynak", "turev", "yetim"],
    );
  });

  // İNCELEMEDE YAKALANDI: "Kayıtsız dosyalar" grubunun notu sabitti ve
  // "bunlar arıza değildir" diyordu. Arşivin DIŞINI gösteren bağlantı
  // (kapsam-disi, agirlik "bulgu") da bu eksene düşüyor; güvenlik açısından
  // en dikkat çekmesi gereken satır "arıza değil" başlığı altında eleniyordu.
  test("bir eksende arıza varsa grup notu 'arıza değildir' DEMEZ", () => {
    const grupla = M["denetimGruplari"] as (b: Bulgu[]) => { eksen: string; not: string }[];
    const yetim = (b: Bulgu[]) => grupla(b).find((g) => g.eksen === "yetim")!;

    // Yalnız zararsız kayıt: eski cümle aynen durur.
    const zararsiz = yetim([ornek({ eksen: "yetim", tur: "yetim-dosya", agirlik: "bilgi" })]);
    assert.match(zararsiz.not, /arıza değildir/);

    // Araya arşiv dışını gösteren bağlantı girince cümle KURULMAZ.
    const karisik = yetim([
      ornek({ eksen: "yetim", tur: "yetim-dosya", agirlik: "bilgi" }),
      ornek({ eksen: "yetim", tur: "kapsam-disi", agirlik: "bulgu" }),
    ]);
    assert.ok(
      !/^Bunlar arıza değildir/.test(karisik.not),
      "arıza taşıyan grup kendini zararsız ilan etmemeli",
    );
    assert.match(karisik.not, /Bir kısmı arıza/);
    // Kural SINIF kapatır: başka bir eksene bulgu düşse de aynı şey geçerli.
    assert.equal(grupla([ornek()]).find((g) => g.eksen === "kaynak")!.not.includes("arıza değildir"), false);
  });

  // P06b — P06a'nın "hiç düğme yok" kuralı DEĞİŞTİ, ama gevşemedi: düğme
  // yalnız MOTOR onarılabilir dediği satırda çizilir. Bekçi bu dosyada kalıyor
  // çünkü kural denetim ekranının kuralıdır (ayrıntılı ölçüm: test/p06b.test.ts).
  test("onarılamayan bulguda düğme YOKTUR ve sebebi yazılıdır", () => {
    const html = (M["bulguSatiri"] as (b: Bulgu) => string)(
      ornek({ tur: "yetim-dosya", eksen: "yetim", agirlik: "bilgi" }),
    );
    assert.ok(!html.includes("<button"), "onarılamayan bulguda düğme çizilemez");
    assert.match(html, /Bu bulgu onarılamaz:/);
    assert.match(html, /ÇÖP DEĞİLDİR/);
  });

  test("onarılabilir bulguda TEK düğme çizilir ve etiketi motordan gelir", () => {
    const html = (M["bulguSatiri"] as (b: Bulgu, i?: number) => string)(ornek(), 3);
    assert.equal((html.match(/<button/g) ?? []).length, 1);
    assert.match(html, /data-onar="3"/);
    assert.match(html, /data-onar-asama="plan"/);
    assert.match(html, /Kaynağı yeniden indir/);
    assert.ok(html.includes("Belge yok"));
    // Düğme yalnız SATIR NUMARASI taşır: opak yol ve caseKey özniteliğe girmez.
    assert.ok(!/data-onar="[^"]*_kaynak/.test(html));
  });

  test("hash uyuşmazlığı satırı iki özeti de kısaltarak gösterir", () => {
    const html = (M["bulguSatiri"] as (b: Bulgu) => string)(
      ornek({
        tur: "hash-uyusmuyor",
        beklenen: "a".repeat(64),
        olculen: "b".repeat(64),
      }),
    );
    assert.ok(html.includes("aaaaaaaaaaaa…"));
    assert.ok(html.includes("bbbbbbbbbbbb…"));
    assert.ok(!html.includes("a".repeat(64)));
  });

  test("kısmi sonuçta özet 'temiz' DEMEZ ve kaç dosya ölçüldüğünü yazar", () => {
    const metin = (M["denetimOzetMetni"] as (s: unknown) => string)({
      tamamlandi: false,
      kismiSebep: "Eşitlemesi süren dosyalar denetlenmedi.",
      kapsam: { tumArsiv: true },
      sayilar: { dava: 3, denetlenen: 1, kayit: 4, saglam: 4, bulgu: 0, bilgi: 0 },
    });
    assert.match(metin, /1\/3 dosya denetlendi/);
    assert.match(metin, /KISMİ/);
    assert.ok(!/Bulgu yok/.test(metin), "kısmi sonuç 'bulgu yok' diyemez");
  });

  // Bir kayıt ARIZA ÜRETMEDEN de doğrulanmamış kalabilir: dosya tavanını aşan
  // belge `olculmedi-buyuk` (bilgi) olur, sağlam SAYILMAZ. O hâlde bulgu 0'dır
  // ama "arşivim sağlam" değildir; özet bunu söylemek zorunda.
  test("hiçbir kayıt doğrulanmamışken özet 'Bulgu yok' DEMEZ", () => {
    const metin = (M["denetimOzetMetni"] as (s: unknown) => string)({
      tamamlandi: true,
      kapsam: { tumArsiv: false },
      sayilar: { dava: 1, denetlenen: 1, kayit: 5, saglam: 0, bulgu: 0, bilgi: 5 },
    });
    assert.ok(!/Bulgu yok/.test(metin), metin);
    assert.match(metin, /5 kayıt özetiyle karşılaştırılamadı/);
    assert.match(metin, /“sağlam” demek değildir/);
  });

  test("her kayıt özetiyle eşleştiğinde özet 'Bulgu yok' der", () => {
    const metin = (M["denetimOzetMetni"] as (s: unknown) => string)({
      tamamlandi: true,
      kapsam: { tumArsiv: true },
      sayilar: { dava: 2, denetlenen: 2, kayit: 7, saglam: 7, bulgu: 0, bilgi: 0 },
    });
    assert.match(metin, /Bulgu yok\./);
  });

  // Motorda yeni bulgu türü açıp etiket haritasını unutmak ekranda ham slug
  // gösterir (P16'daki varlık haritası hatasının bu ekrandaki karşılığı).
  test("her bulgu türünün Türkçe etiketi var: ham slug ekrana çıkmaz", () => {
    const kaynak = readFileSync(
      new URL("../../src/store/denetim.ts", import.meta.url),
      "utf8",
    );
    const blok = /export type BulguTuru =([\s\S]*?);\n/.exec(kaynak);
    assert.ok(blok, "BulguTuru birleşimi kaynakta bulunamadı");
    const turler = [...blok[1]!.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]!);
    assert.ok(turler.length >= 17, `beklenenden az tür: ${turler.length}`);
    const etiket = M["DENETIM_TUR_ETIKET"] as unknown as Record<string, string>;
    const etiketsiz = turler.filter((t) => typeof etiket[t] !== "string");
    assert.deepEqual(etiketsiz, [], "etiketsiz bulgu türü");
  });

  test("hiç koşmamış denetimde sekme sayacı BOŞTUR (sayı uydurulmaz)", () => {
    const f = M["denetimSekmeSayaci"] as (s: unknown) => string;
    assert.equal(f(null), "");
    assert.equal(f({ sayilar: { bulgu: 0 } }), "");
    assert.equal(f({ sayilar: { bulgu: 3 } }), "(3)");
  });

  test("sonuç ekranı ne YAPMADIĞINI yazar: toplu onarım, silme, taşıma yok", () => {
    const html = (M["denetimSonucHTML"] as (s: unknown) => string)({
      tamamlandi: true,
      kapsam: { tumArsiv: true },
      sayilar: { dava: 1, denetlenen: 1, kayit: 1, saglam: 0, bulgu: 1, bilgi: 0 },
      davalar: [{ dava: "X", durum: "denetlendi" }],
      bulgular: [ornek({ tur: "yetim-dosya", eksen: "yetim", agirlik: "bilgi" })],
    });
    assert.match(html, /“hepsini onar” düğmesi yoktur/);
    assert.match(html, /dosya silme, klasör taşıma/);
    // Onarılamayan tek bulgulu raporda hiçbir düğme yoktur.
    assert.ok(!html.includes("<button"));
  });

  test("denetlenemeyen dosyalar ayrı bir uyarı kutusunda görünür", () => {
    const html = (M["atlananlarHTML"] as (s: unknown) => string)({
      davalar: [
        { dava: "A", durum: "denetlendi" },
        { dava: "B", durum: "atlandi-mesgul", not: "eşitleme sürüyor" },
      ],
    });
    assert.match(html, /Denetlenemeyen dosyalar/);
    assert.match(html, /eşitleme sürüyor/);
    assert.ok(!html.includes(">A<"));
  });
});

// ── arayüz: üçüncü sekmenin DOM davranışı ───────────────────────────────────
describe("P06a üçüncü sekme: Evraklar | Sorunlar | Denetim", () => {
  const ogeler = new Map<string, Record<string, unknown>>();
  const yeniOge = (id: string): Record<string, unknown> => ({
    id,
    textContent: "",
    innerHTML: "",
    disabled: false,
    hidden: false,
    checked: false,
    dataset: {},
    classList: { toggle: () => {} },
    querySelectorAll: () => [] as unknown[],
    setAttribute: () => {},
    addEventListener: () => {},
    closest: () => null,
  });
  const bul = (id: string) => ogeler.get(id) ?? null;
  let ortaSekmeSec: (ad: string) => void;
  let durum: Record<string, unknown>;
  let yedekDoc: unknown;
  before(async () => {
    for (const id of [
      "document-list",
      "evrak-araclar",
      "evrak-eylemler",
      "sorun-liste",
      "sorun-araclar",
      "sorun-sayaci",
      "sorun-ozet",
      "sorun-kapsam",
      "denetim-liste",
      "denetim-araclar",
      "denetim-sayaci",
      "denetim-ozet",
      "denetim-kapsam",
      "denetim-at",
    ])
      ogeler.set(id, yeniOge(id));
    yedekDoc = (globalThis as Record<string, unknown>)["document"];
    (globalThis as Record<string, unknown>)["document"] = {
      querySelector: (sel: string) => (sel.startsWith("#") ? bul(sel.slice(1)) : null),
      querySelectorAll: () => [] as unknown[],
    };
    const ortak = await import(new URL("../../web/ortak.js", import.meta.url).href);
    durum = ortak.state as Record<string, unknown>;
    durum["issues"] = { acik: [], hepsi: [] };
    ({ ortaSekmeSec } = (await import(
      new URL("../../web/arsiv.js", import.meta.url).href
    )) as never);
  });
  after(() => {
    (globalThis as Record<string, unknown>)["document"] = yedekDoc;
  });

  test("denetim sekmesi evrak ve sorun listelerini gizler, kendi araçlarını açar", () => {
    ortaSekmeSec("denetim");
    assert.equal(bul("denetim-liste")!["hidden"], false);
    assert.equal(bul("denetim-araclar")!["hidden"], false);
    assert.equal(bul("document-list")!["hidden"], true);
    assert.equal(bul("evrak-eylemler")!["hidden"], true);
    assert.equal(bul("sorun-liste")!["hidden"], true);
    assert.equal(bul("sorun-araclar")!["hidden"], true);
    // Sorun sekmesine dönüş denetim sütununu kapatır.
    ortaSekmeSec("sorun");
    assert.equal(bul("denetim-liste")!["hidden"], true);
    assert.equal(bul("denetim-araclar")!["hidden"], true);
    assert.equal(bul("sorun-liste")!["hidden"], false);
    ortaSekmeSec("evrak");
    assert.equal(bul("document-list")!["hidden"], false);
    assert.equal(bul("denetim-liste")!["hidden"], true);
    assert.equal(bul("sorun-liste")!["hidden"], true);
  });

  test("DENETİM KENDİLİĞİNDEN KOŞMAZ: sekmeye girmek rapor üretmez", () => {
    durum["denetim"] = null;
    ortaSekmeSec("denetim");
    assert.equal(durum["denetim"], null, "sekmeye girmek denetim başlattı");
    assert.match(
      String(bul("denetim-liste")!["innerHTML"]),
      /Denetim çalıştırılmadı/,
    );
    assert.match(String(bul("denetim-ozet")!["textContent"]), /çalıştırılmadı/);
    ortaSekmeSec("evrak");
  });

  test("koşan denetim tek yerden çağrılır: yalnız düğme ve arsiv.js", async () => {
    const oku = (ad: string) =>
      readFileSync(new URL(`../../web/${ad}`, import.meta.url), "utf8");
    const denetim = oku("denetim.js");
    // Modül gövdesinde ya da çizim yolunda RPC çağrısı YOK: `api(` yalnız
    // `denetimiCalistir` içinde geçer.
    assert.equal((denetim.match(/api\(\s*\n?\s*"arsiv-denetle"/g) ?? []).length, 1);
    assert.match(oku("arsiv.js"), /#denetim-calistir"\)\.onclick/);
    // `poll` turuna bağlanmadı: 5 sn'lik yoklama denetim çağırmaz.
    assert.ok(!/denetimiCalistir/.test(oku("app.js")));
  });
});
