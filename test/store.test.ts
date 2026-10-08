// Depolama testleri: paths / taxonomy / manifest / registry / containment

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync, rmSync, symlinkSync, chmodSync } from "node:fs";
import { adTemizle, esasKlasorNo, davaKlasorAdi, davaKlasoru, evrakDosyaAdi, gunDami } from "../src/store/paths.js";
import { siniflandir } from "../src/store/taxonomy.js";
import { yazJsonAtomik, kapsamIcindeMi, kapsamKontrol, kaynakDurumu, kaynakOlcer } from "../src/store/fsops.js";
import { ManifestDepo, stableKeyAna, stableKeyEk } from "../src/store/manifest.js";
import { hazirlikCoz } from "../src/store/hazirlik.js";
import { RegistryDepo, caseKeyYap } from "../src/store/registry.js";
import { Hata } from "../src/core/errors.js";
import { geciciKokler } from "./yardimci.js";
import { homedir } from "node:os";
import { varsayilanArsiv } from "../src/store/paths.js";
import { join } from "node:path";

const tmpKok = geciciKokler();

describe("paths", () => {
  test("yeni arşiv ~/Documents/Tensip'e gider, mevcut arşiv sessizce taşınmaz", () => {
    const ev = tmpKok();
    try {
      assert.equal(varsayilanArsiv(ev.kok), join(ev.kok, "Documents", "Tensip"));
      const calismaAlani = join(ev.kok, "AVUKATLIK-ISLERI", "UYAP-Asistan");
      mkdirSync(calismaAlani, { recursive: true });
      assert.equal(varsayilanArsiv(ev.kok), calismaAlani);
      const eski = join(ev.kok, "Documents", "UYAPAsistan");
      mkdirSync(eski, { recursive: true });
      assert.equal(varsayilanArsiv(ev.kok), eski);
    } finally { ev.temizle(); }
  });
  test("adTemizle tehlikeli karakterleri kırpar", () => {
    assert.equal(adTemizle('a/b\\c:d*e?f"g<h>i|j'), "a b c d e f g h i j");
    assert.equal(adTemizle("  çok   boşluk  "), "çok boşluk");
  });

  test("esasKlasorNo", () => {
    assert.equal(esasKlasorNo("2026/928"), "2026-928");
  });

  test("davaKlasorAdi ve tam yol", () => {
    const ad = davaKlasorAdi("Çamlık Asliye Hukuk Mahkemesi", "2026/928");
    assert.equal(ad, "Çamlık Asliye Hukuk Mahkemesi 2026-928");
    const yol = davaKlasoru(
      join(homedir(), "Documents", "UYAPAsistan"),
      "ALPASLAN FATİH SÖZER",
      "Hukuk",
      "ASLİYE HUKUK MAHKEMESİ",
      "Çamlık Asliye Hukuk Mahkemesi",
      "2026/928"
    );
    assert.ok(yol.includes(join("Avukat UYAP", "ALPASLAN FATİH SÖZER", "Hukuk", "ASLİYE HUKUK MAHKEMESİ")));
    assert.ok(yol.endsWith(ad));
  });

  test("evrakDosyaAdi tarih_tür_no sözleşmesine uyar", () => {
    const ad = evrakDosyaAdi("04/09/2026", "Cevap Dilekçesi", "6973", "udf");
    assert.equal(ad, "2026-09-04_Cevap Dilekçesi_6973.udf");
  });

  test("gunDami UYAP biçimini çevirir", () => {
    assert.equal(gunDami("04/09/2026"), "2026-09-04");
    assert.equal(gunDami("2026-09-04"), "2026-09-04");
  });
});

describe("taxonomy", () => {
  test("tip kodu GLN → Gelen", () => {
    assert.deepEqual(
      siniflandir({ tur: "Cevap Dilekçesi", gonderen: "Av. BURAK ŞAKIR", tip: "GLN" }),
      { yon: "Gelen", klasor: "02-Dilekceler" }
    );
  });

  test("vekalet pulu → Giden/06-Mali (GDN, mahkeme çıkarır)", () => {
    assert.deepEqual(
      siniflandir({ tur: "Vekalet Pulu Makbuzu", gonderen: "AVUKAT PORTAL", tip: "GDN" }),
      { yon: "Giden", klasor: "06-Mali" }
    );
  });

  test("tebligat: bilinen yönle Gelen/03", () => {
    const k = siniflandir({ tur: "Kapalı Tebligat", gonderen: "Görevli Memur", tip: "GLN" });
    assert.deepEqual(k, { yon: "Gelen", klasor: "03-Tebligatlar" });
  });

  test("tebligat: yön bilinmiyorsa Dosya/03", () => {
    const k = siniflandir({ tur: "Kapalı Tebligat", gonderen: "" });
    assert.deepEqual(k, { yon: "Dosya", klasor: "03-Tebligatlar" });
  });

  test("kararlar Dosya/01 (mahkeme belgesi)", () => {
    const k = siniflandir({ tur: "Ertelenme Kararı", gonderen: "Sulh Hukuk Mahkemesi" });
    assert.equal(k.yon, "Dosya");
    assert.equal(k.klasor, "01-Kararlar-Tutanaklar");
  });

  test("duruşma zaptı Dosya/09", () => {
    const k = siniflandir({ tur: "Duruşma Çizelgesi", gonderen: "Asliye Ceza Mahkemesi" });
    assert.equal(k.klasor, "09-Durusma-Zabitlari");
    assert.equal(k.yon, "Dosya");
  });

  test("müzekkere mahkemeden çıkarsa Giden/04", () => {
    const k = siniflandir({ tur: "Genel Müzekkere", gonderen: "Test Sulh Hukuk Mahkemesi", tip: "GDN" });
    assert.deepEqual(k, { yon: "Giden", klasor: "04-Muzekkereler-Yazismalar" });
  });

  test("vekaletname Gelen/07", () => {
    const k = siniflandir({ tur: "Vekaletname", gonderen: "Av. X", tip: "GLN" });
    assert.deepEqual(k, { yon: "Gelen", klasor: "07-Vekalet-Idari" });
  });

  test("bilinmeyen → 08-Ekler-Diger", () => {
    const k = siniflandir({ tur: "Tanımsız Evrak XYZ", gonderen: "Bilinmeyen" });
    assert.equal(k.klasor, "08-Ekler-Diger");
  });
});

describe("fsops", () => {
  test("atomik json yazımı ve okunması", () => {
    const { kok } = tmpKok();
    const dosya = join(kok, "alt", "x.json");
    yazJsonAtomik(dosya, { a: 1 });
    const okunan = JSON.parse(readFileSync(dosya, "utf8"));
    assert.deepEqual(okunan, { a: 1 });
  });

  test("containment: kök dışı yazma engellenir", () => {
    const { kok } = tmpKok();
    const icinde = join(kok, "dava", "evrak.md");
    assert.equal(kapsamIcindeMi(kok, icinde), true);
    assert.throws(() => kapsamKontrol(kok, "/etc/passwd"), (e: unknown) => e instanceof Hata);
  });

  // ── P15c: kayıtlı yol bugün diskte ne durumda? ─────────────────────
  // Bu bir DENETİM DEĞİLDİR (P06a): hash bakılmaz, yetim dosya aranmaz.
  // Sınanan tek sözleşme, dört dalın BİRBİRİNE KARIŞMAMASIDIR — özellikle
  // "yok" ile "erisilemiyor" (T03).
  describe("P15c kaynakDurumu", () => {
    const kurulum = () => {
      const { kok } = tmpKok();
      const klon = join(kok, "klon");
      const dis = join(kok, "dis");
      mkdirSync(join(klon, "ic"), { recursive: true });
      mkdirSync(dis, { recursive: true });
      writeFileSync(join(dis, "gizli"), "SECRET");
      writeFileSync(join(klon, "ic", "a.pdf"), "x");
      return { kok, klon, dis };
    };

    test("var / yok: silinmiş dosya 'yok' der, dizin 'var' ama dosya değildir", () => {
      const { klon } = kurulum();
      assert.deepEqual(kaynakDurumu(klon, join(klon, "ic", "a.pdf")), {
        durum: "var",
        tur: "dosya",
      });
      assert.deepEqual(kaynakDurumu(klon, join(klon, "ic")), {
        durum: "var",
        tur: "dizin",
      });
      // Kökün kendisi de ölçülebilir (klasor-ac bunu kullanıyor).
      assert.equal(kaynakDurumu(klon, klon).tur, "dizin");
      rmSync(join(klon, "ic", "a.pdf"));
      assert.deepEqual(kaynakDurumu(klon, join(klon, "ic", "a.pdf")), {
        durum: "yok",
      });
      // Hiç var olmamış derin yol da "yok"tur, "kapsamDisi" değil.
      assert.deepEqual(kaynakDurumu(klon, join(klon, "hic", "yok", "b.pdf")), {
        durum: "yok",
      });
    });

    test("kapsamDisi: mutlak dış yol, dosya symlinki ve ATA DİZİN symlinki", () => {
      const { klon, dis } = kurulum();
      symlinkSync(join(dis, "gizli"), join(klon, "link"));
      symlinkSync(dis, join(klon, "kacis"));
      assert.equal(kaynakDurumu(klon, join(dis, "gizli")).durum, "kapsamDisi");
      assert.equal(kaynakDurumu(klon, join(klon, "link")).durum, "kapsamDisi");
      // Ata dizin symlinki: yaprak sıradan bir dosya gibi görünür, kaçış yalnız
      // dizin çözülünce anlaşılır. Bu dal düşerse symlink kaçışı sessizce "var"
      // olurdu.
      assert.equal(
        kaynakDurumu(klon, join(klon, "kacis", "gizli")).durum,
        "kapsamDisi",
      );
      // Arşiv İÇİNE bakan symlink kaçış değildir.
      symlinkSync(join(klon, "ic", "a.pdf"), join(klon, "iclink"));
      assert.deepEqual(kaynakDurumu(klon, join(klon, "iclink")), {
        durum: "var",
        tur: "dosya",
      });
    });

    test("kırık symlink 'yok' DEĞİL 'erisilemiyor'dur", () => {
      const { kok, klon } = kurulum();
      symlinkSync(join(kok, "boyle-bir-sey-yok"), join(klon, "kirik"));
      const s = kaynakDurumu(klon, join(klon, "kirik"));
      assert.equal(s.durum, "erisilemiyor");
      assert.equal(s.errno, "ENOENT");
    });

    test("izin kapalıyken 'erisilemiyor' der; 'yok' ya da 'kapsamDisi' DEMEZ", (t) => {
      if (process.getuid?.() === 0) return t.skip("root izin denetimini aşar");
      const { klon } = kurulum();
      const dizin = join(klon, "ic");
      chmodSync(dizin, 0o000);
      try {
        const s = kaynakDurumu(klon, join(dizin, "a.pdf"));
        // Bazı dosya sistemleri chmod'u uygulamaz; uygulanmadıysa test anlamsız.
        if (s.durum === "var") return t.skip("dosya sistemi izinleri uygulamıyor");
        assert.equal(s.durum, "erisilemiyor", JSON.stringify(s));
        assert.ok(["EACCES", "EPERM"].includes(s.errno ?? ""), s.errno ?? "(errno yok)");
      } finally {
        chmodSync(dizin, 0o755);
      }
    });

    test("kökün kendisi çözülemezse hiçbir yol için 'yok' uydurulmaz", () => {
      const { kok } = tmpKok();
      const kirikKok = join(kok, "kirik-kok");
      symlinkSync(join(kok, "hic-yok"), kirikKok);
      const s = kaynakDurumu(kirikKok, join(kirikKok, "a.pdf"));
      assert.equal(s.durum, "erisilemiyor");
    });

    test("kaynakOlcer tek yollu çağrıyla AYNI cevabı verir (önbellek yalan söylemez)", () => {
      const { klon, dis } = kurulum();
      symlinkSync(dis, join(klon, "kacis"));
      const yollar = [
        join(klon, "ic", "a.pdf"),
        join(klon, "ic", "yok.pdf"),
        join(klon, "kacis", "gizli"),
        join(dis, "gizli"),
        join(klon, "ic"),
      ];
      const olc = kaynakOlcer(klon);
      for (const y of yollar) assert.deepEqual(olc(y), kaynakDurumu(klon, y), y);
      // Aynı dizinden ikinci satır önbellekten gelir ama sonuç değişmez.
      assert.deepEqual(olc(join(klon, "ic", "a.pdf")), { durum: "var", tur: "dosya" });
    });
  });
});

describe("manifest + registry", () => {
  test("manifest yaz/oku döngüsü", () => {
    const { kok } = tmpKok();
    const depo = new ManifestDepo(join(kok, "uyap-project.json"));
    depo.yaz({
      dosyaId: '"OPAK_TOKEN"',
      mahkeme: "Test Sulh Hukuk Mahkemesi",
      birimId: "1001",
      esasNo: "2026/928",
      isIcra: false,
      clonedAt: new Date().toISOString(),
      evraklar: [
        {
          evrakId: '"EVRAK1"',
          stableKey: "ana:6973",
          path: "_kaynak/evraklar/Gelen/02-Dilekceler/x.udf",
          sha256: "ab",
          isEkEvrak: false,
          category: "02-Dilekceler",
          yon: "Gelen",
          tur: "Cevap Dilekçesi",
          gonderen: "Av. X",
          tarih: "04/09/2026",
          birimEvrakNo: "6973",
          dosyaKey: "2026/928",
          mdStatus: "ok",
        },
      ],
    });
    const m = depo.oku();
    assert.ok(m);
    assert.equal(m.evraklar[0]?.stableKey, "ana:6973");
    assert.equal(m.evraklar[0]?.mdStatus, "ok");
  });

  // P15b: damgalı YENİ kayıt ile damgasız ESKİ kayıt aynı dizide yaşar; okuma
  // ikisini de bozmadan geri verir ve damgasız olana bir şey UYDURMAZ.
  // Toplu göç yasağının okuma tarafındaki kanıtı budur.
  test("P15b damgalı ve damgasız kayıtlar aynı manifestte bozulmadan yaşar", () => {
    const { kok } = tmpKok();
    const yol = join(kok, "uyap-project.json");
    const depo = new ManifestDepo(yol);
    const taban = {
      stableKey: "ana:1", path: "_kaynak/a.pdf", sha256: "ab", isEkEvrak: false,
      category: "02-Dilekceler", yon: "Gelen" as const, tur: "Dilekçe",
      gonderen: "Av. X", tarih: "04/09/2026", dosyaKey: "2026/1",
      mdStatus: "ok" as const,
    };
    const damga = { esitlemeId: "es-7", at: "2026-09-11T09:00:00.000Z", tur: "yenilenen" as const };
    depo.yaz({
      dosyaId: "d", mahkeme: "M", birimId: "1", esasNo: "2026/1", isIcra: false,
      clonedAt: "2026-01-01T00:00:00.000Z",
      sonEsitleme: { esitlemeId: "es-7", at: "2026-09-11T09:00:01.000Z", kaynak: "esitle", ilkIndirme: false, yeni: 0, yenilenen: 1 },
      evraklar: [
        { ...taban, evrakId: "eski" },
        { ...taban, evrakId: "yeni", stableKey: "ana:2", indirmeDamgasi: damga },
      ],
    });
    const m = depo.oku()!;
    assert.equal(m.evraklar[0]!.indirmeDamgasi, undefined);
    assert.deepEqual(m.evraklar[1]!.indirmeDamgasi, damga);
    assert.equal(m.sonEsitleme!.esitlemeId, "es-7");
    assert.equal(m.acikEsitleme, undefined);
    // Okuma yazmaz: dosyanın baytları aynen duruyor.
    const once = readFileSync(yol);
    depo.oku();
    assert.deepEqual(readFileSync(yol), once);
  });


  // P15a: genişleyen mdStatus kümesi diske olduğu gibi iner ve olduğu gibi geri
  // gelir; okuma NORMALİZE ETMEZ. Normalize etseydi orkestratörün bir sonraki
  // manifest yazımı türetilmiş değeri kalıcılaştırır, yani yasak olan toplu göç
  // arka kapıdan girerdi.
  test("manifest yeni mdStatus değerlerini ve eski unsupported'ı bozmadan taşır", () => {
    const { kok } = tmpKok();
    const dosya = join(kok, "uyap-project.json");
    const depo = new ManifestDepo(dosya);
    const durumlar = [
      "ok",
      "gorsel",
      "desteklenmiyor",
      "arac-yok",
      "hata",
      "bekliyor",
      "unsupported",
      "zort",
    ];
    depo.yaz({
      dosyaId: '"OPAK"',
      mahkeme: "Test",
      birimId: "1",
      esasNo: "2026/1",
      isIcra: false,
      clonedAt: new Date().toISOString(),
      evraklar: durumlar.map((d, i) => ({
        evrakId: `"E${i}"`,
        stableKey: `ana:${i}`,
        path: `_kaynak/evraklar/Gelen/02-Dilekceler/${i}.pdf`,
        sha256: "ab",
        isEkEvrak: false,
        category: "02-Dilekceler",
        yon: "Gelen" as const,
        tur: "Dilekçe",
        gonderen: "X",
        tarih: "01/09/2026",
        dosyaKey: "2026/1",
        // "zort" kasten tip dışıdır: eski/bozuk bir kaydın okuma yolunda
        // çökmediğini kanıtlar.
        mdStatus: d as "ok",
      })),
    });
    const okunan = depo.oku()!;
    assert.deepEqual(
      okunan.evraklar.map((e) => e.mdStatus),
      durumlar,
    );
    // Okuma dosyayı değiştirmez.
    const once = readFileSync(dosya);
    depo.oku();
    depo.oku();
    assert.ok(once.equals(readFileSync(dosya)));
    // Türetme yalnız bellekte: .pdf yolunda unsupported → gorsel, "zort" → bilinmiyor.
    assert.equal(hazirlikCoz(okunan.evraklar[6]!.mdStatus, okunan.evraklar[6]!.path), "gorsel");
    assert.equal(hazirlikCoz(okunan.evraklar[7]!.mdStatus, okunan.evraklar[7]!.path), "bilinmiyor");
    assert.deepEqual(
      okunan.evraklar.map((e) => e.mdStatus),
      durumlar,
      "türetme manifest kaydını DEĞİŞTİRMEMELİ",
    );
  });

  test("registry koy/bul", () => {
    const { kok } = tmpKok();
    const depo = new RegistryDepo(join(kok, "davalarim.json"));
    const kayit = {
      caseKey: caseKeyYap("Test Mahkemesi", "2026/928"),
      portal: "avukat" as const,
      kaynak: ["portal"],
      dosyaNo: "2026/928",
      birimAdi: "Test Mahkemesi",
      birimId: "1",
      group: "Hukuk",
      kod: "SULH HUKUK MAHKEMESİ",
      yargiTuru: "0",
      isIcra: false,
      isCbs: false,
      kapsam: "klonla:kapali",
      portalGoruldu: new Date().toISOString(),
    };
    depo.koy(kayit);
    depo.koy({ ...kayit, klonYolu: "/x/y" }); // güncelleme
    assert.equal(depo.oku().davalar.length, 1);
    assert.equal(depo.bul("Test Mahkemesi", "2026/928")?.klonYolu, "/x/y");
  });

  test("stableKey üretimi", () => {
    assert.equal(stableKeyAna("6973", '"TOKEN"'), "ana:6973");
    assert.ok(stableKeyAna(undefined, '"TOKEN12345678901234567890"').startsWith("ana:TOKEN12345678901234567890".slice(0, 24)));
    assert.equal(stableKeyEk("14642293784", 0), "ek:14642293784:0");
  });
});
