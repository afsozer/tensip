// Safahat / Taraflar / Hesap sekmelerinin çizimi (P07b).
//
// BU MODÜL BAŞLIK TABLOSU TUTMAZ. Alan adlarının Türkçe karşılığı, tarih ve
// para biçimi, kronolojik sıra kararı MOTORDA üretilir
// (src/uyap/detay-goster.ts) ve yanıtta `gorunum` olarak gelir; burada yalnız
// çizilir. İkinci bir tablo yazılsaydı biri güncellenip diğeri unutulur,
// ekranda başka CLI'da başka ad görünürdü (P16 `sayilir`, P15c `kaynakDurum`,
// P06b `ONARIM_TABLOSU` kalıbı).
//
// EKRAN VERİNİN YAŞINI SÖYLER. Safahat daemon'da 60 dk'lık önbelleğin
// arkasındadır ve UYAP'ın kendi limiti de saatte bir kezdir (PRTL_GNL_1-1);
// tıklama anını yazmak bir saatlik veriyi taze gösterir. Yanıttaki
// `sorguAt`/`onbellekten` bunu söyler.
//
// ÜÇ BOŞLUK BİRBİRİNDEN AYRIDIR: kayıt yok · hata · UYAP limiti. Limiti genel
// hata gibi göstermek "bir şeyler bozuk" hissi verir; oysa olan şey UYAP'ın
// bu sorguyu saatte bir kez vermesidir ve elde ÖNCEKİ ölçüm durmaktadır.
import { escape, empty, errorHTML } from "./ortak.js";

export const SEKME_ADI = {
  safahat: "Safahat",
  taraflar: "Taraflar",
  hesap: "Hesap",
};

/** Sekme kutusunun boş hâli; `veri: null` "hiç sorulmadı" demektir. */
export function bosKutu() {
  return { yukleniyor: false, hata: null, veri: null };
}

/** UYAP'ın kendi saatlik limitinin hata kodu (PRTL_GNL_1-1). */
export const LIMIT_KODU = "OTOMASYON_BUTCESI";

/**
 * SEKMEYE DÖNMEK YENİ PORTAL İSTEĞİ DOĞURMAZ. Kutuda sonuç, süren bir istek
 * YA DA BİR HATA varsa portala gidilmez; eldeki durum yeniden çizilir.
 * `zorla` YALNIZ "Yenile" düğmesinden gelir — kullanıcının bilerek istediği
 * tek sorgu yolu odur.
 *
 * HATA DA SONUÇTUR (P07b incelemesi; ölçüldü): eskiden hatalı kutu boş kutu
 * sayılıyor ve her sekme girişi portala yeni bir istek atıyordu. En kötüsü
 * limit hatasındaydı — ekran "UYAP bu sorguyu saatte bir kez veriyor" derken
 * uygulama aynı uca tıklama başına vuruyordu (sahte portal sayacıyla 3 giriş
 * = 3 istek ölçüldü). Kullanıcı kilitlenmez: hata ekranında "Yenile" düğmesi
 * ÇİZİLİR (bkz. `detayHTML`), tek sorgu yolu odur.
 */
export function sorgulanmaliMi(kutu, zorla = false) {
  if (zorla) return true;
  return !(kutu?.veri || kutu?.yukleniyor || kutu?.hata);
}

/**
 * Uçan sorgu bittiğinde kutunun alacağı hâl.
 *
 * `yazilsin` YANLIŞSA (arada başka sekmeye/dosyaya geçilmiş; geciken yanıt
 * artık başka ekranın verisi olabilir) sonuç YAZILMAZ — ama "yükleniyor"
 * bayrağı YİNE DE düşer. Bayrağı sürüm korumasının içinde bırakmak sekmeyi
 * kalıcı olarak "Yükleniyor…" ekranında kilitliyordu (P07b incelemesi;
 * tarayıcıda ölçüldü): kutu "istek sürüyor" sayıldığı için `sorgulanmaliMi`
 * bir daha sormuyor, `detayHTML` de o dalda Yenile düğmesi çizmiyordu; tek
 * çıkış yolu başka davaya geçip geri dönmekti.
 */
export function kutuTamamla(kutu, { veri = null, hata = null, yazilsin = true } = {}) {
  if (!kutu) return kutu;
  kutu.yukleniyor = false;
  if (!yazilsin) return kutu;
  if (hata) {
    // Limitte ELDEKİ ÖLÇÜM DURUR: "saatte bir kez" cümlesi eski kayıtların
    // üstünde görünür, kayıtlar silinmez.
    kutu.hata = hata;
    if (hata.kod !== LIMIT_KODU) kutu.veri = null;
    return kutu;
  }
  kutu.veri = veri;
  kutu.hata = null;
  return kutu;
}

/**
 * Duran yaş satırının yeni metni; ekranı yeniden ÇİZMEDEN yalnız o satır
 * tazelenir (yeni portal isteği YOK). Metin üretilemiyorsa null döner ve
 * ekrandaki satıra dokunulmaz.
 *
 * Neden gerekli (P07b incelemesi; ölçüldü): yaş cümlesi yalnız yeniden
 * çizimde hesaplanıyordu; sekmede oturan kullanıcının ekranında "portaldan az
 * önce alındı" donuyordu — safahat 60 dk önbellekli olduğu için bir saatlik
 * veriye bakarken bile.
 */
export function yasTazelemeMetni(kutu, simdi = new Date()) {
  if (kutu?.yukleniyor && !kutu?.veri) return null;
  const metin = sorguZamaniMetni(kutu?.veri ?? null, simdi);
  return metin === "" ? null : metin;
}

/** Motor `gorunum` üretmediyse (beklenmedik yanıt) alan SESSİZCE düşmesin. */
const GOSTERILEMEZ = "(gösterilemeyen değer)";

export function degerHTML(deger) {
  if (!deger || typeof deger !== "object") return escape(GOSTERILEMEZ);
  if (deger.tur === "metin") return escape(deger.metin);
  if (deger.tur === "liste")
    return `<ul class="detay-liste">${(deger.ogeler || [])
      .map((o) => `<li>${degerHTML(o)}</li>`)
      .join("")}</ul>`;
  if (deger.tur === "alanlar")
    return `<dl class="detay-ic">${alanlarHTML(deger.alanlar || [])}</dl>`;
  return escape(GOSTERILEMEZ);
}

export function alanlarHTML(alanlar) {
  return (alanlar || [])
    .map((a) => `<dt>${escape(a?.baslik ?? "")}</dt><dd>${degerHTML(a?.deger)}</dd>`)
    .join("");
}

/**
 * Tek kayıt. TANINMAYAN ALANLAR GİZLENMEZ: ayrı bir bölümde, kaç tane
 * olduğu yazılı olarak görünür. Alanı gizlemek ham göstermekten kötüdür —
 * avukat eksik veriye baktığını anlamaz.
 */
export function kayitHTML(kayit, sira) {
  const bilinen = kayit?.alanlar ?? [];
  const diger = kayit?.digerleri ?? [];
  const govde = bilinen.length ? `<dl>${alanlarHTML(bilinen)}</dl>` : "";
  const ek = diger.length
    ? `<div class="detay-diger"><p class="detay-diger-baslik">Tanınmayan ${diger.length} alan (olduğu gibi gösteriliyor)</p><dl>${alanlarHTML(diger)}</dl></div>`
    : "";
  const bos =
    bilinen.length || diger.length
      ? ""
      : `<p class="subtle">Bu kayıtta hiç alan yok.</p>`;
  return `<div class="detail-record"><p class="detay-sira">${sira}. kayıt</p>${govde}${ek}${bos}</div>`;
}

export function kayitlarHTML(gorunum) {
  return gorunum.map((k, i) => kayitHTML(k, i + 1)).join("");
}

/**
 * Verinin yaşı. TIKLAMA ANI DEĞİL, ÖLÇÜM ANI yazılır. Damga yoksa iddia
 * KURULMAZ (eski motor yanıtı): boş dize döner ve satır çizilmez.
 */
export function olcumSaati(veri) {
  const t = Date.parse(veri?.sorguAt ?? "");
  if (!Number.isFinite(t)) return "";
  return new Date(t).toLocaleString("tr-TR", {
    dateStyle: "short",
    timeStyle: "short",
  });
}

export function sorguZamaniMetni(veri, simdi = new Date()) {
  const t = Date.parse(veri?.sorguAt ?? "");
  if (!Number.isFinite(t)) return "";
  const saat = olcumSaati(veri);
  const dk = Math.max(0, Math.floor((simdi.getTime() - t) / 60_000));
  const yas = dk < 1 ? "az önce" : `${dk} dk önce`;
  return veri?.onbellekten
    ? `Veri ${saat} ölçümü · önbellekten, ${yas} ölçüldü`
    : `Veri ${saat} ölçümü · portaldan ${yas} alındı`;
}

/** Safahatta sıranın kaynağı. Sessizce sıralanmaz; ne yapıldığı yazılır. */
export function siraNotu(veri) {
  if (veri?.sira === "tarih") return "Kronolojik sıra: en eski kayıt üstte.";
  if (veri?.sira === "portal")
    return "Portal sırası korundu: kayıtların hepsinde sıralanabilir tarih yok.";
  return "";
}

/**
 * UYAP'IN KENDİ LİMİTİ, genel hata değildir. Elde önceki ölçüm varsa onun
 * saati söylenir; yoksa yalnız limit anlatılır.
 */
export function limitMetni(veri) {
  const taban =
    "UYAP bu sorguyu saatte bir kez veriyor; şu an yeniden sorulamadı.";
  const saat = olcumSaati(veri);
  return saat === ""
    ? `${taban} Bir süre sonra yeniden deneyin.`
    : `${taban} Aşağıdaki kayıtlar önceki ölçümdür: ${saat}.`;
}

export function bosluk(ad) {
  return empty(
    "Kayıt bulunamadı",
    `Portal bu dosya için ${(SEKME_ADI[ad] ?? ad).toLocaleLowerCase("tr-TR")} satırı döndürmedi. Bu bir hata değildir.`,
  );
}

/**
 * Sekme gövdesi. Sıra: durum satırı (yaş + Yenile) → uyarı → kayıtlar.
 * `kutu.veri` null iken "hiç sorulmadı"/"yükleniyor" ayrımı korunur.
 *
 * HATA EKRANINDA DA "YENİLE" ÇİZİLİR (P07b incelemesi): hata sonrası sekmeye
 * dönmek artık kendiliğinden yeniden sormadığı için (`sorgulanmaliMi`)
 * kullanıcının elinde bir çıkış kalmalı. Eskiden genel hata dalı erken
 * dönüyor ve yalnız hata kutusunu basıyordu.
 */
export function detayHTML(ad, kutu, simdi = new Date()) {
  const veri = kutu?.veri ?? null;
  const hata = kutu?.hata ?? null;
  const limitli = hata?.kod === LIMIT_KODU;
  if (kutu?.yukleniyor && !veri) return empty("Yükleniyor…", "", true);
  const parcalar = [];
  const zaman = sorguZamaniMetni(veri, simdi);
  const durum =
    zaman !== "" ? zaman : hata ? "Bu sekmede henüz alınmış veri yok." : "Sorgu zamanı bilinmiyor.";
  if (zaman !== "" || veri || hata)
    parcalar.push(
      `<div class="row spread detay-durum"><p class="subtle">${escape(durum)}</p><button id="detay-yenile" class="quiet"${kutu?.yukleniyor ? " disabled" : ""}>Yenile</button></div>`,
    );
  if (limitli)
    parcalar.push(`<div class="notice" role="status">${escape(limitMetni(veri))}</div>`);
  else if (hata) parcalar.push(errorHTML(hata.mesaj));
  if (!veri) return parcalar.join("");
  if (!Array.isArray(veri.gorunum))
    parcalar.push(
      `<div class="notice error" role="alert">Bu sürüm okunur görünüm üretmedi; ${escape(String(veri.adet ?? 0))} kayıt gösterilemiyor.</div>`,
    );
  else if (veri.gorunum.length === 0) parcalar.push(bosluk(ad));
  else {
    const not = siraNotu(veri);
    if (not !== "") parcalar.push(`<p class="subtle detay-sira-not">${escape(not)}</p>`);
    parcalar.push(kayitlarHTML(veri.gorunum));
  }
  return parcalar.join("");
}
