// Dönüşüm motoru testleri: zip / udf / htmlmd / pdftext

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { zipAc } from "../src/convert/zip.js";
import { udfMu, udfToMd, udfIcerikCikar } from "../src/convert/udf.js";
import { htmlToMd, htmlBaslik } from "../src/convert/htmlmd.js";
import { pdfMetinKatlmaniVarMi, pdfToMd, pdftotextBul } from "../src/convert/pdftext.js";
import { donustur } from "../src/convert/run.js";
import { hazirlikCoz, hazirlikOzet } from "../src/store/hazirlik.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { zipYaz, makeUdf, makeHtml, miniPdf, tmpKok, davaYaz } from "./yardimci.js";

describe("zip", () => {
  test("store zip açma", () => {
    const buf = zipYaz([
      { ad: "a.txt", veri: Buffer.from("merhaba", "utf8") },
      { ad: "b/c.txt", veri: Buffer.from("dünya".repeat(40), "utf8") },
    ]);
    const g = zipAc(buf);
    assert.equal(g["a.txt"]?.toString("utf8"), "merhaba");
    assert.equal(g["b/c.txt"]?.toString("utf8"), "dünya".repeat(40));
  });

  test("bozuk zip hata verir", () => {
    assert.throws(() => zipAc(Buffer.from("zip değil bu", "utf8")));
  });
});

describe("udf", () => {
  const paragraflar = [
    "T.C. TEST SULH HUKUK MAHKEMESİ’NE",
    "",
    "DOSYA NO : 2026/928 E.",
    "Davalı : Ahmet YILMAZ",
    "AÇIKLAMALAR",
    "Örnekleme paragrafı: 10.000,00 TL alacağın tahsili istenmektedir.",
  ];

  test("udfMu tanır", () => {
    const udf = makeUdf(paragraflar);
    assert.equal(udfMu(udf), true);
    assert.equal(udfMu(Buffer.from("udf değil", "utf8")), false);
  });

  test("udfToMd metni doğru çıkarır", () => {
    const udf = makeUdf(paragraflar);
    const { md, bilgi } = udfToMd(udf);
    assert.ok(md.includes("T.C. TEST SULH HUKUK MAHKEMESİ’NE"));
    assert.ok(md.includes("2026/928 E."));
    assert.ok(md.includes("10.000,00 TL"));
    // boş paragraf → boş satır (ayraç korunur)
    assert.ok(md.includes("\n\n"));
    assert.ok(bilgi.paragrafSayisi >= paragraflar.length);
    assert.equal(bilgi.formatId, "1.8");
  });

  test("çoklu paragraf ofsetleri doğru dilimlenir", () => {
    const udf = makeUdf(["A", "B", "C"]);
    const { metin, paragraflar: p } = udfIcerikCikar(udf);
    assert.equal(metin, "A\nB\nC\n");
    assert.equal(p.length, 3);
    assert.deepEqual(p[0], { baslangic: 0, uzunluk: 2 });
  });

  test("content.xml yoksa açık hata", () => {
    const z = zipYaz([{ ad: "baska.xml", veri: Buffer.from("x") }]);
    assert.throws(() => udfToMd(z), /content\.xml yok/);
  });
});

describe("htmlmd", () => {
  test("basit UYAP html → md", () => {
    const html = makeHtml(
      '<div>İDARE: TEST A.Ş.</div><div>Yer: Ankara</div><div>Tarih: 01/09/2026</div><div>Konu: Vekalet Pulu Makbuzu</div>'
    );
    const { md } = htmlToMd(html.toString("utf8"));
    assert.ok(md.includes("İDARE: TEST A.Ş."));
    assert.ok(md.includes("Vekalet Pulu Makbuzu"));
    assert.ok(!md.includes("<div"));
  });

  test("başlık ve varlıklar", () => {
    const html = "<html><head><title>Makbuz&nbsp;Test</title></head><body><h1>Harç &amp; Pul</h1><p>öğrenci müdürlüğü &#305;zni</p></body></html>";
    const { md } = htmlToMd(html);
    assert.equal(htmlBaslik(html), "Makbuz Test");
    assert.ok(md.includes("# Harç & Pul"));
    assert.ok(md.includes("i zni".replace(" ", "")) || md.includes("ızni"), "unicode varlık çözülür");
    assert.ok(md.includes("Harç & Pul"));
  });
});

describe("pdftext", () => {
  test("metin katmanı tespiti", () => {
    const pdf = miniPdf();
    assert.equal(pdfMetinKatlmaniVarMi(pdf), true);
  });

  test("taranmış tespiti — metin operatörü yoksa", () => {
    const pdf = Buffer.from(
      "%PDF-1.4\n1 0 obj\n<< /Type /Page /Resources << /XObject << /Im0 2 0 R >> >> >>\nendobj\n2 0 obj\n<< /Type /XObject /Subtype /Image /Filter /DCTDecode >>\nendobj\n%%EOF\n",
      "latin1"
    );
    assert.equal(pdfMetinKatlmaniVarMi(pdf), false);
  });

  test("pdfToMd bozuk PDF hata verir", () => {
    const pdf = Buffer.from(
      "%PDF-1.4\n1 0 obj\n<< /Type /Page /Resources << /XObject << /Im0 2 0 R >> >> >>\nendobj\n%%EOF\n",
      "latin1"
    );
    const son = pdfToMd(pdf);
    assert.equal(son.durum, "hata");
  });
});

test("PDF sıkıştırılmış metni çıkarır; boş sayfayı metinsiz sayar", () => {
  const sonuc = pdfToMd(miniPdf("Compressed text", true));
  assert.equal(sonuc.durum, "ok", sonuc.hata ?? "PDF dönüştürülemedi");
  assert.equal(sonuc.md, "Compressed text");
  assert.equal(pdfToMd(miniPdf("")).durum, "taranmis");
});

test("UDF öznitelik sırası ve eksik paragraf dizini metni kaybettirmez", () => {
  const yap = (elements: string) => zipYaz([{ ad: "content.xml", veri: Buffer.from(
    `<template><content><![CDATA[Merhaba]]></content><elements>${elements}</elements></template>`
  ) }]);
  assert.equal(udfToMd(yap('<content length="7" style="x" startOffset="0"/>')).md, "Merhaba");
  assert.equal(udfToMd(yap("")).md, "Merhaba");
  assert.throws(() => udfToMd(yap('<content length="99" startOffset="0"/>')), /ofset/);
});

// ── P15a: hazırlık taksonomisi ────────────────────────────────────────
// `donustur` bugüne kadar HİÇ doğrudan test edilmemişti (test ağacında adı
// geçmiyordu); taksonomi yalnız e2e üzerinden dolaylı görülüyordu.

describe("donustur taksonomisi", () => {
  const kur = () => {
    const t = tmpKok();
    return {
      ...t,
      yaz(rel: string, veri: Buffer | string) {
        davaYaz(t.kok, rel, veri);
        return rel;
      },
    };
  };

  test("udf → ok + mdPath; html → ok; metin katmanlı pdf → ok", () => {
    const t = kur();
    try {
      const a = t.yaz("_kaynak/evraklar/Gelen/02-Dilekceler/x.udf", makeUdf(["Merhaba dünya"]));
      const sa = donustur(t.kok, a);
      assert.equal(sa.mdStatus, "ok");
      assert.equal(sa.mdPath, "evraklar/Gelen/02-Dilekceler/x.md");
      assert.ok(readFileSync(join(t.kok, sa.mdPath!), "utf8").includes("Merhaba dünya"));

      const b = t.yaz("_kaynak/evraklar/Giden/06-Mali/y.html", makeHtml("<div>Harç</div>"));
      assert.equal(donustur(t.kok, b).mdStatus, "ok");

      const c = t.yaz("_kaynak/evraklar/Gelen/03-Tebligatlar/z.pdf", miniPdf("Tebligat metni"));
      assert.equal(donustur(t.kok, c).mdStatus, "ok");
    } finally {
      t.temizle();
    }
  });

  test("metin katmanı olmayan pdf ve görsel uzantı → gorsel (unsupported DEĞİL)", () => {
    const t = kur();
    try {
      const bos = t.yaz("_kaynak/evraklar/Gelen/03-Tebligatlar/bos.pdf", miniPdf(""));
      const sb = donustur(t.kok, bos);
      assert.equal(sb.mdStatus, "gorsel");
      assert.equal(sb.mdPath, undefined);

      const jpg = t.yaz(
        "_kaynak/evraklar/Gelen/07-Vekalet-Idari/vekalet.jpg",
        Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      );
      assert.equal(donustur(t.kok, jpg).mdStatus, "gorsel");
      const tif = t.yaz("_kaynak/evraklar/Gelen/07-Vekalet-Idari/t.TIF", Buffer.from([0x49, 0x49, 0x2a, 0x00]));
      assert.equal(donustur(t.kok, tif).mdStatus, "gorsel");
    } finally {
      t.temizle();
    }
  });

  test("bilinmeyen uzantı ve ZIP olmayan .udf → desteklenmiyor (sebep korunur)", () => {
    const t = kur();
    try {
      const zip = t.yaz("_kaynak/evraklar/Dosya/08-Ekler-Diger/a.zip", Buffer.from("PKham"));
      assert.equal(donustur(t.kok, zip).mdStatus, "desteklenmiyor");
      const bin = t.yaz("_kaynak/evraklar/Dosya/08-Ekler-Diger/b.bin", Buffer.from([1, 2, 3]));
      const sbin = donustur(t.kok, bin);
      assert.equal(sbin.mdStatus, "desteklenmiyor");
      assert.match(sbin.mdHata ?? "", /bilinmeyen uzantı/);

      const sahte = t.yaz("_kaynak/evraklar/Dosya/08-Ekler-Diger/c.udf", Buffer.from("udf değil"));
      const ss = donustur(t.kok, sahte);
      assert.equal(ss.mdStatus, "desteklenmiyor");
      assert.equal(ss.mdHata, "uzantı udf ama içerik ZIP değil");
    } finally {
      t.temizle();
    }
  });

  test("pdftotext yokken → arac-yok (eskiden bekliyor'a düşüyordu)", () => {
    const t = kur();
    try {
      const pdf = t.yaz("_kaynak/evraklar/Gelen/03-Tebligatlar/a.pdf", miniPdf("Metin"));
      // Enjeksiyon: poppler bu makinede KURULU; kaldırmadan sınamanın tek yolu bu.
      const son = donustur(t.kok, pdf, { aracBul: () => null });
      assert.equal(son.mdStatus, "arac-yok");
      assert.match(son.mdHata ?? "", /pdftotext/);
      // Enjeksiyon belleklemeyi kirletmemeli: varsayılan yol hâlâ çalışıyor.
      assert.equal(donustur(t.kok, pdf).mdStatus, "ok");
    } finally {
      t.temizle();
    }
  });

  test("ham dosya yok / kök dışı yol → hata", () => {
    const t = kur();
    try {
      assert.equal(donustur(t.kok, "_kaynak/evraklar/Gelen/yok.udf").mdStatus, "hata");
      assert.equal(donustur(t.kok, "../../etc/passwd").mdStatus, "hata");
    } finally {
      t.temizle();
    }
  });

  test("pdftotextBul bellekler; bellekle=false yeniden ölçer", () => {
    const ilk = pdftotextBul();
    assert.equal(pdftotextBul(), ilk);
    assert.equal(pdftotextBul(false), ilk);
  });
});

describe("hazirlikCoz / hazirlikOzet", () => {
  test("yazılan değerler olduğu gibi döner", () => {
    for (const d of ["ok", "gorsel", "desteklenmiyor", "arac-yok", "hata", "bekliyor"])
      assert.equal(hazirlikCoz(d, "a/b.pdf"), d);
  });

  test("eski unsupported yalnız uzantıdan türetilir", () => {
    const t = (yol: string) => hazirlikCoz("unsupported", yol);
    assert.equal(t("_kaynak/e/a.jpg"), "gorsel");
    assert.equal(t("_kaynak/e/a.JPEG"), "gorsel");
    assert.equal(t("_kaynak/e/a.tiff"), "gorsel");
    assert.equal(t("_kaynak/e/a.webp"), "gorsel");
    assert.equal(t("_kaynak/e/a.pdf"), "gorsel");
    assert.equal(t("_kaynak/e/a.udf"), "desteklenmiyor");
    assert.equal(t("_kaynak/e/a.zip"), "desteklenmiyor");
    assert.equal(t("_kaynak/e/a.bin"), "desteklenmiyor");
    // Bu dallar unsupported ÜRETEMEZ; türetme dürüst olmaz → bilinmiyor.
    assert.equal(t("_kaynak/e/a.html"), "bilinmiyor");
    assert.equal(t("_kaynak/e/a.htm"), "bilinmiyor");
    assert.equal(t("_kaynak/e/uzantisiz"), "bilinmiyor");
    assert.equal(t("_kaynak/e/.gizli"), "bilinmiyor");
    // Türetme hiçbir koşulda "ok" iddiası kurmaz.
    for (const uz of [".jpg", ".pdf", ".udf", ".zip", ".html", ""])
      assert.notEqual(hazirlikCoz("unsupported", `a/b${uz}`), "ok");
  });

  test("tanınmayan/boş değer bilinmiyor olur, çökmez", () => {
    for (const d of ["zort", "", undefined, null, 42, {}])
      assert.equal(hazirlikCoz(d, "a/b.pdf"), "bilinmiyor");
    assert.equal(hazirlikCoz("ok", undefined), "ok");
  });

  test("özet: kullanılabilir = ok + gorsel, dağılım toplamı = toplam", () => {
    const kayitlar = [
      { mdStatus: "ok", path: "a.udf" },
      { mdStatus: "ok", path: "b.udf" },
      { mdStatus: "gorsel", path: "c.jpg" },
      { mdStatus: "unsupported", path: "d.pdf" }, // türetme → gorsel
      { mdStatus: "unsupported", path: "e.zip" }, // türetme → desteklenmiyor
      { mdStatus: "arac-yok", path: "f.pdf" },
      { mdStatus: "hata", path: "g.udf" },
      { mdStatus: "bekliyor", path: "h.udf" },
      { mdStatus: "zort", path: "i.udf" },
    ];
    const o = hazirlikOzet(kayitlar);
    assert.equal(o.toplam, 9);
    assert.equal(o.kullanilabilir, 4);
    assert.equal(
      Object.values(o.dagilim).reduce((a, b) => a + b, 0),
      o.toplam,
    );
    assert.equal(o.dagilim.gorsel, 2);
    assert.equal(o.dagilim.desteklenmiyor, 1);
    assert.equal(o.dagilim.bilinmiyor, 1);
    const bos = hazirlikOzet([]);
    assert.deepEqual([bos.toplam, bos.kullanilabilir], [0, 0]);
    assert.equal(hazirlikOzet(undefined).toplam, 0);
  });
});

describe("pdftotext yol belleği", () => {
  // Regresyon: olumsuz sonuç süreç ömrü boyunca belleklenirse, UI'nin
  // "poppler kurun, sonra yeniden eşitleyin" talimatı motor yeniden
  // başlatılmadan İŞLEMEZ. Bulunan yol belleklenir (üç spawnSync kazancı),
  // "yok" cevabı her çağrıda yeniden ölçülür.
  test("yok cevabı belleklenmez, bulunan yol belleklenir", () => {
    let cagri = 0;
    const yokAra = () => {
      cagri++;
      return null;
    };
    // Belleği sıfırla: bellekle=false + null → bellek temizlenir.
    pdftotextBul(false, yokAra);
    const tabanCagri = cagri;

    assert.equal(pdftotextBul(true, yokAra), null);
    assert.equal(pdftotextBul(true, yokAra), null);
    assert.equal(
      cagri - tabanCagri,
      2,
      "olumsuz sonuç belleklenmemeli; her çağrı diski yeniden yoklamalı",
    );

    // Araç sonradan kurulduğunda yeniden başlatmaya gerek kalmamalı.
    let kuruldu = 0;
    const varAra = () => {
      kuruldu++;
      return "/opt/homebrew/bin/pdftotext";
    };
    assert.equal(pdftotextBul(true, varAra), "/opt/homebrew/bin/pdftotext");
    assert.equal(kuruldu, 1);

    // Bulunduktan sonra artık yoklanmaz.
    assert.equal(
      pdftotextBul(true, () => {
        throw new Error("bulunan yol yeniden yoklanmamalı");
      }),
      "/opt/homebrew/bin/pdftotext",
    );

    // bellekle=false her zaman taze ölçer.
    let taze = 0;
    pdftotextBul(false, () => {
      taze++;
      return "/usr/bin/pdftotext";
    });
    assert.equal(taze, 1);

    // Test sonrası gerçek durumu geri yükle (diğer testler etkilenmesin).
    pdftotextBul(false);
  });
});
