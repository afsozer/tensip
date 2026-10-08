// P06a — DENETİM SEKMESİ. İndirilenler ekranının üçüncü sekmesi
// (Evraklar | Sorunlar | Denetim). Yeni ekran açılmadı: P16'nın sekme
// altyapısı zaten orta sütunda duruyor.
//
// ── İKİ KURAL ───────────────────────────────────────────────────────────────
// 1. DENETİM KENDİLİĞİNDEN KOŞMAZ. Sekmeye girmek, dava seçmek, `poll` turu —
//    hiçbiri denetim başlatmaz; kullanıcı "Denetle" düğmesine basar (P18a'daki
//    düğme disiplini). Gerekçe: denetim bütün arşivi disk üzerinden okur;
//    kullanıcı istemeden koşan bir tarama, ekran değiştirmenin bedelini
//    saniyelere çıkarır.
// 2. ONARIM DÜĞMESİ YALNIZ ONARILABİLİR BULGUDA ÇİZİLİR (P06b). Karar burada
//    verilmez: motor her bulguyla birlikte `onarim` alanını gönderir
//    (src/store/onarim.ts `ONARIM_TABLOSU`). `eylem` null ise düğme ÇİZİLMEZ
//    ve sebebi satırda yazılır — onarılamayanı onarılabilir göstermek
//    ROADMAP §4'ün açık kararının ihlalidir. TOPLU "hepsini onar" düğmesi
//    YOKTUR: seçim kullanıcınındır, satır satır.
// 3. HİÇBİR EYLEM TEK TIKLA UYGULANMAZ. İlk tık YENİDEN ÖLÇÜLMÜŞ planı
//    getirir (tek bayt değişmez), ikinci tık onaylar — `sadelestir` (P19b) ile
//    aynı kalıp.
//
// ── SINIFLAMA SUNUCUDA ──────────────────────────────────────────────────────
// P15c/P16 kalıbı: bulgunun türü, EKSENİ ve ağırlığı motorda hesaplanır
// (src/store/denetim.ts) ve satırla birlikte gelir; burası yalnız etikete
// çevirir. Kaynak hatası ile "metin çıkarılamıyor" AYNI KIRMIZIYA
// SIKIŞTIRILMAZ — gruplama `eksen` alanına göredir.
import { $, escape, state, api, empty, date, action, toast, updatePending } from "./ortak.js";

export const DENETIM_TUR_ETIKET = {
  "manifest-yok": "Kayıt yok",
  "manifest-bozuk": "Kayıt bozuk",
  "manifest-erisilemiyor": "Kayıt okunamadı",
  "kayit-bozuk": "Satır eksik",
  "kayitlar-eksik": "Kayıtlar boşalmış",
  "mukerrer-kayit": "Mükerrer kayıt",
  "yol-cakismasi": "Çelişen kayıt",
  // P19 — mükerrer kayıttan AYRI etiket: orada satırlar bayt bayt aynıdır,
  // burada baytlar farklı ama belge aynı belgedir (UYAP her indirişte yeniden
  // üretiyor). Aynı etikete sıkıştırılsaydı kullanıcı "arıza değildir" notunu
  // buna da uygular ve sınırsız büyüyen manifesti zararsız sanardı.
  "grup-sismis": "Aynı belge birden çok kayıt",
  // P19 (inceleme) — şişmeden AYRI etiket: orada fazladan kayıt vardır,
  // burada kayıt sayısı DOĞRUDUR ama iki kayıt aynı indirmenin kopyasıdır,
  // yani grubun başka bir belgesi eksik olabilir. "Fazlalık" demek kullanıcıyı
  // yanlış işe (sadeleştirme) yönlendirirdi; doğru iş yeniden eşitlemektir.
  "grup-ikiz": "Aynı indirme iki kayıt",
  "grup-olculemez": "Numarasız evrak birikmiş",
  "klasor-yok": "Klasör yok",
  "klasor-erisilemiyor": "Klasör okunamadı",
  "kayitsiz-klasor": "Listede olmayan dosya",
  "kaynak-yok": "Belge yok",
  "kaynak-erisilemiyor": "Belge okunamadı",
  "hash-uyusmuyor": "İçerik değişmiş",
  "olculmedi-buyuk": "Ölçülmedi (çok büyük)",
  "kapsam-disi": "Arşiv dışı",
  // P06c — "Kayıtsız dosya" ile AYNI ETİKETE SIKIŞTIRILMAZ: kayıtsız dosya
  // tamamlanmış bir belgedir (çöp değildir, ağırlığı bilgi), bu ise yarıda
  // kalmış bir YAZIMDIR ve hedef belge eksik olabilir.
  "yarim-yazim": "Yarım kalmış yazım",
  // P06c (inceleme) — "Yarım kalmış yazım" ile AYNI ETİKETE SIKIŞTIRILMAZ:
  // orada hedef belge eksik olabilir ve kullanıcıdan iş bekler, burada hedef
  // yerinde ve kaydıyla birebirdir; geriye yalnız silinebilir bir artık kalır.
  "yarim-yazim-artigi": "Artık dosya (hedef sağlam)",
  "turev-yok": "Hazır metin yok",
  "turev-erisilemiyor": "Hazır metin okunamadı",
  "yetim-dosya": "Kayıtsız dosya",
};

/**
 * Eksenler ve GÖSTERİM SIRASI. Sıra rastgele değil: kullanıcının "belgem
 * duruyor mu" sorusu önce gelir, türetilmiş metin sonra; kayıtsız dosyalar
 * en sonda çünkü onlar bir arıza değil.
 */
export const DENETIM_EKSENLERI = [
  {
    eksen: "kaynak",
    baslik: "Asıl belgeler",
    not: "Belgenin kendisiyle ilgili bulgular.",
  },
  {
    eksen: "turev",
    baslik: "Hazır metinler",
    not: "Belgeden üretilen metinle ilgili; asıl belge bundan etkilenmez.",
  },
  {
    // P06c — AYRI GRUP. "Kayıtsız dosyalar" başlığının altına konsaydı, o
    // grubun "bunlar arıza değildir" cümlesiyle aynı kefeye girerdi; oysa
    // yarım kalmış yazım tam da arızanın kendisidir: bir iş kesilmiş ve hedef
    // belge eski hâlinde kalmış olabilir.
    eksen: "yarim",
    baslik: "Yarım kalmış yazımlar",
    // P06c (inceleme) — GRUP NOTU DA AĞIRLIKTAN TÜRETİLİR. Sabit not "asıl
    // soru hedef belgenin durumudur" diyordu; kullanıcı hedefi tamamladıktan
    // sonra bu cümle hâlâ cevaplanmamış bir soru vaat ediyordu. Bütün satırlar
    // kapanmışsa grup artık bir iş listesi değildir.
    not: "Bir yazım kesilmiş ama hedef belgeler yerinde ve kayıtlarıyla birebir. Geriye kalan artıklar belge değildir, yalnız yer kaplar. Denetim hiçbirine dokunmaz.",
    bulguluNot:
      "Bir yazım tamamlanmadan kesilmiş. Bu artıklar belge değildir; asıl soru hedef belgenin durumudur. Denetim hiçbirine dokunmaz.",
  },
  {
    eksen: "kayit",
    baslik: "Dosya kaydı",
    not: "Manifest satırlarıyla ilgili bulgular.",
  },
  {
    eksen: "klasor",
    baslik: "Klasörler",
    not: "Dava klasörü ve arşiv düzeniyle ilgili bulgular.",
  },
  {
    eksen: "yetim",
    baslik: "Kayıtsız dosyalar",
    not: "Bunlar arıza değildir: korunmuş eski bir kaynak olabilir. Denetim hiçbirine dokunmaz.",
    // İNCELEMEDE YAKALANDI: bu eksen yalnız zararsız kayıt taşımıyor. Arşivin
    // dışını gösteren bağlantı (kapsam-disi) da buraya düşüyor ve agirlik
    // "bulgu". Grup notu sabit olduğu için en dikkat çekmesi gereken satır
    // "bunlar arıza değildir" başlığı altında eleniyordu.
    bulguluNot:
      "Bir kısmı arıza: aşağıdaki satırların rozetine bakın. Kalanı zararsızdır — kayıtsız dosya çöp değildir, korunmuş eski bir kaynak olabilir. Denetim hiçbirine dokunmaz.",
  },
];

/**
 * Bulguları eksenlerine göre, sabit sırayla böler. Boş eksen düşer.
 *
 * NOT AĞIRLIKTAN TÜRETİLİR, sabit değildir: bir eksende arıza sayılan
 * (agirlik "bulgu") satır varsa o eksenin "bunlar arıza değildir" cümlesi
 * KURULMAZ. Tek bir ekseni elle düzeltmek yetmezdi — kural sınıfı kapatır:
 * ileride hangi eksene hangi tür düşerse düşsün, not satırların gerçek
 * ağırlığını anlatır.
 */
export function denetimGruplari(bulgular) {
  const liste = Array.isArray(bulgular) ? bulgular : [];
  return DENETIM_EKSENLERI.map(({ bulguluNot, ...e }) => {
    const satirlar = liste.filter((b) => b?.eksen === e.eksen);
    const ariza = satirlar.some((b) => b?.agirlik === "bulgu");
    return { ...e, satirlar, not: ariza && bulguluNot ? bulguluNot : e.not };
  }).filter((g) => g.satirlar.length > 0);
}

/** Hash gibi uzun değerler satırı taşırmasın: baştan 12 hane yeter. */
export function kisaHash(v) {
  const s = String(v ?? "");
  return s.length > 12 ? `${s.slice(0, 12)}…` : s;
}

export function boyutMetni(bayt) {
  const n = Number(bayt);
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Bir bulgunun onarım kartının anahtarı; onarılamaz bulguda null.
 * Aynı anda YALNIZ BİR kart açıktır: iki satırın planı ekranda yan yana
 * durursa kullanıcı hangisini onayladığını karıştırır.
 */
export function onarimAnahtari(b) {
  const eylem = b?.onarim?.eylem;
  return eylem ? `${b?.caseKey ?? ""}\u0000${b?.yol ?? ""}\u0000${eylem}` : null;
}

/**
 * Plan/sonuç gövdesinden tek cümle. `sadelestir` ayrı bir yanıt şekli döndürür
 * (P19b planı); burada TEK bir cümleye çevrilir ki satır üç ayrı biçim
 * göstermesin.
 */
export function onarimOzetMetni(eylem, veri) {
  if (!veri) return "";
  if (eylem !== "sadelestir") return String(veri.aciklama ?? "");
  const once = Number(veri.once) || 0;
  const sonra = Number(veri.sonra) || 0;
  const dusen = Math.max(0, once - sonra);
  // KAPSAM CÜMLEDE YAZILI: satır düğmesi yalnız kendi grubunu sadeleştirir
  // (motor `hedefYol` ile bunu bildirir), Evraklar ekranındaki düğme davanın
  // tamamını. Aynı sayıyı iki farklı kapsam için yazmak yanıltıcı olurdu.
  const kapsam = veri.hedefYol ? "Bu satırın grubundan " : "";
  if (veri.uygulandi)
    return `${kapsam}${dusen} fazla kayıt manifestten düştü (${once} → ${sonra}); belge dosyalarına dokunulmadı.`;
  if (dusen === 0)
    return String(
      veri.not ?? "Düşürülebilecek fazla kayıt ölçülemedi; hiçbir satır değişmeyecek.",
    );
  return `${kapsam}${dusen} fazla kayıt manifestten düşecek (${once} → ${sonra}); belge dosyaları SİLİNMEZ, manifest önce yedeklenir.`;
}

/** Plan uygulanabilir mi? İki yanıt şeklinin tek ölçütü. */
export function onarimYapilabilirMi(eylem, veri) {
  if (!veri) return false;
  if (eylem === "sadelestir") return (Number(veri.once) || 0) - (Number(veri.sonra) || 0) > 0;
  return veri.yapilabilir === true;
}

/**
 * Satırın eylem alanı. ÜÇ DURUM: düğme yok (onarılamaz, sebebi yazılı),
 * kapalı düğme, açık onay kartı.
 *
 * SESSİZ VARSAYILAN: `onarim` alanı HİÇ gelmeyen satırda (eski motor yanıtı)
 * düğme çizilmez ve "onarılamaz" damgası da VURULMAZ — ölçemediğimiz bir şey
 * için kullanıcıya iddia kurmayız.
 */
export function onarimAlaniHTML(b, indeks, kart) {
  const o = b?.onarim;
  if (!o) return "";
  if (!o.eylem)
    return o.sebep
      ? `<p class="subtle onarim-yok">Bu bulgu onarılamaz: ${escape(o.sebep)}</p>`
      : "";
  const acik = kart && kart.anahtar === onarimAnahtari(b);
  if (!acik)
    return `<div class="row spread wrap onarim-eylem"><span class="subtle">${escape(o.sebep)}</span><button data-onar="${Number(indeks)}" data-onar-asama="plan">${escape(o.etiket)}</button></div>`;
  if (kart.asama === "calisiyor")
    return `<p class="subtle onarim-karti">Ölçülüyor…</p>`;
  if (kart.asama === "hata")
    return `<div class="notice error onarim-karti" role="alert">${escape(kart.hata)}<div class="actions"><button data-onar="${Number(indeks)}" data-onar-asama="kapat" class="quiet">Kapat</button></div></div>`;
  const metin = onarimOzetMetni(o.eylem, kart.veri);
  if (kart.asama === "sonuc")
    return `<div class="notice onarim-karti" role="status">${escape(metin)}<div class="actions"><button data-onar="${Number(indeks)}" data-onar-asama="kapat" class="quiet">Kapat</button></div></div>`;
  const uygun = onarimYapilabilirMi(o.eylem, kart.veri);
  return `<div class="notice onarim-karti" role="status">${escape(metin)}<div class="actions">${
    uygun
      ? `<button data-onar="${Number(indeks)}" data-onar-asama="onayla">Onayla</button>`
      : ""
  }<button data-onar="${Number(indeks)}" data-onar-asama="kapat" class="quiet">${uygun ? "Vazgeç" : "Kapat"}</button></div></div>`;
}

/**
 * Tek bulgunun HTML'i. Saf: girdi kayıt, çıktı dize.
 *
 * `indeks` satırın `sonuc.bulgular` içindeki yeridir ve düğmenin tek
 * kimliğidir: opak yol ya da caseKey HTML özniteliğine kaçırılmaz.
 */
export function bulguSatiri(b, indeks = -1, kart = null) {
  const tur = DENETIM_TUR_ETIKET[b?.tur] ?? b?.tur ?? "Bulgu";
  const bilgi = b?.agirlik === "bilgi";
  const rozetler = [
    `<span class="tag ${bilgi ? "bilinmiyor" : "bad"}">${escape(tur)}</span>`,
    b?.errno ? `<span class="tag">${escape(b.errno)}</span>` : "",
    b?.adet ? `<span class="tag">${escape(String(b.adet))} kayıt</span>` : "",
    b?.boyut ? `<span class="tag">${escape(boyutMetni(b.boyut))}</span>` : "",
  ].join("");
  const hash =
    b?.beklenen && b?.olculen
      ? `<p class="subtle">kayıtlı özet ${escape(kisaHash(b.beklenen))} · ölçülen ${escape(kisaHash(b.olculen))}</p>`
      : "";
  return `<article class="job denetim-bulgu"><div class="row spread wrap"><strong class="job-title">${escape(b?.yol ?? "—")}</strong><span class="row wrap">${rozetler}</span></div><p>${escape(b?.aciklama ?? "")}</p>${hash}<p class="subtle">${escape(b?.dava ?? "")}</p>${onarimAlaniHTML(b, indeks, kart)}</article>`;
}

/**
 * Sekme altındaki özet satırı. Kısmi sonuç ASLA "temiz" denmez: `tamamlandi`
 * false ise cümle "temiz" kelimesini hiç kullanmaz ve neyin ölçülemediğini
 * söyler. 31 belgeli tek bir davaya bakıp bütün arşivi sağlam ilan etmeme
 * kuralı da buradan gelir — cümle KAÇ davanın denetlendiğini yazar.
 */
export function denetimOzetMetni(sonuc) {
  if (!sonuc) return "Denetim henüz çalıştırılmadı.";
  const s = sonuc.sayilar ?? {};
  const denetlenen = Number(s.denetlenen) || 0;
  const dava = Number(s.dava) || 0;
  const kapsam = sonuc.kapsam?.tumArsiv ? "Tüm arşiv" : "Seçili dosya";
  const olculen = `${kapsam}: ${denetlenen}/${dava} dosya denetlendi · ${Number(s.kayit) || 0} kayıt · ${Number(s.saglam) || 0} belge özetiyle birebir.`;
  const bulgu = Number(s.bulgu) || 0;
  const bilgi = Number(s.bilgi) || 0;
  // "Bulgu yok" cümlesi ancak SAYILAN HER KAYIT özetiyle karşılaştırıldıysa
  // kurulabilir. Bir kayıt arıza üretmeden de doğrulanmamış kalabilir —
  // örneğin dosya tavanını aşan belge `olculmedi-buyuk` (bilgi) olur ve
  // sağlam SAYILMAZ. O hâlde bulgu sayısı 0'dır ama "arşivim sağlam" DEĞİLDİR;
  // cümle kaç kaydın karşılaştırılamadığını söyler.
  const dogrulanmayan = Math.max(0, (Number(s.kayit) || 0) - (Number(s.saglam) || 0));
  if (!sonuc.tamamlandi)
    return `${olculen} SONUÇ KISMİ — ${sonuc.kismiSebep || "kapsamın tamamı ölçülemedi."} Bu rapora bakarak arşivin tamamı sağlam sayılamaz.`;
  if (bulgu === 0 && dogrulanmayan > 0)
    return `${olculen} Arıza bulgusu yok ama ${dogrulanmayan} kayıt özetiyle karşılaştırılamadı${bilgi > 0 ? ` (${bilgi} bilgi kaydı)` : ""}; bu sonuç “sağlam” demek değildir.`;
  if (bulgu === 0 && bilgi === 0) return `${olculen} Bulgu yok.`;
  if (bulgu === 0)
    return `${olculen} Bulgu yok; ${bilgi} bilgi kaydı var (arıza değil).`;
  return `${olculen} ${bulgu} bulgu${bilgi > 0 ? ` · ${bilgi} bilgi kaydı (arıza değil)` : ""}.`;
}

/** Sekme etiketindeki kısa sayaç. Denetim koşmadıysa boştur — sayı uydurulmaz. */
export function denetimSekmeSayaci(sonuc) {
  const n = Number(sonuc?.sayilar?.bulgu);
  return Number.isFinite(n) && n > 0 ? `(${n})` : "";
}

/** Denetlenemeyen/atlanan dosyaların satırı; boşsa boş dize. */
export function atlananlarHTML(sonuc) {
  const liste = (sonuc?.davalar ?? []).filter((d) => d?.durum !== "denetlendi");
  if (!liste.length) return "";
  const satirlar = liste
    .map(
      (d) =>
        `<li>${escape(d?.dava ?? "")} — ${escape(d?.not ?? "denetlenemedi")}</li>`,
    )
    .join("");
  return `<div class="notice" role="status"><strong>Denetlenemeyen dosyalar</strong><ul class="batch-results">${satirlar}</ul></div>`;
}

/**
 * Sonuç ekranının tamamı.
 *
 * ONARIM DÜĞMESİ YALNIZ ONARILABİLİR SATIRDA çizilir (karar motordan gelir).
 * Kapanış satırı bu sürümün ne yapıp NE YAPMADIĞINI söyler: toplu onarım,
 * silme, taşıma ve manifest yeniden kurma YOKTUR.
 */
export function denetimSonucHTML(sonuc, kart = null) {
  if (!sonuc)
    return empty(
      "Denetim çalıştırılmadı",
      "“Denetle”ye basın: arşivdeki belgeler kayıtlarıyla karşılaştırılır. Denetim yalnız okur, hiçbir dosyayı değiştirmez ve UYAP’a bağlanmaz.",
    );
  const gruplar = denetimGruplari(sonuc.bulgular);
  const bas = atlananlarHTML(sonuc);
  if (!gruplar.length)
    return `${bas}${empty(
      sonuc.tamamlandi ? "Bulgu yok" : "Denetlenebilen kısımda bulgu yok",
      sonuc.tamamlandi
        ? "Denetlenen bütün kayıtların belgesi yerinde ve içeriği kayıtlı özetiyle birebir."
        : "Kapsamın tamamı ölçülemedi; bu sonuç arşivin tamamı için “sağlam” demek değildir.",
    )}`;
  // İNDEKS `sonuc.bulgular` içindeki yerdir: düğme yalnız bu sayıyı taşır,
  // opak yol ve caseKey HTML özniteliğine kaçmaz.
  const liste = Array.isArray(sonuc.bulgular) ? sonuc.bulgular : [];
  const govde = gruplar
    .map(
      (g) =>
        `<section class="denetim-grup"><h3>${escape(g.baslik)} <span class="subtle">${g.satirlar.length}</span></h3><p class="subtle">${escape(g.not)}</p>${g.satirlar.map((b) => bulguSatiri(b, liste.indexOf(b), kart)).join("")}</section>`,
    )
    .join("");
  return `${bas}${govde}<p class="subtle denetim-onarim-notu">Onarım satır satır ve onayla yapılır: “hepsini onar” düğmesi yoktur. Bu sürümde dosya silme, klasör taşıma ve dosya kaydını yeniden kurma yoktur.</p>`;
}

/** Kapsam düğmesi: dava seçili değilse her zaman tüm arşiv. */
export function denetimKapsamiDava() {
  return state.denetimKapsam === "dava" && Boolean(state.selectedCase);
}

/**
 * Sekmeyi çizer. Kapsayıcı yoksa (ekran açık değil) hiçbir şeye dokunmaz —
 * ekran değiştirip dönen kullanıcı için güvenlidir.
 */
export function denetimCiz() {
  const kok = $("#denetim-liste");
  if (!kok) return;
  const davaKapsami = denetimKapsamiDava();
  if ($("#denetim-sayaci"))
    $("#denetim-sayaci").textContent = denetimSekmeSayaci(state.denetim);
  if ($("#denetim-ozet"))
    $("#denetim-ozet").textContent = state.denetimHata
      ? state.denetimHata
      : denetimOzetMetni(state.denetim);
  if ($("#denetim-kapsam")) {
    const dugme = $("#denetim-kapsam");
    dugme.disabled = !state.selectedCase;
    dugme.textContent = davaKapsami ? "Tüm arşivi denetle" : "Yalnız seçili dosya";
  }
  if ($("#denetim-at"))
    $("#denetim-at").textContent = state.denetim
      ? `Son denetim: ${date(state.denetim.at)} · ${Math.round(Number(state.denetim.sureMs) || 0)} ms`
      : "";
  kok.innerHTML = state.denetimSuruyor
    ? empty("Denetim sürüyor…", "Arşivdeki belgeler kayıtlarıyla karşılaştırılıyor.", true)
    : denetimSonucHTML(state.denetim, state.onarim);
  kok.querySelectorAll("[data-onar]").forEach((dugme) => {
    dugme.onclick = () => onarimTikla(dugme);
  });
  updatePending();
}

/**
 * P06b — ONARIM DÜĞMESİ. İki aşamalı: `plan` tek bayt değiştirmez, `onayla`
 * uygular. Hangi RPC'nin çağrılacağı MOTORUN kararından (`b.onarim.eylem`)
 * türetilir; burada ikinci bir eşleme tablosu YOKTUR.
 */
export async function onarimTikla(dugme) {
  const bulgular = state.denetim?.bulgular ?? [];
  const b = bulgular[Number(dugme.dataset.onar)];
  const eylem = b?.onarim?.eylem;
  if (!eylem) return;
  const asama = dugme.dataset.onarAsama;
  if (asama === "kapat") {
    state.onarim = null;
    denetimCiz();
    return;
  }
  const anahtar = onarimAnahtari(b);
  return action(dugme, async () => {
    state.onarim = { anahtar, asama: "calisiyor", veri: null, hata: null };
    denetimCiz();
    try {
      const onay = asama === "onayla";
      const veri =
        eylem === "sadelestir"
          ? // SATIRIN YOLU GÖNDERİLİR: sadeleştirme yalnız BU grubu düşürür.
            // Yol gönderilmediğinde motor dava geneli çalışır ve kullanıcının
            // seçmediği grupların kayıtları da düşerdi (ÖLÇÜLDÜ, 13 Eylül).
            await api("sadelestir", { caseKey: b.caseKey, yol: b.yol, onay })
          : await api("onar", { caseKey: b.caseKey, yol: b.yol, eylem, onay });
      state.onarim = { anahtar, asama: onay ? "sonuc" : "plan", veri, hata: null };
      if (onay) {
        toast(onarimOzetMetni(eylem, veri));
        // UYGULANAN ONARIMDAN SONRA RAPOR BAYATLAR. Bayat rapordan onarım
        // yapılmaz (motor da reddeder); ekranda eski hâlini bırakmak
        // kullanıcıyı düzelmiş bir satıra yeniden basmaya davet ederdi.
        // Bu, "denetim kendiliğinden koşmaz" kuralının istisnası DEĞİL:
        // ölçümü kullanıcının kendi onayı tetikledi. AĞ onarımı bir İŞTİR ve
        // burada henüz bitmemiştir — orada rapor tazelenmez, kullanıcı iş
        // bitince "Denetle"ye basar.
        if (!veri?.isId) await denetimOlc();
      }
    } catch (e) {
      state.onarim = {
        anahtar,
        asama: "hata",
        veri: null,
        hata: e?.message || "Onarım tamamlanamadı.",
      };
      throw e;
    } finally {
      denetimCiz();
    }
  });
}

/**
 * Denetimi ÇALIŞTIRIR — yalnız düğmeden çağrılır. Portala istek atmaz ve
 * oturum aramaz: motor yalnız yerel dosya sistemine bakar.
 */
export async function denetimiCalistir(dugme) {
  return action(dugme, () => denetimOlc());
}

/**
 * Denetimi ÖLÇER. Tek çağrı noktası: düğme ve uygulanan onarım sonrası
 * tazeleme aynı yoldan geçer, yoksa iki ayrı "denetle" yolu doğar ve biri
 * kapsamı ötekinden farklı okur.
 */
async function denetimOlc() {
  const davaKapsami = denetimKapsamiDava();
  state.denetimSuruyor = true;
  state.denetimHata = null;
  denetimCiz();
  try {
    state.denetim = await api(
      "arsiv-denetle",
      davaKapsami ? { caseKey: state.selectedCase } : {},
    );
  } catch (e) {
    // ELDEKİ RAPOR KORUNUR: başarısız bir deneme önceki sonucu SİLMEZ.
    state.denetimHata = e?.message || "Denetim tamamlanamadı.";
    throw e;
  } finally {
    state.denetimSuruyor = false;
    denetimCiz();
  }
}
