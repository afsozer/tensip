import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { hazirlikCoz as hazirlikCozTS } from "../src/store/hazirlik.js";
import {
  yeniMi as yeniMiTS,
  esitlemeSayaci as esitlemeSayaciTS,
} from "../src/store/esitleme.js";

// Kaynak web modülü derleme çıktısına kopyalanmaz; test çalışma dizininden
// yükler (test/portal-ui.test.ts ile aynı kalıp). Bu dosyanın varlık sebebi
// P08c ayrımıdır: web/app.js'ten çıkarılan satır üreticilerinin ürettiği HTML
// burada golden string olarak sabitlenmiştir. Bir satır değişirse bu testler
// kırılır; kırılma kasıtlıysa golden string bilerek güncellenir.
//
// P15a bu golden string'leri BİLEREK güncelledi: etiket sözlüğü değişti
// ("Asıl belge" yedeği kaldırıldı) ve dava satırı hazırlık özeti taşımaya
// başladı. Değişen tam olarak şunlar:
//   unsupported + .tif  "Asıl belge" → "Görsel belge"  (sinif "" → "gorsel")
//   gorsel              "Asıl belge" → "Görsel belge"
//   tanınmayan/eksik    "Asıl belge" → "Bilinmiyor"    (sinif "" → "bilinmiyor")
//   dava satırı         "12 evrak"   → "31 evrak" + "12/31 kullanılabilir"
//                       (özet yoksa "12 evrak (kayıtlı)" — kaynak registry)
//
// P15b golden string'leri KIRMADI ve bilerek kırmadı: "yeni" rozeti EK bir
// rozettir ve yalnız işaretçi (sonEsitleme) verildiğinde çıkar. Mevcut
// çağrılar işaretçi vermediği için ürettikleri HTML bayt bayt aynı kaldı —
// yani P15b'nin geriye uyumu bu dosyada golden'ı değiştirmeyerek kanıtlanıyor.
// Değişen tek şey imza: rozetler(d) → rozetler(d, sonEsitleme) ve
// evrakSatiri(d, secili) → evrakSatiri(d, secili, sonEsitleme); ikisi de
// opsiyonel üçüncü/ikinci argümanla eski davranışa düşer.
//
// SINIR: bu testler saf üreticileri (satır HTML'i, etiket seçimi, kategori adı,
// gruplama, özet) kanıtlar. Olay bağlama, seçim nesli (selectionGeneration) ve
// yarış koşulları KAPSAM DIŞIDIR; bunların tek kanıtı elle UI kontrolüdür.
const {
  categoryName,
  evrakEtiketi,
  davaSayaci,
  davaRozetleri,
  rozetler,
  hazirlikCoz,
  hazirlikRozet,
  ozetMetni,
  evrakOzeti,
  evrakGruplari,
  grupBasligi,
  onizlemeBosluk,
  HAZIRLIK_ETIKET,
  yeniMi,
  esitlemeSayaci,
  yeniRozet,
  davaYeniMetni,
  rozetler: rozetlerJS,
  kaynakRozet,
  kaynakSorunlu,
  kaynakUyarisi,
  kaynakBosluk,
  KAYNAK_ETIKET,
} = await import(new URL("../../web/evrak-durum.js", import.meta.url).href);
const { davaSatiri, evrakSatiri, evrakListesiHTML } = await import(
  new URL("../../web/arsiv.js", import.meta.url).href
);
const {
  taraflariGrupla,
  tarafOzetMetni,
  tarafOzetiHTML,
  tarafDugmesi,
  tarafSorgusuGerekli,
  tarafOturumEngeli,
  TARAF_ENGEL,
} = await import(new URL("../../web/taraf.js", import.meta.url).href);

const KEY = "Denizli 1. İş Mahkemesi\u00002026/918";
const DAVA = {
  secili: {
    caseKey: KEY,
    birimAdi: 'Denizli <b>1.</b> İş & "Asliye"',
    dosyaNo: "2026/918",
    dosyaTur: "Hukuk Dava Dosyası",
    sonEvrakSayisi: 12,
    dosyaDurum: "Açık <Derdest>",
    klonYolu: "/a",
  },
  klonsuz: {
    caseKey: "X\u0000Y",
    birimAdi: "İzmir",
    dosyaNo: "2025/7",
    dosyaTur: "",
    sonEvrakSayisi: undefined,
    dosyaDurum: "",
    klonYolu: "",
  },
  apostrof: {
    caseKey: "A'B",
    birimAdi: "O'Neill 'Mahkeme'",
    dosyaNo: "2024/1",
    dosyaTur: "İcra",
    sonEvrakSayisi: "abc",
    dosyaDurum: undefined,
    klonYolu: "/b",
  },
};
const EVRAK = {
  ok: {
    path: "Gelen/01/a.pdf",
    tur: "Dilekçe",
    tarih: "2026-01-02",
    birimEvrakNo: "5",
    category: "02-Dilekceler",
    mdStatus: "ok",
  },
  unsupported: {
    path: "Gelen/01/b.tif",
    tur: "",
    tarih: "",
    birimEvrakNo: "",
    category: "",
    mdStatus: "unsupported",
  },
  hata: {
    path: "Dosya/09/c.udf",
    tur: "Zabıt <b>",
    tarih: "2026-03-04",
    birimEvrakNo: "9",
    category: "09-Durusma-Zabitlari",
    mdStatus: "hata",
  },
  bekliyor: {
    path: "Dosya/01/d.pdf",
    tur: "Karar",
    tarih: "2026-05-06",
    birimEvrakNo: "",
    category: "99-Bilinmeyen-Kategori",
    mdStatus: "bekliyor",
  },
  gorsel: {
    path: "Dosya/01/e.pdf",
    tur: "Karar",
    tarih: "",
    birimEvrakNo: "",
    category: "01-Kararlar-Tutanaklar",
    mdStatus: "gorsel",
  },
  bos: {
    path: 'Gelen/"q"/f.eml',
    tur: undefined,
    tarih: undefined,
    birimEvrakNo: undefined,
    category: undefined,
    mdStatus: undefined,
  },
};

test("P15a evrak etiketi: her hazırlık durumu ayrı metin ve sınıf alır", () => {
  assert.deepEqual(evrakEtiketi({ mdStatus: "ok", path: "a.udf" }), {
    metin: "Metin hazır",
    sinif: "good",
  });
  assert.deepEqual(evrakEtiketi({ mdStatus: "gorsel", path: "a.jpg" }), {
    metin: "Görsel belge",
    sinif: "gorsel",
  });
  assert.deepEqual(evrakEtiketi({ mdStatus: "desteklenmiyor", path: "a.zip" }), {
    metin: "Desteklenmeyen biçim",
    sinif: "desteklenmiyor",
  });
  assert.deepEqual(evrakEtiketi({ mdStatus: "arac-yok", path: "a.pdf" }), {
    metin: "Dönüştürücü eksik",
    sinif: "arac-yok",
  });
  assert.deepEqual(evrakEtiketi({ mdStatus: "hata", path: "a.udf" }), {
    metin: "Dönüşüm hatası",
    sinif: "bad",
  });
  assert.deepEqual(evrakEtiketi({ mdStatus: "bekliyor", path: "a.udf" }), {
    metin: "Metin bekliyor",
    sinif: "",
  });
  // Eski birleşik değer uzantıdan türetilir; "Asıl belge" yedeği KALDIRILDI.
  assert.equal(evrakEtiketi({ mdStatus: "unsupported", path: "a.jpg" }).metin, "Görsel belge");
  assert.equal(
    evrakEtiketi({ mdStatus: "unsupported", path: "a.zip" }).metin,
    "Desteklenmeyen biçim",
  );
  // Tanınmayan / eksik değer artık "Bilinmiyor"; hiçbir koşulda "Asıl belge" değil.
  for (const d of [{ mdStatus: "zort", path: "a.pdf" }, {}, { mdStatus: null }, undefined]) {
    const r = evrakEtiketi(d);
    assert.equal(r.metin, "Bilinmiyor", JSON.stringify(d));
    assert.equal(r.sinif, "bilinmiyor");
  }
  const tumMetinler = (Object.values(HAZIRLIK_ETIKET) as { metin: string }[]).map(
    (r) => r.metin,
  );
  assert.ok(!tumMetinler.includes("Asıl belge"), "sözlükte 'Asıl belge' kalmamalı");
  assert.equal(new Set(tumMetinler).size, tumMetinler.length, "etiketler birbirinden ayrı olmalı");
  // rozetler() şimdilik yalnız hazırlık etiketini taşır; P15b/P15c buraya ekler.
  assert.deepEqual(rozetler({ mdStatus: "ok", path: "a.udf" }), [
    { metin: "Metin hazır", sinif: "good" },
  ]);
  assert.equal(hazirlikRozet("bulunmayan-deger").metin, "Bilinmiyor");
});

// Türetme mantığı iki dilde YAZILI (TS motor + JS web modülü); web modülleri TS
// import edemiyor. Bu test ikizlerin ayrışmasını yakalar — biri değişip diğeri
// değişmezse aynı evrak sunucuda ve ekranda farklı etiket alır.
test("P15a türetme ikizi: web/evrak-durum.js ile src/store/hazirlik.ts aynı tabloyu üretir", () => {
  const durumlar = [
    "ok",
    "gorsel",
    "desteklenmiyor",
    "arac-yok",
    "hata",
    "bekliyor",
    "unsupported",
    "zort",
    "",
    undefined,
    null,
  ];
  const yollar = [
    "a/b.pdf",
    "a/b.jpg",
    "a/b.JPEG",
    "a/b.tiff",
    "a/b.webp",
    "a/b.udf",
    "a/b.zip",
    "a/b.bin",
    "a/b.html",
    "a/b.htm",
    "a/uzantisiz",
    "a/.gizli",
    "",
    undefined,
  ];
  for (const d of durumlar)
    for (const y of yollar)
      assert.equal(
        hazirlikCoz(d, y),
        hazirlikCozTS(d, y),
        `ikizler ayrıştı: mdStatus=${String(d)} path=${String(y)}`,
      );
});

test("P15a özet metni filtre varken hangi kümeyi saydığını söyler", () => {
  assert.equal(ozetMetni({ toplam: 31, kullanilabilir: 12 }), "12/31 kullanılabilir");
  assert.equal(
    ozetMetni({ toplam: 7, kullanilabilir: 3 }, { suzuldu: true }),
    "3/7 kullanılabilir (görünenler)",
  );
  assert.equal(ozetMetni({ okunamadi: true }), "özet okunamadı");
  assert.equal(ozetMetni(null), "özet okunamadı");
  // Kullanılabilir = ok + gorsel. Taranmış PDF ve görsel evrak başarısızlık değil.
  const o = evrakOzeti([
    { mdStatus: "ok", path: "a.udf" },
    { mdStatus: "gorsel", path: "b.jpg" },
    { mdStatus: "unsupported", path: "c.pdf" },
    { mdStatus: "desteklenmiyor", path: "d.zip" },
    { mdStatus: "zort", path: "e.udf" },
  ]);
  assert.deepEqual(o, { toplam: 5, kullanilabilir: 3 });
  assert.deepEqual(evrakOzeti(undefined), { toplam: 0, kullanilabilir: 0 });
});

test("P15a dava sayacı manifest özetinden gelir; yedeğe düşerse bunu söyler", () => {
  assert.equal(davaSayaci({ sonEvrakSayisi: 12 }, { toplam: 31, kullanilabilir: 12 }), "31 evrak");
  // Bayat registry sayacına düşüş GİZLENMEZ.
  assert.equal(davaSayaci({ sonEvrakSayisi: 12 }), "12 evrak (kayıtlı)");
  assert.equal(davaSayaci({ sonEvrakSayisi: 12 }, { okunamadi: true }), "12 evrak (kayıtlı)");
  assert.equal(davaSayaci({}), "0 evrak (kayıtlı)");
  assert.equal(davaSayaci({ sonEvrakSayisi: "abc" }), "0 evrak (kayıtlı)");
  assert.deepEqual(davaRozetleri({ sonEvrakSayisi: 12 }, { toplam: 31, kullanilabilir: 12 }), [
    { metin: "31 evrak", sinif: "" },
    { metin: "12/31 kullanılabilir", sinif: "" },
  ]);
  assert.deepEqual(davaRozetleri({}, { toplam: 4, kullanilabilir: 4 }), [
    { metin: "4 evrak", sinif: "" },
    { metin: "4/4 kullanılabilir", sinif: "good" },
  ]);
  // Boş dava ikinci rozet almaz (0/0 kullanılabilir anlamsız).
  assert.deepEqual(davaRozetleri({}, { toplam: 0, kullanilabilir: 0 }), [
    { metin: "0 evrak", sinif: "" },
  ]);
});

describe("P15a ek evrak gruplaması", () => {
  const ana = {
    path: "_kaynak/e/vekalet.jpg",
    tur: "Vekaletname",
    stableKey: "ana:6938",
    isEkEvrak: false,
    mdStatus: "gorsel",
  };
  const ek = (i: number) => ({
    path: `_kaynak/e/vekalet_ekler/Ek0${i}.html`,
    tur: `Pul ${i}`,
    stableKey: `ek:6938:${i}`,
    anaStableKey: "ana:6938",
    isEkEvrak: true,
    mdStatus: "ok",
  });
  const duz = {
    path: "_kaynak/e/dilekce.udf",
    tur: "Dilekçe",
    stableKey: "ana:6973",
    isEkEvrak: false,
    mdStatus: "ok",
  };

  test("ana + 2 ek tek gruba iner, üye özeti ana ile ekleri birlikte sayar", () => {
    const g = evrakGruplari([duz, ana, ek(0), ek(1)]);
    assert.equal(g.length, 2);
    assert.equal(g[0].ana, duz);
    assert.equal(g[0].ekler.length, 0);
    assert.equal(g[1].ana, ana);
    assert.equal(g[1].ekler.length, 2);
    // ana gorsel + 2 ek ok = 3/3 kullanılabilir
    assert.equal(grupBasligi(g[1]), "2 ek · 3/3 kullanılabilir");
  });

  test("öksüz ek DÜŞMEZ, ayrı başlık alır; isEkEvrak=false hiçbir gruba girmez", () => {
    // Ana kaydı listede yok: ya portal listesinde hiç yoktu, ya indirmesi
    // başarısız oldu, ya da filtre yalnız eki eşledi. Üçü de hata değil.
    const g = evrakGruplari([ek(0), ek(1), duz]);
    assert.equal(g.length, 2);
    const oksuz = g.find((x: { oksuz: boolean }) => x.oksuz)!;
    assert.equal(oksuz.ana, null);
    assert.equal(oksuz.ekler.length, 2);
    assert.match(grupBasligi(oksuz), /^Eki bulunan ana evrak bu listede yok · 2 ek · 2\/2/);
    assert.ok(g.some((x: { ana: unknown }) => x.ana === duz));
    // Hiçbir kayıt kaybolmamalı.
    const tumu = g.flatMap((x: { ana: unknown; ekler: unknown[] }) =>
      x.ana ? [x.ana, ...x.ekler] : x.ekler,
    );
    assert.equal(tumu.length, 3);
  });

  test("anaStableKey'i başka kayda uymayan ek de öksüz gruba girer", () => {
    const yabanci = { ...ek(0), anaStableKey: "ana:hicbiri" };
    const g = evrakGruplari([ana, yabanci]);
    assert.equal(g.length, 2);
    assert.equal(g[0].ekler.length, 0);
    assert.equal(g[1].oksuz, true);
  });

  test("boş/bozuk girdi çökertmez", () => {
    assert.deepEqual(evrakGruplari(undefined), []);
    assert.deepEqual(evrakGruplari([]), []);
    assert.equal(evrakGruplari([null, undefined]).length, 2);
  });

  test("2.000 kayıtlık listede gruplama tek geçişte biter", () => {
    const buyuk = [];
    for (let i = 0; i < 1000; i++) {
      buyuk.push({ ...ana, stableKey: `ana:${i}`, path: `a${i}.jpg` });
      buyuk.push({ ...ek(0), anaStableKey: `ana:${i}`, path: `a${i}_ekler/Ek00.html` });
    }
    const t0 = performance.now();
    const g = evrakGruplari(buyuk);
    const sure = performance.now() - t0;
    assert.equal(g.length, 1000);
    assert.ok(sure < 200, `gruplama çok yavaş: ${sure.toFixed(1)} ms`);
  });

  test("grup HTML'i data-document düğmelerini korur (olay bağlama değişmez)", () => {
    const html = evrakListesiHTML([ana, ek(0)], null);
    assert.equal(
      html,
      '<div class="doc-group"><button class="list-item " data-document="_kaynak/e/vekalet.jpg" aria-pressed="false"><strong>Vekaletname</strong><small>Tarih belirtilmemiş</small><span class="tag gorsel">Görsel belge</span></button><p class="doc-group-head">1 ek · 2/2 kullanılabilir</p><div class="doc-group-members"><button class="list-item " data-document="_kaynak/e/vekalet_ekler/Ek00.html" aria-pressed="false"><strong>Pul 0</strong><small>Tarih belirtilmemiş</small><span class="tag good">Metin hazır</span></button></div></div>',
    );
    // Eksiz kayıt sarmalayıcı almaz: bugünkü düz satır aynen kalır.
    assert.equal(evrakListesiHTML([duz], null), evrakSatiri(duz, null));
  });
});

test("P15a önizleme boşluğu sebebi söyler, tek tip cümleye düşmez", () => {
  const metinler = new Set<string>();
  for (const h of ["gorsel", "desteklenmiyor", "arac-yok", "hata", "bekliyor", "bilinmiyor"]) {
    const [baslik, aciklama] = onizlemeBosluk(h);
    assert.ok(baslik.length > 0 && aciklama.length > 0, h);
    metinler.add(baslik);
  }
  assert.equal(metinler.size, 6, "her durum ayrı başlık almalı");
  assert.match(onizlemeBosluk("arac-yok")[1], /pdftotext/);
  assert.equal(onizlemeBosluk(undefined)[0], "Metin önizlemesi bulunmuyor");
});

test("P08c kategori adı ayrım öncesiyle aynı", () => {
  assert.equal(categoryName("02-Dilekceler"), "Dilekçeler");
  assert.equal(categoryName("09-Durusma-Zabitlari"), "Duruşma zabıtları");
  assert.equal(categoryName("99-Bilinmeyen-Kategori"), "Bilinmeyen Kategori");
  assert.equal(categoryName(undefined), "");
});

test("P15a dava satırı HTML'i: özet varsa iki rozet, yoksa kayıtlı sayaç", () => {
  assert.equal(
    davaSatiri(DAVA.secili, KEY, new Set([KEY]), { toplam: 31, kullanilabilir: 12 }),
    '<div class="archive-choice"><label class="archive-check"><input type="checkbox" data-select-case="Denizli%201.%20%C4%B0%C5%9F%20Mahkemesi%002026%2F918" aria-label="Denizli &lt;b&gt;1.&lt;/b&gt; İş &amp; &quot;Asliye&quot; 2026/918 toplu eşitleme için seç" checked ></label><button class="list-item active" data-case="Denizli%201.%20%C4%B0%C5%9F%20Mahkemesi%002026%2F918" aria-pressed="true"><strong>Denizli &lt;b&gt;1.&lt;/b&gt; İş &amp; &quot;Asliye&quot;</strong><small>2026/918 · Hukuk Dava Dosyası</small><span class="tag ">31 evrak</span> <span class="tag ">12/31 kullanılabilir</span> <span class="tag">Açık &lt;Derdest&gt;</span></button></div>',
  );
  assert.equal(
    davaSatiri(DAVA.secili, KEY, new Set([KEY])),
    '<div class="archive-choice"><label class="archive-check"><input type="checkbox" data-select-case="Denizli%201.%20%C4%B0%C5%9F%20Mahkemesi%002026%2F918" aria-label="Denizli &lt;b&gt;1.&lt;/b&gt; İş &amp; &quot;Asliye&quot; 2026/918 toplu eşitleme için seç" checked ></label><button class="list-item active" data-case="Denizli%201.%20%C4%B0%C5%9F%20Mahkemesi%002026%2F918" aria-pressed="true"><strong>Denizli &lt;b&gt;1.&lt;/b&gt; İş &amp; &quot;Asliye&quot;</strong><small>2026/918 · Hukuk Dava Dosyası</small><span class="tag ">12 evrak (kayıtlı)</span> <span class="tag">Açık &lt;Derdest&gt;</span></button></div>',
  );
  assert.equal(
    davaSatiri(DAVA.klonsuz, null, new Set()),
    '<div class="archive-choice"><label class="archive-check"><input type="checkbox" data-select-case="X%00Y" aria-label="İzmir 2025/7 toplu eşitleme için seç"  disabled></label><button class="list-item " data-case="X%00Y" aria-pressed="false"><strong>İzmir</strong><small>2025/7 · Dosya</small><span class="tag ">0 evrak (kayıtlı)</span></button></div>',
  );
  assert.equal(
    davaSatiri(DAVA.apostrof, "A'B", new Set()),
    '<div class="archive-choice"><label class="archive-check"><input type="checkbox" data-select-case="A\'B" aria-label="O&#39;Neill &#39;Mahkeme&#39; 2024/1 toplu eşitleme için seç"  ></label><button class="list-item active" data-case="A\'B" aria-pressed="true"><strong>O&#39;Neill &#39;Mahkeme&#39;</strong><small>2024/1 · İcra</small><span class="tag ">0 evrak (kayıtlı)</span></button></div>',
  );
});

test("P15a evrak satırı HTML'i yeni etiket sözlüğünü taşır", () => {
  assert.equal(
    evrakSatiri(EVRAK.ok, "Gelen/01/a.pdf"),
    '<button class="list-item active" data-document="Gelen/01/a.pdf" aria-pressed="true"><strong>Dilekçe</strong><small>2026-01-02 · Evrak 5 · Dilekçeler</small><span class="tag good">Metin hazır</span></button>',
  );
  assert.equal(
    evrakSatiri(EVRAK.unsupported, null),
    '<button class="list-item " data-document="Gelen/01/b.tif" aria-pressed="false"><strong>b.tif</strong><small>Tarih belirtilmemiş</small><span class="tag gorsel">Görsel belge</span></button>',
  );
  assert.equal(
    evrakSatiri(EVRAK.hata, null),
    '<button class="list-item " data-document="Dosya/09/c.udf" aria-pressed="false"><strong>Zabıt &lt;b&gt;</strong><small>2026-03-04 · Evrak 9 · Duruşma zabıtları</small><span class="tag bad">Dönüşüm hatası</span></button>',
  );
  assert.equal(
    evrakSatiri(EVRAK.bekliyor, null),
    '<button class="list-item " data-document="Dosya/01/d.pdf" aria-pressed="false"><strong>Karar</strong><small>2026-05-06 · Bilinmeyen Kategori</small><span class="tag ">Metin bekliyor</span></button>',
  );
  assert.equal(
    evrakSatiri(EVRAK.gorsel, null),
    '<button class="list-item " data-document="Dosya/01/e.pdf" aria-pressed="false"><strong>Karar</strong><small>Tarih belirtilmemiş · Kararlar ve tutanaklar</small><span class="tag gorsel">Görsel belge</span></button>',
  );
  assert.equal(
    evrakSatiri(EVRAK.bos, null),
    '<button class="list-item " data-document="Gelen/&quot;q&quot;/f.eml" aria-pressed="false"><strong>f.eml</strong><small>Tarih belirtilmemiş</small><span class="tag bilinmiyor">Bilinmiyor</span></button>',
  );
});

test("P08c satır şablonları HTML kaçırır ve caseKey NUL ayırıcısını korur", () => {
  const kotu = {
    caseKey: "a<b>\u0000c",
    birimAdi: '<script>alert("x")</script>',
    dosyaNo: "2026/1<img src=x onerror=1>",
    dosyaTur: "Tür & 'tek'",
    sonEvrakSayisi: 3,
    dosyaDurum: "<b>Açık</b>",
    klonYolu: "/k",
  };
  const satir = davaSatiri(kotu, null, new Set());
  assert.ok(!satir.includes("<script>"), "script etiketi kaçırılmalı");
  assert.ok(!satir.includes("<img"), "img etiketi kaçırılmalı");
  assert.ok(satir.includes("&lt;script&gt;"));
  assert.ok(satir.includes("&quot;x&quot;"));
  assert.ok(satir.includes("&#39;tek&#39;"));
  // NUL ayırıcı data-case içinde %00 olarak kodlanır ve geri çözülebilir.
  assert.ok(satir.includes('data-case="a%3Cb%3E%00c"'), satir);
  assert.equal(decodeURIComponent("a%3Cb%3E%00c"), kotu.caseKey);
  assert.ok(!satir.includes("\u0000"), "ham NUL HTML'e sızmamalı");

  const evrak = evrakSatiri(
    {
      path: 'x"/<y>.pdf',
      tur: "<b>Dilekçe</b>",
      tarih: "<i>2026</i>",
      birimEvrakNo: '"5"',
      category: "02-Dilekceler",
      mdStatus: "ok",
    },
    null,
  );
  assert.ok(!evrak.includes("<b>Dilekçe</b>"));
  assert.ok(evrak.includes("&lt;b&gt;Dilekçe&lt;/b&gt;"));
  assert.ok(evrak.includes('data-document="x&quot;/&lt;y&gt;.pdf"'), evrak);

  // Grup başlığı da kaçırılır: ekler sarmalayıcının içinde de HTML sızdırmaz.
  const grupHtml = evrakListesiHTML(
    [
      { path: "a.jpg", tur: "<b>Ana</b>", stableKey: "ana:1", isEkEvrak: false, mdStatus: "gorsel" },
      {
        path: "a_ekler/Ek00.html",
        tur: "<i>Ek</i>",
        stableKey: "ek:1:0",
        anaStableKey: "ana:1",
        isEkEvrak: true,
        mdStatus: "ok",
      },
    ],
    null,
  );
  assert.ok(!grupHtml.includes("<b>Ana</b>"));
  assert.ok(!grupHtml.includes("<i>Ek</i>"));
});

describe("P08c modül grafiği", () => {
  // web-api testi modülleri HTTP üzerinden çekiyor ama ayrıştırmıyor: bir
  // sözdizimi hatası veya modül gövdesinde DOM erişimi orada yakalanmaz.
  // Burada gerçekten import edilir.
  test("DOM'suz modüller node'dan yüklenir; app.js bilerek yüklenmez", async () => {
    for (const ad of ["ortak.js", "evrak-durum.js", "arsiv.js", "isler.js", "ajanda.js", "toplu.js", "portal.js", "taraf.js"]) {
      const m = await import(new URL(`../../web/${ad}`, import.meta.url).href);
      assert.ok(m, `${ad} yüklenemedi`);
    }
    // app.js giriş noktasıdır ve modül gövdesinde DOM'a dokunur; node'da
    // yüklenememesi BEKLENEN davranıştır. Yüklenebiliyorsa DOM erişimi
    // kaybolmuş demektir.
    await assert.rejects(
      import(new URL("../../web/app.js", import.meta.url).href),
      /document is not defined|is not defined/,
    );
  });

  test("kanca sözleşmesi: app.js poll'u bağlar, arsiv.js eylem kancası ekler", async () => {
    // kanca.poll varsayılanı sessiz no-op; atama düşerse hata çıkmaz, liste
    // sessizce tazelenmez ve testler yeşil kalır. Bu iki iddia o seam'i sabitler.
    const kaynak = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../../web/app.js", import.meta.url), "utf8"),
    );
    assert.match(kaynak, /kanca\.poll\s*=\s*poll/, "app.js kanca.poll atamasını düşürmüş");

    const { kanca } = await import(new URL("../../web/ortak.js", import.meta.url).href);
    const oncekiAdet = kanca.eylemSonrasi.length;
    await import(new URL("../../web/arsiv.js", import.meta.url).href);
    assert.ok(
      kanca.eylemSonrasi.length >= oncekiAdet,
      "arsiv.js eylem kancasını kaydetmiyor",
    );
    // kanca yalnız bu iki alanı taşımalı (ROADMAP §6: olay yoluna dönüşmesin).
    assert.deepEqual(Object.keys(kanca).sort(), ["eylemSonrasi", "poll"]);
  });
});

// ── P15b "yeni" rozeti ───────────────────────────────────────────────────────
describe("P15b yeni rozeti", () => {
  const ISARET = { esitlemeId: "es-42", at: "2026-09-11T10:00:00.000Z", kaynak: "esitle", ilkIndirme: false, yeni: 1, yenilenen: 0 };
  const damgali = (esitlemeId: string, tur = "yeni") => ({
    path: "_kaynak/a.pdf", tur: "Dilekçe", mdStatus: "ok",
    indirmeDamgasi: { esitlemeId, at: "2026-09-11T10:00:00.000Z", tur },
  });

  test("rozet KİMLİK eşitliğiyle verilir; zaman damgası kararı değiştirmez", () => {
    assert.equal(yeniMi(damgali("es-42"), ISARET), "yeni");
    assert.equal(yeniMi(damgali("es-41"), ISARET), null);
    // Damga tarihi işaretçinin tarihinden SONRA bile olsa, kimlik tutmuyorsa rozet yok.
    const gelecek = { ...damgali("es-41"), indirmeDamgasi: { esitlemeId: "es-41", at: "2099-01-01T00:00:00.000Z", tur: "yeni" } };
    assert.equal(yeniMi(gelecek, ISARET), null);
    // Aynı saniyeye düşen iki eşitleme: kimlik ayırır, tarih ayıramazdı.
    assert.equal(yeniMi(damgali("es-42"), { ...ISARET, at: "2026-09-11T10:00:00.000Z" }), "yeni");
  });

  test("ilk indirmede hiçbir evrak rozetlenmez ve dava satırında sayaç çıkmaz", () => {
    const ilk = { ...ISARET, ilkIndirme: true, kaynak: "klonla" };
    assert.equal(yeniMi(damgali("es-42"), ilk), null);
    assert.deepEqual(esitlemeSayaci([damgali("es-42"), damgali("es-42")], ilk), { yeni: 0, yenilenen: 0 });
    assert.equal(davaYeniMetni({ yeni: 0, yenilenen: 0 }), null);
  });

  test("tanımsız/bozuk işaretçi ve damgada çökmez, rozet uydurmaz", () => {
    for (const isaret of [undefined, null, {}, 42, { esitlemeId: "" }, { esitlemeId: 7 }]) {
      assert.equal(yeniMi(damgali("es-42"), isaret as never), null);
    }
    for (const evrak of [undefined, null, {}, { indirmeDamgasi: null }, { indirmeDamgasi: "hmm" }]) {
      assert.equal(yeniMi(evrak as never, ISARET), null);
    }
    assert.deepEqual(esitlemeSayaci(undefined as never, ISARET), { yeni: 0, yenilenen: 0 });
    assert.deepEqual(esitlemeSayaci("hayır" as never, ISARET), { yeni: 0, yenilenen: 0 });
  });

  test('"yeni" ve "yenilenen" ayrı etiket, ayrı sayaç', () => {
    assert.equal(yeniRozet(damgali("es-42", "yeni"), ISARET).metin, "Yeni");
    assert.equal(yeniRozet(damgali("es-42", "yenilenen"), ISARET).metin, "Güncellendi");
    assert.equal(yeniRozet(damgali("es-41"), ISARET), null);
    // Tanınmayan tür "yeni"ye düşer — rozet gösterilmemesinden iyidir, uydurmaz.
    assert.equal(yeniRozet(damgali("es-42", "zort"), ISARET).metin, "Yeni");
    assert.deepEqual(
      esitlemeSayaci([damgali("es-42"), damgali("es-42", "yenilenen"), damgali("es-1")], ISARET),
      { yeni: 1, yenilenen: 1 },
    );
  });

  test('dava satırı metni tekil/çoğul ve sıfır durumlarını doğru söyler', () => {
    assert.equal(davaYeniMetni({ yeni: 3, yenilenen: 0 }), "3 yeni");
    assert.equal(davaYeniMetni({ yeni: 0, yenilenen: 2 }), "2 güncellendi");
    assert.equal(davaYeniMetni({ yeni: 3, yenilenen: 1 }), "3 yeni · 1 güncellendi");
    assert.equal(davaYeniMetni({ yeni: 0, yenilenen: 0 }), null);
    assert.equal(davaYeniMetni(undefined), null);
    assert.equal(davaYeniMetni({ yeni: "x", yenilenen: null }), null);
  });

  test("rozetler() sırası: Yeni önce, hazırlık etiketi sonra; işaretçisiz çağrı eski diziyi verir", () => {
    assert.deepEqual(rozetlerJS(damgali("es-42"), ISARET).map((r: any) => r.metin), ["Yeni", "Metin hazır"]);
    assert.deepEqual(rozetlerJS(damgali("es-42")).map((r: any) => r.metin), ["Metin hazır"]);
    assert.deepEqual(rozetlerJS(damgali("es-1"), ISARET).map((r: any) => r.metin), ["Metin hazır"]);
  });

  test("evrakSatiri rozeti basar ve metni kaçırır; dava satırı sayacı ekler", () => {
    const satir = evrakSatiri(damgali("es-42"), null, ISARET);
    assert.match(satir, /<span class="tag yeni">Yeni<\/span>/);
    assert.ok(satir.indexOf('class="tag yeni"') < satir.indexOf('class="tag good"'), "Yeni rozeti önce gelmeli");
    assert.equal(evrakSatiri(damgali("es-42"), null), evrakSatiri(damgali("es-42"), null, null));

    const c = { caseKey: "k", birimAdi: "M", dosyaNo: "2026/1", klonYolu: "/y" };
    const ozet = { toplam: 3, kullanilabilir: 3, yeni: 2, yenilenen: 1 };
    const dava = davaSatiri(c, null, new Set(), ozet);
    assert.match(dava, /<span class="tag yeni">2 yeni · 1 güncellendi<\/span>/);
    assert.ok(!davaSatiri(c, null, new Set(), { toplam: 3, kullanilabilir: 3, yeni: 0, yenilenen: 0 }).includes("tag yeni"));
    // Özet okunamazsa sayaç UYDURULMAZ.
    assert.ok(!davaSatiri(c, null, new Set(), { okunamadi: true }).includes("tag yeni"));
  });

  test("P15b türetme ikizi: web/evrak-durum.js ile src/store/esitleme.ts aynı tabloyu üretir", () => {
    const isaretler = [
      undefined, null, {}, { esitlemeId: "es-42", ilkIndirme: false },
      { esitlemeId: "es-42", ilkIndirme: true }, { esitlemeId: "", ilkIndirme: false },
      { esitlemeId: "es-9", ilkIndirme: false },
    ];
    const evraklar = [
      undefined, null, {}, { indirmeDamgasi: null },
      damgali("es-42"), damgali("es-42", "yenilenen"), damgali("es-42", "zort"), damgali("es-9"),
    ];
    for (const i of isaretler) {
      for (const e of evraklar) {
        assert.equal(yeniMi(e, i), yeniMiTS(e as never, i as never), `yeniMi ayrıştı: ${JSON.stringify([e, i])}`);
      }
      assert.deepEqual(esitlemeSayaci(evraklar, i), esitlemeSayaciTS(evraklar as never, i as never));
    }
  });
});


describe("P15c eksik kaynak rozeti", () => {
  // SINIR: bu rozet bir DENETİM SONUCU DEĞİLDİR (P06a). Tek girdisi sunucunun
  // `evraklar` yanıtında yolladığı `kaynakDurum` dizesidir; burada sınanan şey
  // o dizenin doğru metne, doğru sınıfa ve doğru EYLEM kısıtına çevrilmesi.
  const evrak = (kaynakDurum?: string) => ({
    path: "Gelen/01/a.pdf",
    tur: "Dilekçe",
    tarih: "2026-01-02",
    mdStatus: "ok",
    ...(kaynakDurum === undefined ? {} : { kaynakDurum }),
  });

  test('"yok" ile "erisilemiyor" AYRI metinlerdir; hiçbiri diğerinin yerine geçmez', () => {
    assert.deepEqual(kaynakRozet(evrak("yok")), { metin: "Eksik", sinif: "eksik" });
    assert.deepEqual(kaynakRozet(evrak("erisilemiyor")), {
      metin: "Erişilemedi",
      sinif: "erisilemedi",
    });
    assert.deepEqual(kaynakRozet(evrak("kapsamDisi")), {
      metin: "Arşiv dışı",
      sinif: "erisilemedi",
    });
    // "Erişemedim" asla "Eksik" demez (T03).
    assert.notEqual(
      KAYNAK_ETIKET.erisilemiyor.metin,
      KAYNAK_ETIKET.yok.metin,
    );
    assert.ok(!KAYNAK_ETIKET.erisilemiyor.metin.toLocaleLowerCase("tr").includes("eksik"));
    assert.ok(!KAYNAK_ETIKET.kapsamDisi.metin.toLocaleLowerCase("tr").includes("eksik"));
  });

  test("SESSİZ VARSAYILAN: ölçülmemiş/tanınmayan değerde rozet çıkmaz, satır kısıtlanmaz", () => {
    // "Eksik" demek, dememekten çok daha pahalı bir hatadır: kullanıcı var olan
    // belgeyi kaybolmuş sanar. Bu yüzden bilinmeyen her şey SESSİZDİR.
    for (const deger of [undefined, "var", "bilinmiyor", "zort", "", null, 42]) {
      const d = { ...evrak(), kaynakDurum: deger };
      assert.equal(kaynakRozet(d as never), null, JSON.stringify(deger));
      assert.equal(kaynakSorunlu(d as never), false, JSON.stringify(deger));
    }
    assert.equal(kaynakRozet(undefined as never), null);
    assert.equal(kaynakSorunlu(undefined as never), false);
    assert.equal(kaynakSorunlu(evrak("yok")), true);
    assert.equal(kaynakSorunlu(evrak("erisilemiyor")), true);
  });

  test("rozet sırası: Eksik → Yeni → hazırlık; eyleme dokunan rozet en önde", () => {
    const ISARET = { esitlemeId: "es-7", ilkIndirme: false };
    const damgali = {
      ...evrak("yok"),
      indirmeDamgasi: { esitlemeId: "es-7", at: "2026-09-11T10:00:00.000Z", tur: "yeni" },
    };
    assert.deepEqual(
      rozetlerJS(damgali, ISARET).map((r: any) => r.metin),
      ["Eksik", "Yeni", "Metin hazır"],
    );
    // Kaynak sorunsuzken P15b'nin sırası aynen korunur.
    assert.deepEqual(
      rozetlerJS({ ...damgali, kaynakDurum: "var" }, ISARET).map((r: any) => r.metin),
      ["Yeni", "Metin hazır"],
    );
    assert.deepEqual(rozetlerJS(evrak("erisilemiyor")).map((r: any) => r.metin), [
      "Erişilemedi",
      "Metin hazır",
    ]);
  });

  test("satır soluklaşır ve HTML kaçışı bozulmaz; ölçümsüz satır BAYT BAYT eskisi gibi", () => {
    const satir = evrakSatiri(evrak("yok"), null);
    assert.match(satir, /class="list-item soluk"/);
    assert.match(satir, /<span class="tag eksik">Eksik<\/span>/);
    assert.ok(
      satir.indexOf('class="tag eksik"') < satir.indexOf('class="tag good"'),
      "Eksik rozeti hazırlık etiketinden önce gelmeli",
    );
    assert.match(evrakSatiri(evrak("yok"), "Gelen/01/a.pdf"), /class="list-item active soluk"/);
    // GERİYE UYUM: alan taşımayan satır (eski motor yanıtı) değişmedi.
    assert.equal(evrakSatiri(evrak(), null), evrakSatiri(evrak("var"), null));
    assert.ok(!evrakSatiri(evrak(), null).includes("soluk"));
    // Kaçırma: rozet metni sabit, ama satırın kendisi hâlâ kaçırıyor.
    const kotu = { ...evrak("yok"), tur: '<img src=x onerror="alert(1)">' };
    assert.ok(!evrakSatiri(kotu, null).includes("<img"));
    assert.match(evrakSatiri(kotu, null), /&lt;img/);
  });

  test("önizleme metni kalır ama nereden geldiğini söyler; metin de yoksa sebep kaynaktır", () => {
    // KARAR (Eksik 3): kaynak yok + türetilmiş metin var → önizleme AÇIK.
    assert.match(kaynakUyarisi("yok"), /daha önce üretilmiş kopya/);
    assert.match(kaynakUyarisi("yok"), /yeniden indirir/);
    assert.match(kaynakUyarisi("erisilemiyor"), /erişilemedi/);
    assert.ok(!kaynakUyarisi("erisilemiyor").includes("yok;"));
    assert.equal(kaynakUyarisi("var"), null);
    assert.equal(kaynakUyarisi(undefined), null);
    assert.equal(kaynakUyarisi("zort"), null);

    // Metin de yoksa boş önizleme sebebi KAYNAKTIR: "dönüşüm bekliyor" demek
    // dosyası hiç yerinde olmayan evrakta yanlış beklenti kurar.
    const [baslik, aciklama] = kaynakBosluk("yok");
    assert.match(baslik, /arşivde yok/);
    assert.match(aciklama, /yeniden indirir/);
    assert.match(kaynakBosluk("erisilemiyor")[0], /erişilemedi/);
    assert.match(kaynakBosluk("erisilemiyor")[1], /silindiği anlamına gelmez/);
    assert.equal(kaynakBosluk("var"), null);
    assert.equal(kaynakBosluk(undefined), null);
    // Kaynak sağlamken eski sözlük devrede kalır.
    assert.deepEqual(onizlemeBosluk("bekliyor"), [
      "Metin henüz hazırlanmadı",
      "Dönüşüm bir sonraki eşitlemede çalışacak.",
    ]);
  });
});

// ── P15c düzeltmesi: tazelemede rozet ile eylem ayrışmaz ─────────────────────
//
// Yukarıdaki testler SAF üreticileri kanıtlar. Burası farklı: gerçek
// `refreshDocuments()` akışını çalıştırır (fetch + DOM saplaması ile), çünkü
// kırık olan tam da akışın kendisiydi — satır rozeti `evraklar` yanıtındaki
// TAZE ölçümden, "Asıl belgeyi aç" düğmesi ise yalnız seçim anında alınmış
// BAYAT `evrak-oku` ölçümünden besleniyordu ve tazeleme düğmeye hiç dokunmuyordu.
//
// SAPLAMANIN SINIRI: HTML ayrıştırılmaz; bir kapsayıcıya innerHTML yazıldığında
// içindeki `id="…"` kayıtları yeniden yaratılır (eskiler silinir). Bu, gerçek
// tarayıcıdaki "yeniden çizim düğmeyi sıfırdan yaratır" davranışını taklit eder
// ve testin "düğme açıldı mı" iddiasını anlamlı kılar. Olay bağlama ve CSS
// KAPSAM DIŞIDIR; onların kanıtı elle UI kontrolüdür.
const ortak = await import(new URL("../../web/ortak.js", import.meta.url).href);
const { refreshDocuments } = await import(
  new URL("../../web/arsiv.js", import.meta.url).href
);
describe("P15c tazelemede eylem durumu", () => {
  const state = ortak.state as Record<string, unknown>;
  const YOL = "_kaynak/evraklar/rapor.pdf";
  const satir = (kaynakDurum?: string) => ({
    path: YOL,
    tur: "Bilirkişi Raporu",
    tarih: "01/09/2026",
    category: "08-Ekler-Diger",
    mdStatus: "ok",
    ...(kaynakDurum === undefined ? {} : { kaynakDurum }),
  });

  // --- DOM saplaması -------------------------------------------------------
  const ogeler = new Map<string, Record<string, unknown>>();
  const katkilar = new Map<string, Set<string>>();
  const yeniOge = (id: string): Record<string, unknown> => {
    const oge: Record<string, unknown> = {
      id,
      textContent: "",
      disabled: false,
      title: "",
      hidden: false,
      checked: false,
      indeterminate: false,
      content: "csrf-test",
      dataset: {},
      classList: { toggle: () => {} },
      cocuklar: [] as unknown[],
      querySelectorAll: () => [] as unknown[],
      replaceChildren: (...n: unknown[]) => {
        oge["cocuklar"] = n;
      },
      addEventListener: () => {},
      closest: () => null,
    };
    let html = "";
    Object.defineProperty(oge, "innerHTML", {
      get: () => html,
      set: (v: string) => {
        html = String(v);
        for (const eski of katkilar.get(id) ?? []) ogeler.delete(eski);
        const yeni = new Set(
          [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]!),
        );
        for (const yeniId of yeni) ogeler.set(yeniId, yeniOge(yeniId));
        katkilar.set(id, yeni);
      },
    });
    return oge;
  };
  const bul = (id: string) => ogeler.get(id) ?? null;

  const kur = (onizlemeKaynak?: string, listeKaynak?: string) => {
    ogeler.clear();
    katkilar.clear();
    for (const id of [
      "document-list",
      "document-count",
      "sync-case",
      "open-folder",
      "preview",
    ])
      ogeler.set(id, yeniOge(id));
    state["page"] = "indirilenler";
    state["selectedCase"] = "CK";
    state["documentFilter"] = "";
    state["view"] = "evrak";
    state["previewLoading"] = false;
    state["previewError"] = null;
    state["sonEsitleme"] = null;
    state["cases"] = [{ caseKey: "CK", birimAdi: "Test", dosyaNo: "2026/99", klonYolu: "/a" }];
    state["documents"] = [satir(listeKaynak)];
    state["selectedDocument"] = YOL;
    state["preview"] = {
      ad: "rapor.pdf",
      metin: "hazır metin",
      mdStatus: "ok",
      hazirlik: "ok",
      ...(onizlemeKaynak === undefined ? {} : { kaynakDurum: onizlemeKaynak }),
    };
  };
  const tazele = async (yanit: unknown) => {
    (globalThis as Record<string, unknown>)["fetch"] = async () => ({
      ok: true,
      json: async () => ({ ok: true, data: yanit }),
    });
    await refreshDocuments();
  };

  const yedek = {
    document: (globalThis as Record<string, unknown>)["document"],
    fetch: (globalThis as Record<string, unknown>)["fetch"],
  };
  before(() => {
    (globalThis as Record<string, unknown>)["document"] = {
      querySelector: (sel: string) =>
        sel.startsWith("#")
          ? bul(sel.slice(1))
          : sel.includes("csrf-token")
            ? yeniOge("csrf")
            : null,
      querySelectorAll: () => [] as unknown[],
      createElement: () => ({ textContent: "" }),
    };
  });
  after(() => {
    (globalThis as Record<string, unknown>)["document"] = yedek.document;
    (globalThis as Record<string, unknown>)["fetch"] = yedek.fetch;
    ogeler.clear();
    katkilar.clear();
    state["selectedCase"] = null;
    state["selectedDocument"] = null;
    state["documents"] = [];
    state["preview"] = null;
    state["cases"] = [];
    state["sonEsitleme"] = null;
  });

  test("var → yok: satır 'Eksik' derken düğme AÇIK kalmaz", async () => {
    kur("var", "var");
    const yeni = satir("yok");
    await tazele({ evraklar: [yeni], adet: 1 });
    // Rozet ve düğme AYNI ölçümden: ikisi de taze satırın kaynakDurum'u.
    assert.equal((state["preview"] as Record<string, unknown>)["kaynakDurum"], "yok");
    assert.ok(kaynakSorunlu(yeni), "satır rozeti 'Eksik' vermeliydi");
    const dugme = bul("open-document")!;
    assert.ok(dugme, "önizleme yeniden çizilmedi");
    assert.equal(dugme["disabled"], true);
    assert.equal(dugme["title"], kaynakUyarisi("yok"));
    assert.equal(dugme["disabled"], kaynakSorunlu(yeni));
  });

  test("yok → var: geri gelen belgede düğme KAPALI kalmaz", async () => {
    kur("yok", "yok");
    const yeni = satir("var");
    await tazele({ evraklar: [yeni], adet: 1 });
    assert.equal((state["preview"] as Record<string, unknown>)["kaynakDurum"], "var");
    assert.ok(!kaynakSorunlu(yeni), "satır rozetsiz olmalıydı");
    const dugme = bul("open-document")!;
    assert.ok(dugme, "önizleme yeniden çizilmedi");
    assert.equal(dugme["disabled"], false);
    assert.equal(dugme["title"], "");
    assert.equal(dugme["disabled"], kaynakSorunlu(yeni));
  });

  test("ölçüm değişmediyse önizleme yeniden ÇİZİLMEZ (metin başa sarmaz)", async () => {
    kur("var", "var");
    await tazele({ evraklar: [satir("var")], adet: 1 });
    assert.equal(bul("open-document"), null, "gereksiz yeniden çizim");
    assert.equal(bul("document-list")!["innerHTML"] !== "", true, "liste çizilmeliydi");
  });

  test("ölçüm taşımayan satır (eski motor) önizlemedeki değeri EZMEZ", async () => {
    kur("yok", "yok");
    await tazele({ evraklar: [satir(undefined)], adet: 1 });
    assert.equal((state["preview"] as Record<string, unknown>)["kaynakDurum"], "yok");
    assert.equal(bul("open-document"), null, "sessiz varsayılan bozuldu");
  });

  test("seçili evrak listeden düşerse önizleme her hâlükârda yenilenir", async () => {
    kur(undefined, undefined);
    await tazele({ evraklar: [], adet: 0 });
    assert.equal(state["selectedDocument"], null);
    assert.equal(state["preview"], null);
    // Seçim düştüğünde "Bir evrak seçin" boşluğu çizilir; düğme hiç yaratılmaz.
    assert.equal(bul("open-document"), null);
    assert.match(String(bul("preview")!["innerHTML"]), /preview-content/);
  });
});

// ── P16 sorun sekmesi ve kalıcı durum şeridi ─────────────────────────────────
const sorunModulu = await import(
  new URL("../../web/sorunlar.js", import.meta.url).href
);
const {
  sayilmiyorMu,
  davaSorunSayaci,
  sekmeSayaci,
  sorunOzetMetni,
  sorunSatiri,
  sorunListesiHTML,
  sorunKapsamla,
  sorunlariCiz,
  sorunSayilariAyristiMi,
} = sorunModulu;
const {
  arsivDurumHTML,
  isAsamasi,
  isBasligi,
  arsivDurumTazele,
  ortaSekmeSec,
  sorunRozetleriniTazele,
} = await import(new URL("../../web/arsiv.js", import.meta.url).href);
const { davaSorunRozeti } = await import(
  new URL("../../web/evrak-durum.js", import.meta.url).href
);

describe("P16 sorun sayacı ile listenin ayrımı", () => {
  const kayit = (
    sorunId: string,
    tur: string,
    sayilir: boolean,
    durum = "acik",
    caseKey = "CK",
  ) => ({ sorunId, tur, sayilir, durum, caseKey, hata: `${tur} hatası`, at: "2026-09-12T09:00:00.000Z" });
  const acik = [
    kayit("s1", "indirme", true),
    kayit("s2", "donusum", true),
    kayit("s3", "yuklenmemis", false),
  ];
  const issues = { acik, hepsi: acik };

  test("yuklenmemis sayaçta yok, listede var", () => {
    assert.equal(davaSorunSayaci(issues, null).sayilan, 2);
    assert.equal(davaSorunSayaci(issues, null).toplam, 3);
    assert.equal(sorunListesiHTML(acik).match(/sorun-kayit/g)!.length, 3);
    assert.match(sorunSatiri(acik[2]!), /Sayaç dışı/);
    assert.ok(!/Sayaç dışı/.test(sorunSatiri(acik[0]!)));
    assert.equal(sayilmiyorMu(acik[2]), true);
  });

  test("bayrağı olmayan kayıt (eski motor) 'sayaç dışı' diye İŞARETLENMEZ", () => {
    const eski = { sorunId: "s9", tur: "donusum", durum: "acik", caseKey: "CK", hata: "x" };
    assert.equal(sayilmiyorMu(eski), false);
    assert.ok(!/Sayaç dışı/.test(sorunSatiri(eski)));
    assert.equal(davaSorunSayaci({ acik: [eski] }, null).sayilan, 1);
  });

  test("yoksayılan kayıt listede kalır ve geri alma düğmesi taşır", () => {
    const yoksayilan = { ...kayit("s1", "indirme", true), durum: "yok-sayildi" };
    const hepsi = [yoksayilan, acik[1]!, acik[2]!];
    // Sayaç `acik` üzerinden ölçülür: yoksayılan kayıt oraya girmez.
    assert.equal(davaSorunSayaci({ acik: [acik[1]!, acik[2]!] }, null).sayilan, 1);
    // Liste (`hepsi`) kaydı DÜŞÜRMEZ ve eylemi geri alınabilir bırakır.
    const html = sorunListesiHTML(hepsi, { yoksayilanlar: true });
    assert.equal(html.match(/sorun-kayit/g)!.length, 3);
    assert.match(html, /data-operation="vazgec"/);
    assert.match(html, /Yoksaymayı geri al/);
    assert.match(sorunSatiri(yoksayilan), /Yoksayıldı/);
  });

  test("özet satırı sayaç ile liste farkını SÖYLER", () => {
    assert.match(
      sorunOzetMetni(davaSorunSayaci(issues, null)),
      /3 açık kayıt · 2 tanesi sayaca giriyor/,
    );
    assert.match(sorunOzetMetni({ sayilan: 2, toplam: 2 }), /hepsi sayaca giriyor/);
    assert.match(sorunOzetMetni({ sayilan: 0, toplam: 0 }, { dava: true }), /Bu dosyada açık sorun yok/);
  });

  test("kapsam: sorun ilgili davanın yanında durur", () => {
    const karisik = [...acik, kayit("s4", "indirme", true, "acik", "BASKA")];
    assert.equal(sorunKapsamla(karisik, "CK").length, 3);
    assert.equal(sorunKapsamla(karisik, "BASKA").length, 1);
    assert.equal(sorunKapsamla(karisik, null).length, 4);
  });

  test("dava satırındaki rozet sekme sayacıyla AYNI sayıyı söyler", () => {
    const sayac = davaSorunSayaci(issues, "CK");
    assert.deepEqual(davaSorunRozeti(sayac), { metin: "2 sorun", sinif: "bad" });
    assert.equal(sekmeSayaci(sayac), "(2)");
    assert.equal(davaSorunRozeti({ sayilan: 0, toplam: 3 }), null, "sıfırda rozet olmaz");
    assert.equal(sekmeSayaci({ sayilan: 0, toplam: 3 }), "");
    // Rozet ARGÜMANSIZ çağrıda çıkmaz: P15c golden string'leri kırılmadı.
    const c = { caseKey: "CK", birimAdi: "M", dosyaNo: "2026/1", sonEvrakSayisi: 12 };
    assert.deepEqual(davaSatiri(c, null, new Set(), undefined), davaSatiri(c, null, new Set(), undefined, undefined));
  });
});

describe("P16 kalıcı durum şeridi", () => {
  const is = (durum: string, biten: number, toplam: number, caseKey = "M\u00002026/1") => ({
    isId: `is-${durum}-${biten}`,
    caseKey,
    tur: "esitle",
    durum,
    ilerleme: { biten, toplam },
  });

  test("iş yokken şerit BOŞ dizedir (yer kaplamaz)", () => {
    assert.equal(arsivDurumHTML([], []), "");
    assert.equal(arsivDurumHTML(undefined, undefined), "");
    // Bitmiş işler şeridi doldurmaz; onların yeri İşlemler ekranıdır.
    assert.equal(arsivDurumHTML([is("hazir", 5, 5), is("iptal", 1, 5)], []), "");
  });

  test("çalışan iş indirme ilerlemesini gösterir", () => {
    const html = arsivDurumHTML([is("calisiyor", 3, 10)], []);
    assert.match(html, /3 \/ 10 evrak indirildi/);
    assert.match(html, /progress-track/);
    assert.match(html, /M · 2026\/1/);
  });

  test("indirme bitip iş sürüyorsa SAYI UYDURULMAZ: 'metinler hazırlanıyor'", () => {
    // `isler` yanıtı dönüşüm için ayrı sayaç taşımıyor (ölçüldü:
    // orchestrator `ilerlemeyiKaydet` yalnız indirme döngüsünde artıyor).
    assert.deepEqual(isAsamasi(is("calisiyor", 10, 10)), {
      metin: "10 / 10 evrak indirildi · metinler hazırlanıyor…",
      yuzde: 100,
    });
    assert.deepEqual(isAsamasi(is("calisiyor", 0, 0)), {
      metin: "Evrak listesi alınıyor…",
      yuzde: null,
    });
    assert.deepEqual(isAsamasi(is("bekliyor", 0, 0)), {
      metin: "Sırada",
      yuzde: null,
    });
  });

  test("sıradaki işler ve toplu sıra sayılır", () => {
    const html = arsivDurumHTML(
      // `hazir` iş şeritte GÖRÜNMEZ ama toplu sıranın "kaç dosya bitti"
      // hesabına girer; ikisi ayrı sorulardır.
      [is("calisiyor", 1, 4), is("bekliyor", 0, 0), is("bekliyor", 0, 0), is("hazir", 5, 5)],
      [
        {
          id: "q1",
          durum: "calisiyor",
          dosyalar: [
            { caseKey: "A", denemeler: ["is-hazir-5"] },
            { caseKey: "B", denemeler: ["is-calisiyor-1"] },
          ],
        },
      ],
    );
    assert.match(html, /2 iş sırada/);
    assert.match(html, /Toplu eşitleme sırası/);
    assert.match(html, /1 \/ 2 dosya tamamlandı/);
  });

  // İNCELEMEDE YAKALANAN KUSUR: süzgeç ['calisiyor','bekliyor'] idi. Toplu sıra
  // sözlüğünde (src/jobs/toplu.ts:12) 'bekliyor' HİÇ YOK, 'duraklatildi' ise
  // vardı ve süzgeçte değildi — bir dosya hata alıp sıra durduğunda o anda
  // çalışan iş de kalmadığı için şerit boşalıp gizleniyordu: arşiv ekranında
  // "bitti" ile "yarıda kaldı" birebir aynı görünüyordu.
  test("hatayla duraklayan toplu sıra ŞERİTTE KALIR ve kendi mesajını taşır", () => {
    const durmus = {
      id: "q2",
      durum: "duraklatildi",
      mesaj: "Eşitleme tamamlanamadı. Dosya sonucunu inceleyin; Devam et bu dosyayı yeniden dener ve ardından kalan sırayı işler.",
      dosyalar: [
        { caseKey: "A", denemeler: ["is-hazir-5"] },
        { caseKey: "B", denemeler: [] },
        { caseKey: "C", denemeler: [] },
      ],
    };
    // Sıra durduğunda çalışan iş KALMAZ; eski süzgeçte şerit boş dizeye düşerdi.
    const html = arsivDurumHTML([is("hazir", 5, 5)], [durmus]);
    assert.notEqual(html, "", "duraklayan sıra şeritten kayboldu");
    assert.match(html, /duraklatıldı/);
    assert.match(html, /Devam et bu dosyayı yeniden dener/);
    assert.match(html, /1 \/ 3 dosya tamamlandı/);
    // Biten/iptal edilen sıra şeritte yer KAPLAMAZ (kabul ölçütü korunuyor).
    for (const durum of ["hazir", "iptal", "kesildi"])
      assert.equal(arsivDurumHTML([], [{ ...durmus, durum }]), "", durum);
    // Ölü değer: sıra sözlüğünde 'bekliyor' hiç üretilmez, süzgeçten çıktı.
    assert.equal(arsivDurumHTML([], [{ ...durmus, durum: "bekliyor" }]), "");
  });

  test("isBasligi caseKey ayıracını çözer, yoksa iş türüne düşer", () => {
    assert.equal(isBasligi(is("calisiyor", 0, 1)), "M · 2026/1");
    assert.equal(isBasligi({ tur: "klonla" }), "Dosya indirme");
    assert.equal(isBasligi({}), "İşlem");
  });

  test("yoklama sıklığı ARTMADI: tek 5 sn'lik zamanlayıcı, yeni RPC yok", async () => {
    const fs = await import("node:fs");
    const oku = (ad: string) =>
      fs.readFileSync(new URL(`../../web/${ad}`, import.meta.url), "utf8");
    const app = oku("app.js");
    assert.match(app, /setInterval\(poll, 5000\)/);
    assert.equal((app.match(/setInterval\(/g) ?? []).length, 1, "ikinci zamanlayıcı eklenmiş");
    for (const ad of ["arsiv.js", "sorunlar.js"]) {
      assert.ok(!/setInterval\(/.test(oku(ad)), `${ad} kendi zamanlayıcısını kurmuş`);
      assert.ok(!/setTimeout\(/.test(oku(ad)), `${ad} kendi zamanlayıcısını kurmuş`);
    }
    // Şerit poll turunun MEVCUT verisinden besleniyor: yeni bir api() çağrısı yok.
    assert.ok(!/api\(/.test(arsivDurumHTML.toString()));
    assert.match(app, /arsivDurumTazele\(\)/, "şerit poll turuna bağlanmamış");
  });
});

describe("P16 sekme ve şerit DOM davranışı", () => {
  // P15c'deki saplamanın aynısı: innerHTML yazımı id kayıtlarını yeniden
  // yaratır, böylece "gizlendi mi / çizildi mi" iddiaları anlamlı olur.
  const p16State = ortak.state as Record<string, unknown>;
  const ogeler = new Map<string, Record<string, unknown>>();
  const yeniOge = (id: string): Record<string, unknown> => ({
    id,
    textContent: "",
    innerHTML: "",
    disabled: false,
    title: "",
    hidden: false,
    checked: false,
    content: "csrf-test",
    dataset: {},
    classList: { toggle: () => {} },
    querySelectorAll: () => [] as unknown[],
    setAttribute: () => {},
    addEventListener: () => {},
    closest: () => null,
  });
  const bul = (id: string) => ogeler.get(id) ?? null;
  const yedek = {
    document: (globalThis as Record<string, unknown>)["document"],
    issues: p16State["issues"],
    jobs: p16State["jobs"],
    batches: p16State["batches"],
    selectedCase: p16State["selectedCase"],
    cases: p16State["cases"],
    archiveLoaded: p16State["archiveLoaded"],
    batchSelection: p16State["batchSelection"],
  };
  before(() => {
    for (const id of [
      "case-list",
      "case-count",
      "sorun-liste",
      "sorun-sayaci",
      "sorun-ozet",
      "sorun-kapsam",
      "sorun-yoksayilan",
      "document-list",
      "evrak-araclar",
      "evrak-eylemler",
      "sorun-araclar",
      "arsiv-durum",
    ])
      ogeler.set(id, yeniOge(id));
    (globalThis as Record<string, unknown>)["document"] = {
      querySelector: (sel: string) => (sel.startsWith("#") ? bul(sel.slice(1)) : null),
      querySelectorAll: () => [] as unknown[],
    };
  });
  after(() => {
    (globalThis as Record<string, unknown>)["document"] = yedek.document;
    p16State["issues"] = yedek.issues;
    p16State["jobs"] = yedek.jobs;
    p16State["batches"] = yedek.batches;
    p16State["selectedCase"] = yedek.selectedCase;
    p16State["cases"] = yedek.cases;
    p16State["archiveLoaded"] = yedek.archiveLoaded;
    p16State["batchSelection"] = yedek.batchSelection;
    p16State["ortaSekme"] = "evrak";
    ogeler.clear();
  });

  test("sekme geçişi: evrak listesi ve sorun listesi aynı sütunu paylaşır", () => {
    ortaSekmeSec("evrak");
    assert.equal(bul("document-list")!["hidden"], false);
    assert.equal(bul("sorun-liste")!["hidden"], true);
    assert.equal(bul("evrak-eylemler")!["hidden"], false);
    ortaSekmeSec("sorun");
    assert.equal(bul("document-list")!["hidden"], true);
    assert.equal(bul("sorun-liste")!["hidden"], false);
    // Evrak eylemleri sorun sekmesinde gizlenir; sütun altında yanlış düğme kalmaz.
    assert.equal(bul("evrak-eylemler")!["hidden"], true);
    assert.equal(bul("sorun-araclar")!["hidden"], false);
  });

  test("sekme sayacı 2 derken liste 3 kaydı çizer", () => {
    p16State["selectedCase"] = null;
    p16State["issues"] = {
      acik: [
        { sorunId: "a", tur: "indirme", durum: "acik", caseKey: "CK", hata: "x", sayilir: true },
        { sorunId: "b", tur: "donusum", durum: "acik", caseKey: "CK", hata: "y", sayilir: true },
        { sorunId: "c", tur: "yuklenmemis", durum: "acik", caseKey: "CK", hata: "z", sayilir: false },
      ],
      hepsi: [],
    };
    sorunlariCiz();
    assert.equal(bul("sorun-sayaci")!["textContent"], "(2)");
    assert.equal(
      String(bul("sorun-liste")!["innerHTML"]).match(/sorun-kayit/g)!.length,
      3,
      "sayaçtan düşen kayıt listeden de düşmüş",
    );
    assert.match(String(bul("sorun-ozet")!["textContent"]), /3 açık kayıt · 2/);
  });

  // ELLE UI KONTROLÜNDE YAKALANAN REGRESYON: yoksay/geri al sonrası başlıktaki
  // rozet ve sekme sayacı düşerken dava satırı eski sayıyı gösteriyordu — aynı
  // sorun iki yerde farklı sayılıyordu (ROADMAP §14 kabul ölçütünün ihlali).
  test("yoksaydıktan sonra DAVA SATIRI da düşer: iki yerde aynı sayı", () => {
    p16State["cases"] = [
      { caseKey: "CK", birimAdi: "Denizli 1. İş Mahkemesi", dosyaNo: "2026/1", klonYolu: "/a", sonEvrakSayisi: 12 },
    ];
    p16State["archiveLoaded"] = true;
    p16State["batchSelection"] = new Set();
    const kayit = (id: string, tur: string, sayilir: boolean) => ({
      sorunId: id, tur, durum: "acik", caseKey: "CK", hata: "x", sayilir,
    });
    p16State["issues"] = {
      acik: [kayit("a", "indirme", true), kayit("b", "donusum", true), kayit("c", "yuklenmemis", false)],
      hepsi: [],
    };
    sorunRozetleriniTazele();
    assert.match(String(bul("case-list")!["innerHTML"]), /2 sorun/);
    // "a" yoksayıldı → açık listeden düştü.
    p16State["issues"] = { acik: [kayit("b", "donusum", true), kayit("c", "yuklenmemis", false)], hepsi: [] };
    sorunRozetleriniTazele();
    assert.match(String(bul("case-list")!["innerHTML"]), /1 sorun/);
    assert.ok(!/2 sorun/.test(String(bul("case-list")!["innerHTML"])), "dava satırı bayat kaldı");
    // Yalnız sayılmayan kayıt kalırsa satırda rozet HİÇ olmaz.
    p16State["issues"] = { acik: [kayit("c", "yuklenmemis", false)], hepsi: [] };
    sorunRozetleriniTazele();
    assert.ok(!/sorun</.test(String(bul("case-list")!["innerHTML"])));
  });

  // İNCELEMEDE YAKALANAN KUSUR: imza önbelleği yalnız #arsiv-durum YOKKEN
  // sıfırlanıyordu. Ekran değiştirip 5 sn'lik tur geçmeden geri dönüldüğünde
  // renderArchive() taze (boş, hidden) bir kapsayıcı yaratıyor ama imza aynı
  // olduğu için erken dönülüyor ve iş sürerken şerit gizli kalıyordu.
  test("ekran yeniden çizilince şerit imza AYNI olsa da yeniden yazılır", () => {
    p16State["batches"] = [];
    p16State["jobs"] = [
      { isId: "j9", caseKey: "M\u00002026/9", tur: "esitle", durum: "bekliyor", ilerleme: { biten: 0, toplam: 0 } },
    ];
    arsivDurumTazele();
    assert.equal(bul("arsiv-durum")!["hidden"], false);
    assert.match(String(bul("arsiv-durum")!["innerHTML"]), /1 iş sırada/);
    // renderArchive() #page'i yeniden yazar: taze element boş ve hidden gelir.
    // state.jobs DEĞİŞMEDİ, yani imza da aynı — eski kod burada erken dönerdi.
    ogeler.set("arsiv-durum", yeniOge("arsiv-durum"));
    assert.equal(bul("arsiv-durum")!["innerHTML"], "");
    arsivDurumTazele();
    assert.equal(bul("arsiv-durum")!["hidden"], false, "şerit geri dönüşte gizli kaldı");
    assert.match(
      String(bul("arsiv-durum")!["innerHTML"]),
      /1 iş sırada/,
      "şerit geri dönüşte boş kaldı",
    );
    p16State["jobs"] = [];
  });

  test("şerit iş yokken gizli, iş varken görünür", () => {
    p16State["jobs"] = [];
    p16State["batches"] = [];
    arsivDurumTazele();
    assert.equal(bul("arsiv-durum")!["hidden"], true);
    assert.equal(bul("arsiv-durum")!["innerHTML"], "");
    p16State["jobs"] = [
      { isId: "j1", caseKey: "M\u00002026/1", tur: "esitle", durum: "calisiyor", ilerleme: { biten: 2, toplam: 8 } },
    ];
    arsivDurumTazele();
    assert.equal(bul("arsiv-durum")!["hidden"], false);
    assert.match(String(bul("arsiv-durum")!["innerHTML"]), /2 \/ 8 evrak indirildi/);
    p16State["jobs"] = [];
    arsivDurumTazele();
    assert.equal(bul("arsiv-durum")!["hidden"], true, "iş bitince şerit yer kaplamamalı");
  });
});

// ── P16 incelemesinin ENGELLEYİCİ bulgusu: iki yüzeyin aynı turda yakınsaması ─
// Bu describe saf üretici DEĞİL, GERÇEK `poll` turunu koşturur: web/app.js
// içe aktarılır (modül gövdesi `kanca.poll = poll` atar, testin tuttuğu tek
// tutamak budur) ve bir tur boyunca hangi RPC'lerin indiği sayılır. Ölçülen
// kusur şuydu: sol menü rozeti her turda `durum`dan tazeleniyor, sekme sayacı
// / dava rozeti / liste ise yalnız İŞ BİTİNCE — motor sorun kaydını iş
// SÜRERKEN yazdığından aynı ekranda iki farklı sayı duruyordu.
describe("P16 poll turunda sorun sayısı yakınsar", () => {
  const pState = ortak.state as Record<string, unknown>;
  const ogeler = new Map<string, Record<string, unknown>>();
  const yeniOge = (id: string): Record<string, unknown> => ({
    id,
    textContent: "",
    innerHTML: "",
    hidden: false,
    disabled: false,
    title: "",
    checked: false,
    indeterminate: false,
    value: "",
    content: "csrf-test",
    dataset: {},
    style: {},
    classList: { toggle: () => {}, add: () => {}, remove: () => {} },
    querySelectorAll: () => [] as unknown[],
    setAttribute: () => {},
    addEventListener: () => {},
    closest: () => null,
  });
  const bul = (id: string) => ogeler.get(id) ?? null;
  // #job-list ve #batch-list BİLEREK yok: İndirilenler ekranındayız, renderJobs
  // gerçek uygulamada da erken döner.
  const IDLER = [
    "page", "page-title", "page-description", "connection-error", "toast",
    "session-label", "session-detail", "session-dot", "login-button",
    "cancel-login", "header-status", "issue-badge",
    "case-list", "case-count", "case-search", "refresh-cases",
    "batch-select-visible", "batch-preview", "sync-batch",
    "document-list", "document-count", "document-search",
    "sorun-liste", "sorun-sayaci", "sorun-ozet", "sorun-kapsam",
    "sorun-yoksayilan", "evrak-araclar", "evrak-eylemler", "sorun-araclar",
    // P06a — üçüncü sekme (Denetim). renderArchive bu düğmeleri doğrudan
    // bağlar; listede olmayan id null döner ve ekran çizilmeden düşer.
    "denetim-liste", "denetim-araclar", "denetim-sayaci", "denetim-ozet",
    "denetim-kapsam", "denetim-at", "denetim-calistir",
    "sync-case", "open-folder", "preview", "arsiv-durum",
  ];
  const cagrilar: string[] = [];
  let yanitlar: Record<string, unknown> = {};
  const yedek: Record<string, unknown> = {};
  let zamanlayici: { ms: number } | null = null;

  before(async () => {
    for (const anahtar of ["document", "window", "location", "history", "fetch"])
      yedek[anahtar] = (globalThis as Record<string, unknown>)[anahtar];
    for (const id of IDLER) ogeler.set(id, yeniOge(id));
    (globalThis as Record<string, unknown>)["document"] = {
      hidden: false,
      querySelector: (sel: string) =>
        sel.startsWith("#")
          ? bul(sel.slice(1))
          : sel.includes("csrf-token")
            ? yeniOge("csrf")
            : null,
      querySelectorAll: () => [] as unknown[],
      addEventListener: () => {},
      createElement: () => ({ textContent: "" }),
    };
    (globalThis as Record<string, unknown>)["window"] = {
      addEventListener: () => {},
      scrollY: 0,
    };
    (globalThis as Record<string, unknown>)["location"] = { hash: "#indirilenler" };
    (globalThis as Record<string, unknown>)["history"] = { replaceState: () => {} };
    (globalThis as Record<string, unknown>)["fetch"] = async (url: string) => {
      const ad = String(url).replace("/api/", "");
      cagrilar.push(ad);
      return {
        ok: true,
        json: async () => ({ ok: true, data: yanitlar[ad] ?? {} }),
      };
    };
    // Arşiv zaten yüklü sayılır: modül gövdesindeki navigate() ek bir
    // `davalar` çağrısı yapmasın, sayım yalnız poll turunu ölçsün.
    pState["archiveLoaded"] = true;
    pState["cases"] = [];
    pState["batchSelection"] = new Set();
    pState["hazirlikOzetleri"] = new Map();
    // app.js modül gövdesi 5 sn'lik zamanlayıcıyı kurar ve kimliğini atmaz;
    // test bittikten sonra koşmaya devam ederse (document geri alınmış olur)
    // sahipsiz bir hata doğar. Bu yüzden kurulum anında yakalanır.
    const gercekSetInterval = globalThis.setInterval;
    (globalThis as Record<string, unknown>)["setInterval"] = (
      _fn: unknown,
      ms: number,
    ) => {
      zamanlayici = { ms };
      return 0;
    };
    try {
      // "P08c modül grafiği" testi app.js'i BİLEREK DOM'suz import edip
      // reddedilmesini bekliyor; ESM o belirteci reddedilmiş olarak
      // önbelleklediği için aynı yol ikinci kez yüklenemez. Sorgu ekiyle taze
      // bir örnek alınır — bağımlılıkları (ortak.js) sorgusuz çözülür, yani
      // `state`/`kanca` bu dosyanınkiyle AYNI nesnedir.
      await import(
        `${new URL("../../web/app.js", import.meta.url).href}?poll-turu-testi`
      );
    } finally {
      (globalThis as Record<string, unknown>)["setInterval"] = gercekSetInterval;
    }
    // Modül gövdesindeki ilk poll()/refreshIssues() akışının bitmesini bekle.
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
    cagrilar.length = 0;
  });
  after(() => {
    for (const [anahtar, deger] of Object.entries(yedek))
      (globalThis as Record<string, unknown>)[anahtar] = deger;
    ogeler.clear();
    pState["issues"] = null;
    pState["status"] = null;
    pState["cases"] = [];
    pState["jobs"] = [];
    pState["batches"] = [];
    pState["archiveLoaded"] = false;
    pState["selectedCase"] = null;
  });

  const kayit = (id: string) => ({
    sorunId: id,
    tur: "indirme",
    durum: "acik",
    caseKey: "PK",
    hata: "portal 500 döndü",
    sayilir: true,
  });
  /** Bir poll turu: `durum` + `isler` yanıtlarını kurar, turu bekler. */
  const tur = async (sorunAcik: number, sorunlarYaniti: unknown) => {
    yanitlar = {
      durum: {
        oturum: { durum: "kapali" },
        isler: { calisiyor: 1 },
        sorunAcik,
        sorunAcikToplam: sorunAcik,
      },
      isler: {
        isler: [
          {
            isId: "j-surüyor",
            caseKey: "PK",
            tur: "esitle",
            durum: "calisiyor",
            ilerleme: { biten: 6, toplam: 20 },
          },
        ],
        topluIsler: [],
      },
      sorunlar: sorunlarYaniti,
    };
    cagrilar.length = 0;
    await (ortak.kanca as { poll: () => Promise<void> }).poll();
  };

  test("kurulum: gerçek poll tutamağı ve tek 5 sn'lik zamanlayıcı", () => {
    assert.equal(typeof (ortak.kanca as { poll: unknown }).poll, "function");
    assert.deepEqual(zamanlayici, { ms: 5000 });
  });

  test("İŞ SÜRERKEN doğan kayıt: sekme sayacı, rozet ve dava satırı 3 der", async () => {
    pState["page"] = "indirilenler";
    pState["selectedCase"] = null;
    pState["archiveLoaded"] = true;
    pState["batchSelection"] = new Set();
    pState["cases"] = [
      { caseKey: "PK", birimAdi: "Denizli 2. İş Mahkemesi", dosyaNo: "2026/7", klonYolu: "/p" },
    ];
    // İstemcinin elindeki BAYAT anlık görüntü: bir kayıt.
    pState["issues"] = { acik: [kayit("p1")], hepsi: [], acikAdet: 1, sayilanAdet: 1 };
    // Sunucu gerçeği: üç kayıt. İş HÂLÂ ÇALIŞIYOR — hiçbir iş terminal duruma
    // geçmiyor, yani eski `finished` yolu tetiklenmez.
    await tur(3, {
      acik: [kayit("p1"), kayit("p2"), kayit("p3")],
      hepsi: [],
      acikAdet: 3,
      sayilanAdet: 3,
    });
    assert.ok(cagrilar.includes("sorunlar"), "ayrışma görülmüş ama liste tazelenmemiş");
    // Saplamada textContent ham değeri tutar; gerçek DOM dizeye çevirir.
    assert.equal(String(bul("issue-badge")!["textContent"]), "3");
    assert.equal(bul("sorun-sayaci")!["textContent"], "(3)", "sekme sayacı bayat kaldı");
    assert.equal(
      (pState["issues"] as { acik: unknown[] }).acik.length,
      3,
      "liste bayat kaldı",
    );
    assert.match(String(bul("case-list")!["innerHTML"]), /3 sorun/);
  });

  test("sayılar UYUŞUYORSA ek istek doğmaz: tur başına hâlâ iki istek", async () => {
    pState["page"] = "indirilenler";
    pState["issues"] = {
      acik: [kayit("p1"), kayit("p2"), kayit("p3")],
      hepsi: [],
      acikAdet: 3,
      sayilanAdet: 3,
    };
    await tur(3, { acik: [], hepsi: [], acikAdet: 0, sayilanAdet: 0 });
    assert.deepEqual(cagrilar, ["durum", "isler"], "boşta yoklama sıklığı arttı");
  });

  test("başka ekrandayken tazelenmez; sorun sekmesi o ekranda yok", async () => {
    pState["page"] = "islemler";
    pState["issues"] = { acik: [kayit("p1")], hepsi: [], acikAdet: 1, sayilanAdet: 1 };
    await tur(3, { acik: [], hepsi: [], acikAdet: 0, sayilanAdet: 0 });
    assert.ok(!cagrilar.includes("sorunlar"));
    pState["page"] = "indirilenler";
  });

  test("SESSİZ VARSAYILAN: sayı taşımayan yanıt ayrışma SAYILMAZ", () => {
    // Eski motor `sayilanAdet`/`acikAdet` göndermiyor olabilir; ölçemediğimiz
    // fark için her turda bir istek doğurmak yoklama sıklığını artırırdı.
    assert.equal(sorunSayilariAyristiMi(null, null), false);
    assert.equal(sorunSayilariAyristiMi({ sorunAcik: 3 }, null), false);
    assert.equal(sorunSayilariAyristiMi({ sorunAcik: 3 }, { acik: [] }), false);
    assert.equal(sorunSayilariAyristiMi({ sorunAcik: 3 }, { sayilanAdet: 3 }), false);
    assert.equal(sorunSayilariAyristiMi({ sorunAcik: 3 }, { sayilanAdet: 1 }), true);
    assert.equal(
      sorunSayilariAyristiMi({ sorunAcik: 3, sorunAcikToplam: 5 }, { sayilanAdet: 3, acikAdet: 3 }),
      true,
      "toplam ayrışması da görülmeli",
    );
  });
});


// ── P18 taraf gösterimi ──────────────────────────────────────────────────────
// SINIR: burada sınanan şey SATIR ÜRETİMİDİR. "Tıklamadıkça portala istek
// gitmez" iddiasının motor tarafı test/p18.test.ts'te mock portalın istek
// sayacıyla, tarayıcı tarafı ise elle UI kontrolüyle ölçülür.
// GİZLİLİK: adların hepsi SENTETİKTİR.
describe("P18 taraf gösterimi", () => {
  const ICRA = [
    { adi: "SENTETİK ALACAKLI A.Ş.", rol: "Alacaklı", vekil: "Av. Sentetik" },
    { adi: "SENTETİK BORÇLU BİR", rol: "Borçlu" },
    { adi: "SENTETİK BORÇLU İKİ", rol: "Borçlu" },
    { adi: "SENTETİK BORÇLU ÜÇ", rol: "Borçlu" },
  ];

  test("rol PORTALDAN gelir, ilk görülme sırasıyla gruplanır", () => {
    assert.deepEqual(
      taraflariGrupla(ICRA).map((g: { rol: string; adlar: string[] }) => [g.rol, g.adlar.length]),
      [["Alacaklı", 1], ["Borçlu", 3]],
    );
    // Ceza/çocuk etiketleri de aynen geçer; sabit tablo yok.
    assert.equal(
      tarafOzetMetni([
        { adi: "SENTETİK KATILAN", rol: "Katılan" },
        { adi: "SENTETİK ÇOCUK", rol: "Suça Sürüklenen Çocuk" },
      ]),
      "Katılan: SENTETİK KATILAN · Suça Sürüklenen Çocuk: SENTETİK ÇOCUK",
    );
  });

  test("çok taraf ilk N + '+k' ile kısalır; vekil satıra GİRMEZ", () => {
    assert.equal(
      tarafOzetMetni(ICRA, { adTavani: 2 }),
      "Alacaklı: SENTETİK ALACAKLI A.Ş. · Borçlu: SENTETİK BORÇLU BİR, SENTETİK BORÇLU İKİ +1",
    );
    assert.ok(!tarafOzetMetni(ICRA).includes("Av. Sentetik"), "vekil liste satırına sızmış");
    // Çok rol varsa gruplar da kısalır ve kaç rolün gizlendiği söylenir.
    const cokRol = ["A", "B", "C", "D", "E"].map((r) => ({ adi: `SENTETİK ${r}`, rol: r }));
    assert.match(tarafOzetMetni(cokRol, { rolTavani: 3 }), /\+2 rol$/);
  });

  // P18 incelemesinden: `davalarim.json` elle düzenlenip `taraflar` diziden
  // başka bir şeye dönerse eski kod `for...of` ile fırlıyordu. Bu işlev arşiv
  // listesinin map'i içinden çağrıldığı için TEK bozuk kayıt İndirilenler
  // ekranının tamamını çizilmez yapardı.
  test("dizi olmayan taraf alanı listeyi ÇÖKERTMEZ, boş sayılır", () => {
    for (const bozuk of [{ adi: "SENTETİK" }, 3, "SENTETİK", true]) {
      assert.deepEqual(taraflariGrupla(bozuk), [], `girdi: ${JSON.stringify(bozuk)}`);
      assert.equal(tarafOzetMetni(bozuk), "");
      assert.equal(tarafOzetiHTML(bozuk, (x: string) => x), "");
    }
    // Dizi içindeki bozuk SATIR zaten atlanıyordu; o davranış korunuyor.
    assert.deepEqual(
      taraflariGrupla([null, 5, { adi: "SENTETİK AD", rol: "Davacı" }]),
      [{ rol: "Davacı", adlar: ["SENTETİK AD"] }],
    );
  });

  test("aynı ad tekrarlanmaz; rolsüz taraf etiketsiz yazılır; boş girdi boş dize", () => {
    assert.equal(
      tarafOzetMetni([
        { adi: "SENTETİK BİR", rol: "Borçlu" },
        { adi: "SENTETİK BİR", rol: "Borçlu" },
      ]),
      "Borçlu: SENTETİK BİR",
    );
    assert.equal(tarafOzetMetni([{ adi: "SENTETİK ROLSÜZ", rol: "" }]), "SENTETİK ROLSÜZ");
    assert.equal(tarafOzetMetni([]), "");
    assert.equal(tarafOzetMetni(undefined), "");
    assert.equal(tarafOzetiHTML([], (v: string) => v), "");
  });

  test("HTML kaçırma çağırandan gelir ve HER PARÇAYA uygulanır", () => {
    const esc = (v: string) =>
      String(v ?? "").replace(/[&<>"']/g, (ch: string) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!,
      );
    const html = tarafOzetiHTML(
      [{ adi: '<img src=x onerror=1> & "tırnak"', rol: "<b>Rol</b>" }],
      esc,
    );
    assert.ok(!html.includes("<img"), "ad kaçırılmamış");
    assert.ok(!html.includes("<b>Rol"), "rol kaçırılmamış");
    assert.match(html, /&lt;img src=x onerror=1&gt; &amp; &quot;tırnak&quot;/);
  });

  test("düğmenin dört durumu ve İKİNCİ TIKLAMA disiplini", () => {
    assert.equal(tarafDugmesi(undefined).etiket, "Tarafları getir");
    assert.equal(tarafDugmesi(undefined).kapali, false);
    assert.equal(tarafDugmesi({ durum: "yukleniyor" }).etiket, "Getiriliyor…");
    assert.equal(tarafDugmesi({ durum: "yukleniyor" }).kapali, true);
    assert.equal(tarafDugmesi({ durum: "geldi", taraflar: [] }).etiket, "Taraflar geldi");
    assert.equal(tarafDugmesi({ durum: "geldi", taraflar: [] }).kapali, true);
    assert.equal(tarafDugmesi({ durum: "hata", mesaj: "X" }).etiket, "Yeniden dene");
    assert.equal(tarafDugmesi({ durum: "hata", mesaj: "X" }).baslik, "X");
    // Oturum yokken (ya da liste sürümsüzken) düğme KAPALI ve sebebi yazılı.
    const engelli = tarafDugmesi(undefined, { engel: "Taraf sorgusu UYAP oturumu ister." });
    assert.equal(engelli.kapali, true);
    assert.equal(engelli.baslik, "Taraf sorgusu UYAP oturumu ister.");

    // KABUL 2 — istek disiplini: gelmiş ya da yükleniyor olan satır yeni
    // istek DOĞURMAZ; hata bilinçli bir "Yeniden dene" ile tekrarlanabilir.
    assert.equal(tarafSorgusuGerekli(undefined), true);
    assert.equal(tarafSorgusuGerekli({ durum: "yukleniyor" }), false);
    assert.equal(tarafSorgusuGerekli({ durum: "geldi", taraflar: [] }), false);
    assert.equal(tarafSorgusuGerekli({ durum: "hata", mesaj: "X" }), true);
    // Bilinmeyen durum "bosta" sayılır (sessiz varsayılan), çökmez.
    assert.equal(tarafSorgusuGerekli({ durum: "zort" }), true);
  });

  test("arşiv satırı: taraf gelince çizilir, ESKİ KAYITTA satır HİÇ ÇIKMAZ", () => {
    const temel = { caseKey: "k", birimAdi: "Denizli 1. İcra Müdürlüğü", dosyaNo: "2026/7", klonYolu: "/y" };
    // KABUL 6 — taraf alanı boş eski registry kaydı çökmeden, taraf satırı
    // OLMADAN çizilir ve HTML P16'daki hâliyle birebir aynıdır.
    const eski = davaSatiri(temel, null, new Set());
    assert.ok(!eski.includes("taraf-ozet"));
    assert.equal(davaSatiri({ ...temel, taraflar: [] }, null, new Set()), eski);
    assert.equal(davaSatiri({ ...temel, taraflar: undefined }, null, new Set()), eski);

    const dolu = davaSatiri({ ...temel, taraflar: ICRA, taraflarAt: "2026-09-12T09:00:00.000Z" }, null, new Set());
    assert.match(dolu, /<small class="taraf-ozet"[^>]*>/);
    assert.match(dolu, /taraf-rol">Alacaklı:/);
    assert.match(dolu, /SENTETİK BORÇLU BİR, SENTETİK BORÇLU İKİ \+1/);
    assert.ok(!dolu.includes("Av. Sentetik"), "vekil arşiv satırına sızmış");
    // Başlıkta tam liste + ne zaman alındığı durur; satırı şişirmez.
    assert.match(dolu, /title="[^"]*SENTETİK BORÇLU ÜÇ[^"]*tarihinde alındı"/);
    // Rozetler yerinde kalır: taraf satırı onların önüne geçmez.
    assert.ok(dolu.indexOf("taraf-ozet") < dolu.indexOf('class="tag'));
  });
});

// ── P18a — oturum kapısı (ELLE UI KONTROLÜNDE İKİ KEZ YAKALANDI) ────────────
// 1. tur: oturum düşünce düğmeler AÇIK kalıyordu. O tur `ortak.js`
//    `updateStatus` içine TEK YÖNLÜ bir mandal konmuştu (yalnız kapatırdı).
// 2. tur (P18 incelemesi, 12 Eyl — ölçüldü): mandal düğmeyi bir daha
//    AÇMIYORDU. İzole motorda (mock portal, oturum AÇIK) sayfa yenilenip hemen
//    listelenince düğmeler "Taraf sorgusu UYAP oturumu ister." başlığıyla
//    kapalı doğuyor ve 12 sn sonra bile — başlıkta "UYAP oturumu açık"
//    yazarken — kapalı kalıyordu. Aynı mandal, oturum SÜRÜMÜ hiç değişmeden
//    geçici bir `kontrol_ediliyor` turunda da kalıcı kapanmaya yol açıyordu.
//
// Kapı artık SÜRÜM ÖLÇÜYOR ve saf bir fonksiyonda (web/taraf.js). Bekçi:
// "status yok iken kapalı → aktif gelince AÇILIR; sürüm değişmişse AÇILMAZ."
describe("P18a taraf düğmesinin oturum kapısı", () => {
  const AKTIF = (surum: number) => ({ durum: "aktif", surum });

  test("status YOK iken kapalı, aynı sürümle AKTİF gelince AÇILIR", () => {
    // Soğuk açılış: ilk `durum` yanıtı dönmeden liste geldi (surum=3).
    assert.equal(tarafOturumEngeli(undefined, 3), TARAF_ENGEL.bilinmiyor);
    assert.equal(tarafOturumEngeli(null, 3), TARAF_ENGEL.bilinmiyor);
    // Yanıt geldi: sürüm aynı → kimlikler geçerli, düğme AÇILIR.
    assert.equal(tarafOturumEngeli(AKTIF(3), 3), "", "aktif oturumda kapı açılmadı");
  });

  test("SÜRÜM DEĞİŞMİŞSE oturum aktif olsa bile AÇILMAZ", () => {
    // Çıkış + yeniden giriş: sunucudaki sayaç arttı, elimizdeki liste eski.
    assert.equal(tarafOturumEngeli(AKTIF(4), 3), TARAF_ENGEL.degisti);
    assert.notEqual(TARAF_ENGEL.degisti, "");
    // Damgasız liste de tahminle açılmaz.
    assert.equal(tarafOturumEngeli(AKTIF(3), null), TARAF_ENGEL.damgasiz);
    assert.equal(tarafOturumEngeli(AKTIF(3), undefined), TARAF_ENGEL.damgasiz);
  });

  test("GEÇİCİ `kontrol_ediliyor` kapıyı kalıcı kapatmaz", () => {
    // Probe başında durum senkron olarak kontrol_ediliyor'a çekilir
    // (src/uyap/session.ts); sürüm DEĞİŞMEZ.
    assert.equal(
      tarafOturumEngeli({ durum: "kontrol_ediliyor", surum: 3 }, 3),
      TARAF_ENGEL.dogrulaniyor,
    );
    // Probe bitti, oturum yine aktif ve sürüm aynı → düğme geri AÇILIR.
    assert.equal(tarafOturumEngeli(AKTIF(3), 3), "");
  });

  test("oturum GERÇEKTEN kapalıyken kapalı ve sebebi yazılı", () => {
    for (const durum of ["giris_gerekiyor", "bitti"]) {
      assert.equal(tarafOturumEngeli({ durum, surum: 3 }, 3), TARAF_ENGEL.kapali);
    }
    assert.match(TARAF_ENGEL.kapali, /giriş yapıp dosya listesini yenileyin/);
  });

  test("kapalı kapı düğmeyi kapatır, açık kapı boşta/hata düğmesini açar", () => {
    const kapali = tarafDugmesi(undefined, { engel: TARAF_ENGEL.bilinmiyor });
    assert.equal(kapali.kapali, true);
    assert.equal(kapali.baslik, TARAF_ENGEL.bilinmiyor);
    const acik = tarafDugmesi(undefined, { engel: "" });
    assert.equal(acik.kapali, false);
    assert.match(String(acik.baslik), /tek sorgu gönderir/);
    // "geldi" düğmesi kapıdan bağımsız KAPALI kalır: kapı onu açmamalı.
    assert.equal(tarafDugmesi({ durum: "geldi", taraflar: [] }, { engel: "" }).kapali, true);
  });

  test("app.js kapıyı çizim anında DEĞİL, durum değişince de ölçüyor", async () => {
    const { readFileSync } = await import("node:fs");
    const kaynak = readFileSync(new URL("../../web/app.js", import.meta.url), "utf8");
    // Kapı saf fonksiyondan gelir (app.js kendi kopyasını tutmaz).
    assert.match(kaynak, /tarafOturumEngeli\(state\.status\?\.oturum, state\.portal\.surum\)/);
    // Çizim, dayandığı kapıyı kaydeder.
    assert.match(kaynak, /portal\.cizilenEngel = tarafEngeli\(\)/);
    // `state.status`un değiştiği TEK yer olan poll, kapıyı yeniden ölçer.
    assert.match(kaynak, /state\.status = statusResult\.value;\s*\n\s*updateStatus\(\);(?:\s*\n\s*\/\/[^\n]*)*\s*\n\s*tarafKapisiTazele\(\);/);
    // Eski tek yönlü mandal geri gelmemeli.
    assert.doesNotMatch(kaynak, /data-oturum-gerek/, "tek yönlü mandal geri gelmiş");
    const ortakKaynak = readFileSync(new URL("../../web/ortak.js", import.meta.url), "utf8");
    assert.doesNotMatch(ortakKaynak, /querySelectorAll\("\[data-oturum-gerek\]"\)/);
  });
});
