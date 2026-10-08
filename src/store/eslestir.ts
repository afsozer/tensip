// P19 — "PORTALIN BU SATIRI MANİFEST'TE ZATEN HANGİ KAYIT?"
//
// ── NEDEN AYRI BİR MODÜL ────────────────────────────────────────────────────
// Bu soru eskiden orkestratörün içinde iki satırlık bir kapanışla yanıtlanıyordu
// (`oncekiAdaylar`) ve kusurun kaynağı oydu. Kural artık tek yerde, saf ve
// testlenebilir: girdi iki liste, çıktı BİREBİR eşleme. Dosya sistemi, portal
// ve manifest yazımı bu modüle GİRMEZ.
//
// ── ÖLÇÜLEN GERÇEKLER (12 Eylül, kullanıcının kendi dosyası) ────────────────
// 1. PORTALIN HİÇBİR KİMLİĞİ KALICI DEĞİL. Aynı oturumda arka arkaya iki
//    `list_dosya_evraklar.ajx`: `evrakId` 0/113 aynı kaldı, `ggEvrakId` de
//    0/113. `ggEvrakId` TEK BİR YANIT İÇİNDE 113/113 tekildir — kalıcı kimlik
//    sanılabilir, TUZAK BUDUR, kullanılmaz.
// 2. `birimEvrakNo` TEKİL DEĞİL (113 satır / 111 numara). Üçlüye tür+tarih
//    eklemek 112/113 yapar, tam çözmez. Aynı üçlüyü taşıyan iki satır
//    GERÇEKTEN FARKLI belge olabilir — numara tek başına kimlik SAYILMAZ,
//    iki belge tek kayda İNDİRGENMEZ.
// 3. UYAP bazı belgeleri her indirişte YENİDEN ÜRETİYOR: baytlar ve sha256
//    farklı, çıkarılan metin birebir aynı. Bu yüzden içerik hash'i "bende
//    zaten var mı" sorusunu YANITLAYAMAZ ve bu modülde hiç kullanılmaz.
//
// ── KARAR: KİMLİK SATIR BAZINDA DEĞİL, KÜME BAZINDA ────────────────────────
// Belirsiz bir grupta hangi satırın hangi kayıt olduğunu bilemeyiz — ama KAÇ
// TANE olduğunu biliriz. Portal grup için N satır bildiriyor ve manifestte o
// grupta M kayıt varsa:
//   • N <= M ise satırlar eldeki kayıtlarla EŞLEŞTİRİLİR (indirme yok, yeni
//     satır yok; kayıt yerinde doğrulanır ve KORUNAN sayılır),
//   • N > M ise grup DEĞİŞMİŞTİR ve sıra tahminine GÜVENİLMEZ (aşağıya bkz.),
//   • N < M ise fazla kayıt SİLİNMEZ (grup küçülmesi ayrı bir bulgudur; bkz.
//     `grup-sismis`, src/store/denetim.ts).
// Eşleşme bir PERMÜTASYONDUR: hangi satırın hangi kayda düştüğü değişebilir
// ama KÜME korunur — hiçbir belge kaybolmaz ve iki belge birleşmez.
//
// Eski davranışın temkini KALDIRILMADI, BEDELİ SINIRLANDI: yanlış belgeyi
// yanlış kayda iliştirmemek için grup dışına asla taşılmaz; grup içindeyse
// zaten bütün satırlar aynı numarayı, türü ve tarihi taşır.
//
// ── BÜYÜYEN GRUPTA SIRA TAHMİNİ BELGE KAYBETTİRİR (ÖLÇÜLDÜ) ────────────────
// İlk sürüm N > M olduğunda da grup içinde SIRAYLA eşliyordu ve eşleşmeyen
// satır her zaman gruptaki SON satır oluyordu. Portal yeni belgeyi listenin
// BAŞINA koyduğunda sonuç ölçüldü (izole motor + sahte portal):
//   portal [GAMA, ALFA, BETA], manifest [ALFA-kaydı, BETA-kaydı]
//   → GAMA satırı ALFA-kaydıyla eşleşti, dosyanın hash'i kaydı tuttuğu için
//     "korunan" sayıldı ve İNMEDİ; boşta kalan satır BETA oldu, YALNIZ O indi.
//   → arşivde ALFA, BETA, BETA duruyor; GAMA HİÇ İNMEDİ. Sonraki eşitleme
//     grubu doygun (N=M=3) saydığı için belge bir daha ASLA inmiyor.
// Sayı doğruydu ("1 yeni"), BELGE yanlıştı. Bu, "hiçbir gerçek belge
// kaybolmaz" sözünü iki belgeyi birleştirmekten DAHA KÖTÜ biçimde bozar.
//
// ── ÖLÇÜT BÜYÜME DEĞİL, BELİRSİZLİKTİR (P20) ───────────────────────────────
// İlk kural yalnız BÜYÜME'yi (N > M) tetikleyici sayıyordu. Boyu aynı kalıp
// bir ÜYESİ değişen grup o eleği geçiyordu ve sonuç ölçüldü (izole motor):
//   arşivde [ALFA, BETA], portal [ALFA, GAMA] → eşitleme "0 yeni, 0 eksik",
//   denetim "0 bulgu", ve GAMA HİÇ İNMİYOR. Grup doygun sayıldığı için bir
//   daha da inmiyor.
// Doğru ölçüt BELİRSİZLİKTİR: grupta iki tarafın herhangi birinde birden çok
// satır varsa hangi satırın hangi kayda düştüğü zaten TAHMİNDİR ve tahminin
// doğruluğu ancak belge inerek anlaşılır. Bu yüzden N > 1 ya da M > 1 olan her
// grubun tahminle eşleşmiş satırları `tazele`ye girer; orkestratör onlar için
// "baytı tutuyor, atla" kestirmesini KULLANMAZ ve hepsini indirir.
//
// BEDELİ NEDEN SINIRSIZ DEĞİL: indirmek YAZMAK DEĞİLDİR. İnen içeriğin metni
// gruptaki bir kaydın metnini birebir tutuyorsa o kayıt ve DOSYASI olduğu gibi
// korunur — tek bayt yazılmaz, sayaç "korunan" der (bkz. src/store/tazeleme.ts).
// Yalnız gerçekten TANINMAYAN içerik yazılır, o da eşleşen kaydın YOLUNA. Yani
// belirsiz grup her eşitlemede yeniden İNER ama arşiv büyümez (ölçüldü: üç
// eşitlemede kayıt ve dosya sayısı sabit, yeni=0, yenilenen=0).
//
// TEKİL grup (N == M == 1) bu kapsamın DIŞINDADIR ve bilerek: orada
// (birimEvrakNo, tür, tarih) üçlüsü portalın verebildiği en yakın kimliktir
// (gerçek dosyada 112/113 tekil) ve kapsama alınması, arşivin TAMAMINI her
// eşitlemede yeniden indirmek demektir. Sınır README'de yazılıdır.
//
// Kimlikle (0. geçiş) eşleşen satır `tazele`ye GİRMEZ: portal kalıcı kimlik
// döndürüyorsa tahmin yoktur, yeniden indirme de gereksizdir.

import type { ManifestEvrak } from "./manifest.js";

/**
 * Bir satırın (portal ya da manifest) eşleşme kimliği.
 *
 * `grup` null ise satır KÜME eşleşmesine hiç girmez ve eski davranış aynen
 * sürer (yalnız `evrakId` üzerinden eşleşir). Numarasız ana evrak bilerek
 * buraya düşer: orada "kaç tane olmalı" ölçülemez, tahmin edilirse iki farklı
 * belge birbirinin yerine geçebilir.
 */
export interface EsAnahtari {
  evrakId: string;
  grup: string | null;
  /** Grup içi ikincil ayırt edici (gönderen + tip). Kimlik DEĞİL, ipucu. */
  ikincil: string;
}

export interface GrupOlcumu {
  /** Portalin bu grup için bildirdiği satır sayısı. */
  portal: number;
  /** Manifestte bu grupta duran kayıt sayısı. */
  manifest: number;
  /** Eşleştirilebilen satır sayısı. */
  eslesen: number;
}

export interface EslesmeSonucu {
  /** Portal satır indeksi → o satıra ayrılan manifest kaydı. Birebirdir. */
  esler: Map<number, ManifestEvrak>;
  /** Grup anahtarı → ölçüm. Yalnız gruplanabilen satırlar sayılır. */
  gruplar: Map<string, GrupOlcumu>;
  /**
   * BELİRSİZ grubun (N > 1 ya da M > 1) satır indeksleri: eşleşmeleri SIRA
   * TAHMİNİNE dayanıyor, bu yüzden içerik yerinde doğrulanmış sayılamaz ve
   * İNDİRİLMELERİ gerekir.
   *
   * `esler` yine doludur — indirilen içerik TANINMAZSA bu kayıtların YERİNE
   * yazılır; yeni yol açmak manifesti ve diski şişirir.
   */
  tazele: Set<number>;
}

export interface EslesmeGirdisi {
  anahtar: EsAnahtari;
  kayit: ManifestEvrak;
}

/**
 * Portal satırlarını manifest kayıtlarıyla BİREBİR eşler.
 *
 * Üç geçiş, sırayla — her geçiş yalnız HENÜZ KULLANILMAMIŞ kayıtları alır:
 *   0. `evrakId` birebir aynı (portal kimliği dönmüyorsa her şey burada biter).
 *      Aynı kimliği taşıyan iki kayıt varsa eşleşme YAPILMAZ: belirsizlikte
 *      tahmin etmek yanlış kaydı ezmekten daha kötüdür.
 *   1. Grup içinde `ikincil` (gönderen + tip) birebir aynı — metadata'nın
 *      satırlar arasında karışmasını önler.
 *   2. Grup içinde sıra. Grup tanımı gereği bütün satırların numarası, türü ve
 *      tarihi aynıdır; kalan fark yalnız hangi kopyanın hangi kayda düştüğüdür.
 */
export function evraklariEslestir(
  portal: readonly EsAnahtari[],
  kayitlar: readonly EslesmeGirdisi[],
): EslesmeSonucu {
  const esler = new Map<number, ManifestEvrak>();
  const kullanilan = new Set<ManifestEvrak>();
  const kimlikEsledi = new Set<number>();
  const tazele = new Set<number>();

  // ── 0. geçiş: kimlik birebir ───────────────────────────────────────────────
  const kimlikDizini = new Map<string, EslesmeGirdisi[]>();
  for (const g of kayitlar) {
    const liste = kimlikDizini.get(g.anahtar.evrakId) ?? [];
    liste.push(g);
    kimlikDizini.set(g.anahtar.evrakId, liste);
  }
  portal.forEach((p, i) => {
    const liste = kimlikDizini.get(p.evrakId);
    if (liste === undefined || liste.length !== 1) return;
    const tek = liste[0]!.kayit;
    if (kullanilan.has(tek)) return;
    esler.set(i, tek);
    kullanilan.add(tek);
    kimlikEsledi.add(i);
  });

  // ── gruplar ────────────────────────────────────────────────────────────────
  const portalGruplari = new Map<string, number[]>();
  portal.forEach((p, i) => {
    if (p.grup === null) return;
    const liste = portalGruplari.get(p.grup) ?? [];
    liste.push(i);
    portalGruplari.set(p.grup, liste);
  });
  const kayitGruplari = new Map<string, EslesmeGirdisi[]>();
  for (const g of kayitlar) {
    if (g.anahtar.grup === null) continue;
    const liste = kayitGruplari.get(g.anahtar.grup) ?? [];
    liste.push(g);
    kayitGruplari.set(g.anahtar.grup, liste);
  }

  const gruplar = new Map<string, GrupOlcumu>();
  for (const [anahtar, indeksler] of portalGruplari) {
    const adaylar = kayitGruplari.get(anahtar) ?? [];
    const bosta = () => adaylar.filter((a) => !kullanilan.has(a.kayit));

    // 1. geçiş — ikincil alan birebir
    for (const i of indeksler) {
      if (esler.has(i)) continue;
      const uygun = bosta().find((a) => a.anahtar.ikincil === portal[i]!.ikincil);
      if (uygun === undefined) continue;
      esler.set(i, uygun.kayit);
      kullanilan.add(uygun.kayit);
    }
    // 2. geçiş — sırayla
    for (const i of indeksler) {
      if (esler.has(i)) continue;
      const uygun = bosta()[0];
      if (uygun === undefined) continue;
      esler.set(i, uygun.kayit);
      kullanilan.add(uygun.kayit);
    }
    // GRUP BELİRSİZ → sıra tahminine güvenilmez, eşleşen satırlar İNDİRİLİR.
    // Ölçüt BÜYÜME DEĞİL BELİRSİZLİKTİR (P20; gerekçe ve ölçüm yukarıda).
    // Yalnız TAHMİNE dayanan eşleşmeler girer:
    //   • eşleşmemiş satır zaten indirilecek (tutunacağı kayıt yok),
    //   • kimlikle (0. geçiş) eşleşen satırda tahmin yoktur — portal kalıcı
    //     kimlik döndürüyorsa maliyet boşuna ödenmez.
    if (indeksler.length > 1 || adaylar.length > 1) {
      for (const i of indeksler) if (esler.has(i) && !kimlikEsledi.has(i)) tazele.add(i);
    }
    gruplar.set(anahtar, {
      portal: indeksler.length,
      manifest: adaylar.length,
      eslesen: indeksler.filter((i) => esler.has(i)).length,
    });
  }
  return { esler, gruplar, tazele };
}

/** Grup ölçümlerinin özeti — olay günlüğüne yalnız SAYI yazılır. */
export function grupOzeti(gruplar: Map<string, GrupOlcumu>): {
  grup: number;
  belirsiz: number;
  doygun: number;
  eksik: number;
  fazla: number;
} {
  let belirsiz = 0;
  let doygun = 0;
  let eksik = 0;
  let fazla = 0;
  for (const o of gruplar.values()) {
    if (o.portal > 1 || o.manifest > 1) belirsiz++;
    if (o.manifest >= o.portal && o.eslesen === o.portal) doygun++;
    if (o.portal > o.manifest) eksik += o.portal - o.manifest;
    if (o.manifest > o.portal) fazla += o.manifest - o.portal;
  }
  return { grup: gruplar.size, belirsiz, doygun, eksik, fazla };
}

/**
 * P19 — bir manifest kaydının eşleşme anahtarı.
 *
 * `src/jobs/orchestrator.ts` içindeki `portalAnahtari`nin AYNASIDIR: ölçüt iki
 * yerde ayrı yazılsaydı eşleştirici bir kayıt seçer, `oncekiEvrakBul` onu
 * reddeder ve belge sessizce yeniden inerdi.
 *
 * Denetim (`src/store/denetim.ts`) ve sadeleştirme (`src/store/sisme.ts`) de
 * "aynı grup" tanımını buradan alır; grup tanımı ürün genelinde TEKTİR.
 */
export function kayitAnahtari(k: ManifestEvrak): EsAnahtari {
  const ikincil = `${k.gonderen}\u0000${k.tip ?? ""}`;
  if (k.isEkEvrak !== true) {
    return {
      evrakId: k.evrakId,
      grup: k.birimEvrakNo ? `ana\u0000${k.birimEvrakNo}\u0000${k.tur}\u0000${k.tarih}` : null,
      ikincil,
    };
  }
  const sira = ekSirasi(k);
  if (k.anaStableKey === undefined || sira === null)
    return { evrakId: k.evrakId, grup: null, ikincil };
  return {
    evrakId: k.evrakId,
    grup: `ek\u0000${k.anaStableKey}\u0000${sira}\u0000${k.tur}\u0000${k.tarih}`,
    ikincil,
  };
}

/** `stableKeyEk` sonundaki sıra numarası; okunamıyorsa null. */
function ekSirasi(k: ManifestEvrak): number | null {
  const i = typeof k.stableKey === "string" ? k.stableKey.lastIndexOf(":") : -1;
  if (i < 0) return null;
  const n = Number(k.stableKey.slice(i + 1));
  return Number.isFinite(n) ? n : null;
}
