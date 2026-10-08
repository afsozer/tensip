// Evrak ve dava satırlarındaki etiket/rozet/özet sözlüğü. DOM'a, fetch'e veya
// uygulama durumuna bağlı değil: girdi manifest kaydı, çıktı {metin, sinif}.
// Etiket metni HTML değildir; kaçırma çağıran satır şablonunda yapılır.
// Yeni bir rozet ("yeni" → P15b, "eksik" → P15c) buraya ayrı bir fonksiyon
// olarak eklenir ve rozetler() dizisine bir satırla katılır. Ayrı bir
// web/rozet.js AÇILMAZ (ROADMAP §13).
//
// İKİNCİ TÜRETME İKİZİ (P15b): yeniMi/esitlemeSayaci, src/store/esitleme.ts
// içindeki TS eşlerinin birebir kopyasıdır; kararların gerekçesi (kimlik
// eşitliği, tamamlanmış deneme, ilk indirmede rozet yok) o dosyanın başındadır
// ve burada tekrarlanmaz. Bekçi: test/arsiv-ui.test.ts "P15b türetme ikizi".
//
// TÜRETME İKİZİ: aşağıdaki hazirlikCoz/GORSEL_UZANTILAR, src/store/hazirlik.ts
// içindeki TS eşlerinin birebir kopyasıdır (web modülleri TS import edemez).
// İkisinin aynı tabloyu ürettiği test/arsiv-ui.test.ts içindeki "türetme ikizi"
// testiyle sabitlenmiştir; birini değiştiren diğerini de değiştirmelidir.
export const GORSEL_UZANTILAR = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".tif",
  ".tiff",
  ".bmp",
  ".webp",
]);
export const LEGACY_BIRLESIK = "unsupported";
const YAZILAN = new Set([
  "ok",
  "gorsel",
  "desteklenmiyor",
  "arac-yok",
  "hata",
  "bekliyor",
]);

export function categoryName(value) {
  return (
    {
      "01-Kararlar-Tutanaklar": "Kararlar ve tutanaklar",
      "02-Dilekceler": "Dilekçeler",
      "03-Tebligatlar": "Tebligatlar",
      "04-Muzekkereler-Yazismalar": "Yazışmalar",
      "06-Mali": "Mali evrak",
      "07-Vekalet-Idari": "Vekâlet ve idari",
      "08-Ekler-Diger": "Ekler",
      "09-Durusma-Zabitlari": "Duruşma zabıtları",
      "11-Sorgu-Belgeleri": "Sorgu belgeleri",
    }[value] ||
    String(value ?? "")
      .replace(/^\d+-/, "")
      .replaceAll("-", " ")
  );
}

export function uzantiAl(yol) {
  const ad = String(yol ?? "").split("/").pop() ?? "";
  const i = ad.lastIndexOf(".");
  if (i <= 0) return "";
  return ad.slice(i).toLowerCase();
}

/** Ham mdStatus + yol → gösterilecek hazırlık durumu. Asla "ok" uydurmaz. */
export function hazirlikCoz(mdStatus, yol) {
  const d = typeof mdStatus === "string" ? mdStatus : "";
  if (YAZILAN.has(d)) return d;
  if (d !== LEGACY_BIRLESIK) return "bilinmiyor";
  const uz = uzantiAl(yol);
  if (GORSEL_UZANTILAR.has(uz) || uz === ".pdf") return "gorsel";
  if (uz === ".udf") return "desteklenmiyor";
  if (uz === "" || uz === ".html" || uz === ".htm") return "bilinmiyor";
  return "desteklenmiyor";
}

// Tanınmayan değerin eski "Asıl belge" yedeği KALDIRILDI: sağlam görsel belgeyi
// de gerçekten desteklenmeyen biçimi de aynı yanlış etikete sokuyordu.
// Tanınmayan/eksik değer artık "Bilinmiyor" der ve çökmez.
export const HAZIRLIK_ETIKET = {
  ok: { metin: "Metin hazır", sinif: "good" },
  gorsel: { metin: "Görsel belge", sinif: "gorsel" },
  desteklenmiyor: { metin: "Desteklenmeyen biçim", sinif: "desteklenmiyor" },
  "arac-yok": { metin: "Dönüştürücü eksik", sinif: "arac-yok" },
  hata: { metin: "Dönüşüm hatası", sinif: "bad" },
  bekliyor: { metin: "Metin bekliyor", sinif: "" },
  bilinmiyor: { metin: "Bilinmiyor", sinif: "bilinmiyor" },
};

export function hazirlikRozet(deger) {
  return HAZIRLIK_ETIKET[deger] ?? HAZIRLIK_ETIKET.bilinmiyor;
}

export function evrakEtiketi(d) {
  return hazirlikRozet(hazirlikCoz(d?.mdStatus, d?.path));
}

/** Kullanılabilir = metin hazır + görsel. Görsel başarısızlık değildir. */
export function evrakOzeti(evraklar) {
  const liste = Array.isArray(evraklar) ? evraklar : [];
  let kullanilabilir = 0;
  for (const d of liste) {
    const h = hazirlikCoz(d?.mdStatus, d?.path);
    if (h === "ok" || h === "gorsel") kullanilabilir++;
  }
  return { toplam: liste.length, kullanilabilir };
}

/**
 * "12/31 kullanılabilir". `suzuldu` verilirse özetin HANGİ kümeyi saydığını
 * açıkça söyler — filtre açıkken sessizce görünen satırları saymak, dava
 * satırındaki tam sayıyla çelişip kullanıcıyı yanıltır.
 */
export function ozetMetni(ozet, sec = {}) {
  if (!ozet || ozet.okunamadi) return "özet okunamadı";
  const govde = `${ozet.kullanilabilir}/${ozet.toplam} kullanılabilir`;
  return sec.suzuldu ? `${govde} (görünenler)` : govde;
}

/**
 * Dava satırındaki evrak sayısı. KAYNAK MANİFEST'tir (hazirlik-ozet).
 * Registry'deki `sonEvrakSayisi` yalnız yedektir ve BAYAT olabilir (duraklamış
 * işte hiç yazılmaz, orchestrator.ts:378-380 / 491-493); yedeğe düşüldüğünde
 * bunu gizlemeyip "kayıtlı" diye işaretleriz.
 */
export function davaSayaci(c, ozet) {
  if (ozet && !ozet.okunamadi) return `${ozet.toplam} evrak`;
  return `${Number(c?.sonEvrakSayisi) || 0} evrak (kayıtlı)`;
}

/**
 * P16 — dava satırındaki sorun rozeti; gösterilecek bir şey yoksa null.
 *
 * SAYILAN kayıtları sayar, açık kayıtların tamamını değil: başlıktaki rozet,
 * sorun sekmesinin sayacı ve bu satır aynı sayıyı söylemek zorundadır
 * (ROADMAP §14 kabul ölçütü). Kaynak tek: sunucunun satır başına koyduğu
 * `sayilir` bayrağı (src/jobs/problems.ts `eylemeDonukMu`).
 */
export function davaSorunRozeti(sayac) {
  const sayilan = Number(sayac?.sayilan) || 0;
  return sayilan > 0 ? { metin: `${sayilan} sorun`, sinif: "bad" } : null;
}

/**
 * Dava satırının rozet dizisi: sayaç + (varsa) sorun + (varsa) hazırlık özeti +
 * (varsa) "N yeni". `sorun` verilmezse dizi P15c'deki hâliyle birebir aynıdır.
 */
export function davaRozetleri(c, ozet, sorun) {
  const liste = [{ metin: davaSayaci(c, ozet), sinif: "" }];
  const sorunRozet = davaSorunRozeti(sorun);
  if (sorunRozet) liste.push(sorunRozet);
  if (ozet && !ozet.okunamadi && ozet.toplam > 0)
    liste.push({
      metin: ozetMetni(ozet),
      sinif: ozet.kullanilabilir === ozet.toplam ? "good" : "",
    });
  // P15b — sayaç `hazirlik-ozet` yanıtından gelir (manifest), registry'den
  // DEĞİL: registry'de damga yok ve `sonEvrakSayisi` bayat olabilir.
  const yeni = ozet && !ozet.okunamadi ? davaYeniMetni(ozet) : null;
  if (yeni) liste.push({ metin: yeni, sinif: "yeni" });
  return liste;
}

/**
 * P15b ikizi — src/store/esitleme.ts `yeniMi`. Karar KİMLİK eşitliğiyle verilir:
 * zaman damgası (`damga.at`) yalnız gösterim içindir ve buraya HİÇ girmez.
 */
export function yeniMi(evrak, sonEsitleme) {
  const isaret = sonEsitleme?.esitlemeId;
  if (typeof isaret !== "string" || isaret === "") return null;
  if (sonEsitleme?.ilkIndirme === true) return null;
  const damga = evrak?.indirmeDamgasi;
  if (!damga || damga.esitlemeId !== isaret) return null;
  return damga.tur === "yenilenen" ? "yenilenen" : "yeni";
}

/** P15b ikizi — src/store/esitleme.ts `esitlemeSayaci`. */
export function esitlemeSayaci(evraklar, sonEsitleme) {
  const liste = Array.isArray(evraklar) ? evraklar : [];
  let yeni = 0;
  let yenilenen = 0;
  for (const e of liste) {
    const t = yeniMi(e, sonEsitleme);
    if (t === "yeni") yeni++;
    else if (t === "yenilenen") yenilenen++;
  }
  return { yeni, yenilenen };
}

// "Yeni" = portalde ilk kez görülen evrak; "Güncellendi" = arşivde kaydı olan
// ama baytları değişmiş evrak. Ayrım indirici sayaçlarıyla (yeniEvrak /
// yenilenenEvrak) AYNI ölçüttür; ikisini tek etikette toplamak "bu belgeyi
// daha önce hiç görmedim" ile "bu belge değişmiş" arasındaki farkı silerdi.
export const YENI_ETIKET = {
  yeni: { metin: "Yeni", sinif: "yeni" },
  yenilenen: { metin: "Güncellendi", sinif: "yeni" },
};

/** Evrak satırının "yeni" rozeti; rozet yoksa null. */
export function yeniRozet(d, sonEsitleme) {
  const t = yeniMi(d, sonEsitleme);
  return t === null ? null : YENI_ETIKET[t];
}

/**
 * Dava satırındaki "N yeni" metni; gösterilecek bir şey yoksa null.
 * İlk indirmede ve hiçbir şey inmediğinde null döner — "0 yeni" yazmak
 * gürültüdür, satır zaten "N evrak" diyor.
 */
export function davaYeniMetni(ozet) {
  const yeni = Number(ozet?.yeni) || 0;
  const yenilenen = Number(ozet?.yenilenen) || 0;
  const parca = [];
  if (yeni > 0) parca.push(`${yeni} yeni`);
  if (yenilenen > 0) parca.push(`${yenilenen} güncellendi`);
  return parca.length > 0 ? parca.join(" · ") : null;
}

// P15c — KAYNAK ekseni: manifest'te kayıtlı dosya bugün diskte duruyor mu?
// Hazırlık etiketinden (türetilmiş METİN) ve "yeni" rozetinden (son eşitlemede
// NE GELDİ) ayrı bir eksendir. "yok" ile "erisilemiyor" AYRI metinlerdir ve
// asla tek rozete indirilmez (T03): birine "yeniden eşitle", diğerine "diski
// bağla/izni düzelt" denir; "erişemedim"e "silinmiş" demek yanlış beyandır.
export const KAYNAK_ETIKET = {
  yok: { metin: "Eksik", sinif: "eksik" },
  erisilemiyor: { metin: "Erişilemedi", sinif: "erisilemedi" },
  kapsamDisi: { metin: "Arşiv dışı", sinif: "erisilemedi" },
};

/**
 * Kaynak rozeti; sorun yoksa null. SESSİZ VARSAYILAN: alan hiç yoksa ("var",
 * eski motor yanıtı, tanınmayan yeni bir değer) rozet ÇIKMAZ ve satır normal
 * görünür. Ölçemediğimiz bir şey için "Eksik" demek, hiç dememekten çok daha
 * pahalı bir hatadır — kullanıcı var olan belgeyi kaybolmuş sanır.
 */
export function kaynakRozet(d) {
  return KAYNAK_ETIKET[d?.kaynakDurum] ?? null;
}

/** Satır soluklaşsın ve "aç" eylemleri kapansın mı? */
export function kaynakSorunlu(d) {
  return kaynakRozet(d) !== null;
}

/**
 * Kaynağı erişilemez bir evrakta önizlemenin ÜSTÜNE konan tek satır uyarı;
 * sorun yoksa null. Metin gösterilmeye devam eder (bkz. src/server/belgeler.ts
 * "Eksik 3" kararı), ama nereden geldiği söylenir.
 */
export function kaynakUyarisi(kaynakDurum) {
  return (
    {
      yok: "Kaynak dosya arşivde yok; aşağıdaki metin daha önce üretilmiş kopyadır. Bir sonraki eşitleme dosyayı yeniden indirir.",
      erisilemiyor:
        "Kaynak dosyaya erişilemedi (izin ya da bağlı olmayan bir disk olabilir); aşağıdaki metin daha önce üretilmiş kopyadır.",
      kapsamDisi:
        "Kaynak dosya arşiv kökünün dışını gösteriyor; güvenlik gereği açılmaz. Aşağıdaki metin daha önce üretilmiş kopyadır.",
    }[kaynakDurum] ?? null
  );
}

/** Kaynak erişilemezken metin de yoksa önizlemenin boş durumu. */
export function kaynakBosluk(kaynakDurum) {
  return (
    {
      yok: [
        "Kaynak evrak arşivde yok",
        "Manifest'te kayıtlı ama dosya silinmiş ya da taşınmış. Bir sonraki eşitleme yeniden indirir.",
      ],
      erisilemiyor: [
        "Kaynak evraka erişilemedi",
        "İzin verilmemiş ya da diski bağlı olmayabilir; silindiği anlamına gelmez. Erişimi açıp yeniden deneyin.",
      ],
      kapsamDisi: [
        "Kaynak evrak arşiv kökünün dışında",
        "Kayıtlı yol arşivin dışını gösteriyor; güvenlik gereği açılmaz. Dosyayı yeniden indirin.",
      ],
    }[kaynakDurum] ?? null
  );
}

/**
 * Evrak satırının rozet dizisi.
 *
 * SIRA: "Eksik" → "Yeni" → hazırlık etiketi. Dalga 3 "Yeni" önde kalsın diye
 * öneri bıraktı ("ne değişti?" tarama hedefidir); kaynak rozeti bilerek onun da
 * ÖNÜNE alındı, çünkü tek EYLEMİ kapatan rozet odur: satır soluklaşır ve "Asıl
 * belgeyi aç" kapanır. Soluk bir satırda kullanıcının aradığı ilk şey sebeptir;
 * sebebi "Yeni"nin arkasına koymak, kapanmış düğmenin açıklamasını gizler.
 */
export function rozetler(d, sonEsitleme) {
  const liste = [];
  const kaynak = kaynakRozet(d);
  if (kaynak) liste.push(kaynak);
  const yeni = yeniRozet(d, sonEsitleme);
  if (yeni) liste.push(yeni);
  liste.push(evrakEtiketi(d));
  return liste;
}

/**
 * Ek evrakları ana evrakın altında gruplar (K08 gösterim payı).
 *
 * Veri sözleşmesi: ek kaydın `anaStableKey`i ana kaydın `stableKey`ine eşittir
 * (test/e2e.test.ts bunu kilitler). `_ekler/` yol parçası İKİNCİL bir ipucudur
 * ve gruplama anahtarı olarak KULLANILMAZ.
 *
 * İki veri durumu satırı DÜŞÜRMEZ — ikisi de hata değildir:
 *  - ana satır portal listesinde yoksa ek düz evrak olarak inmiştir
 *    (orchestrator.ts:576 `anaEvraklar.find`), grup hiç doğmaz;
 *  - ananın indirmesi başarısızsa ana kaydı manifest'e girmez ama ek girer
 *    (orchestrator.ts:552-555) → ÖKSÜZ grup. Filtre yalnız eki eşlediğinde de
 *    aynı öksüz grup çıkar; başlık metni her iki durumda da doğrudur.
 */
export function evrakGruplari(evraklar) {
  const liste = Array.isArray(evraklar) ? evraklar : [];
  const gruplar = [];
  const anaIndeks = new Map();
  for (const d of liste) {
    if (d?.isEkEvrak) continue;
    const g = { ana: d, ekler: [], oksuz: false };
    gruplar.push(g);
    const k = d?.stableKey;
    if (typeof k === "string" && k !== "" && !anaIndeks.has(k)) anaIndeks.set(k, g);
  }
  const oksuzler = new Map();
  for (const d of liste) {
    if (!d?.isEkEvrak) continue;
    const g = anaIndeks.get(d.anaStableKey);
    if (g) {
      g.ekler.push(d);
      continue;
    }
    const anahtar = String(d.anaStableKey ?? "");
    let o = oksuzler.get(anahtar);
    if (!o) {
      o = { ana: null, ekler: [], oksuz: true };
      oksuzler.set(anahtar, o);
      gruplar.push(o);
    }
    o.ekler.push(d);
  }
  return gruplar;
}

/** Grup başlığı özeti: ana + ekler birlikte sayılır. */
export function grupOzeti(grup) {
  const uyeler = [...(grup?.ana ? [grup.ana] : []), ...(grup?.ekler ?? [])];
  return evrakOzeti(uyeler);
}

export function grupBasligi(grup) {
  const adet = grup?.ekler?.length ?? 0;
  const ozet = ozetMetni(grupOzeti(grup));
  if (grup?.oksuz)
    return `Eki bulunan ana evrak bu listede yok · ${adet} ek · ${ozet}`;
  return `${adet} ek · ${ozet}`;
}

/** Önizleme boş kaldığında sebebi söyleyen metin; "yok" ile "hazır değil" ayrılır. */
export function onizlemeBosluk(hazirlik) {
  return (
    {
      gorsel: [
        "Bu evrakın metin katmanı yok",
        "Kaynak sağlam: taranmış/görsel belge. “Asıl belgeyi aç” ile kendi uygulamasında inceleyin.",
      ],
      desteklenmiyor: [
        "Bu biçimden metin çıkarılamıyor",
        "Kaynak dosya arşivde duruyor; “Klasörü aç” ile inceleyin.",
      ],
      "arac-yok": [
        "Dönüştürücü kurulu değil",
        "PDF metni için pdftotext gerekiyor (brew install poppler). Kurduktan sonra dosyayı yeniden eşitleyin.",
      ],
      hata: [
        "Dönüşüm başarısız oldu",
        "Kaynak evrak yerinde. Sorunlar ekranındaki dönüşüm kaydına bakın.",
      ],
      bekliyor: [
        "Metin henüz hazırlanmadı",
        "Dönüşüm bir sonraki eşitlemede çalışacak.",
      ],
      bilinmiyor: [
        "Bu evrakın hazırlık durumu bilinmiyor",
        "Kayıt eski ya da tanınmayan bir durum taşıyor; bir sonraki eşitleme tazeler.",
      ],
    }[hazirlik] ?? [
      "Metin önizlemesi bulunmuyor",
      "Evrakı incelemek için “Asıl belgeyi aç” düğmesini kullanın.",
    ]
  );
}
