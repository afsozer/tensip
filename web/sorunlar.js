// P16 — sorun listesinin TEK yeri. Liste artık İndirilenler ekranında, evrak
// sütununun "Sorunlar" sekmesinde yaşar; İşlemler ekranı yalnız işler tarafını
// tutar. Liste iki ekrana KOPYALANMAZ: hem veri (`state.issues`) hem çizim
// (`sorunlariCiz`) bu modüldedir, çağıran ekran yalnız kapsayıcıyı sağlar.
//
// SINIFLAMA BURADA YAPILMAZ. "Bu kayıt sayılır mı" kararı sunucudadır
// (src/jobs/problems.ts `eylemeDonukMu`) ve satır başına `sayilir` bayrağı
// olarak gelir; burası yalnız bayrağı etikete çevirir. Bu, P15c'nin
// `kaynakDurum` kalıbıdır ve ikinci bir türetme ikizi doğurmaz — sayaç ile
// liste tanım gereği aynı kaynaktan beslenir.
import {
  $,
  escape,
  state,
  api,
  empty,
  date,
  action,
  updatePending,
  kanca,
} from "./ortak.js";

export const SORUN_TUR_ETIKET = {
  indirme: "İndirme",
  donusum: "Dönüşüm",
  yuklenmemis: "UYAP’a yüklenmemiş",
};

/**
 * SESSİZ VARSAYILAN: bayrağı hiç taşımayan kayıt (eski motor yanıtı)
 * "sayılmıyor" DİYE İŞARETLENMEZ. Yalnız sunucunun açıkça `false` dediği kayıt
 * işaretlenir; ölçemediğimiz bir şey için kullanıcıya iddia kurmayız.
 */
export function sayilmiyorMu(s) {
  return s?.sayilir === false;
}

/** Sorun metni nesne de olabilir (hata serileştirmesi); tek yerde çözülür. */
export function sorunMetni(s) {
  const h = s?.hata;
  return typeof h === "object" && h !== null ? (h.message ?? "") : (h ?? "");
}

export function sorunBasligi(s) {
  return (
    s?.caseKey?.replaceAll("\u0000", " · ") || s?.tur || "Evrak sorunu"
  );
}

/** Kayıtları verilen davaya daraltır; caseKey verilmezse hepsi döner. */
export function sorunKapsamla(rows, caseKey) {
  const liste = Array.isArray(rows) ? rows : [];
  if (!caseKey) return liste;
  return liste.filter((s) => s.caseKey === caseKey);
}

/**
 * Bir davanın sekme/rozet sayısı. `sayilan` sayaca giren kayıt sayısı,
 * `toplam` listede görünen açık kayıt sayısıdır; ikisi bilerek ayrı döner —
 * yoksayılan/eyleme dönük olmayan kayıt LİSTEDEN düşmez, SAYAÇTAN düşer.
 */
export function davaSorunSayaci(issues, caseKey) {
  const acik = sorunKapsamla(issues?.acik, caseKey);
  return {
    sayilan: acik.filter((s) => !sayilmiyorMu(s)).length,
    toplam: acik.length,
  };
}

/**
 * ELLE UI KONTROLÜNDE YAKALANAN KUSUR (P16 incelemesi) — sol menü rozeti her
 * 5 sn'lik `durum` turunda tazeleniyordu, sekme sayacı/dava rozeti/liste ise
 * yalnız ekrana girişte, bir eylemden sonra ve İŞ BİTİNCE. Motor sorun kaydını
 * iş SÜRERKEN yazdığı için (src/jobs/orchestrator.ts `sorunEkle`,
 * `donusumleriTetikle`) aynı ekranda bir yüzey "3", üçü "1" diyordu; kayıt son
 * `finished` olayından sonra doğduğunda ise fark hiç kapanmıyordu.
 *
 * Bu işlev farkı ÖLÇER, tahmin etmez: `durum.sorunAcik` ile
 * `sorunlar.sayilanAdet`, `durum.sorunAcikToplam` ile `sorunlar.acikAdet`
 * sunucuda AYNI iki çağrıdan üretilir (src/server/daemon.ts:170-171 ve
 * 418-420: `acikSayilan().length` / `acik().length`). Ayrıştıklarında tek
 * açıklama istemcinin anlık görüntüsünün bayatlamış olmasıdır; eşitlendiğinde
 * ek istek doğmaz, yani boşta yoklama sıklığı artmaz.
 *
 * SESSİZ VARSAYILAN (sayilmiyorMu ile aynı kural): iki taraftan biri sayıyı
 * hiç taşımıyorsa (eski motor yanıtı) AYRIŞMA İDDİA EDİLMEZ — yoksa her turda
 * gereksiz bir `sorunlar` çağrısı doğardı.
 */
export function sorunSayilariAyristiMi(status, issues) {
  if (!status || !issues) return false;
  const ayri = (a, b) =>
    typeof a === "number" && typeof b === "number" && a !== b;
  return (
    ayri(status.sorunAcik, issues.sayilanAdet) ||
    ayri(status.sorunAcikToplam, issues.acikAdet)
  );
}

/** Sekme etiketindeki kısa sayaç metni; sayılan kayıt yoksa boş. */
export function sekmeSayaci(sayac) {
  return Number(sayac?.sayilan) > 0 ? `(${Number(sayac.sayilan)})` : "";
}

/**
 * Sekmenin altındaki açıklama satırı. Sayaç ile listenin neden farklı
 * olabileceğini SÖYLER; sessizce farklı iki sayı göstermek kullanıcıyı
 * "sorunlarımdan biri kayboldu" diye okumaya iter.
 */
export function sorunOzetMetni(sayac, sec = {}) {
  const sayilan = Number(sayac?.sayilan) || 0;
  const toplam = Number(sayac?.toplam) || 0;
  const kapsam = sec.dava ? "Bu dosyada" : "Tüm arşivde";
  if (toplam === 0) return `${kapsam} açık sorun yok.`;
  const fark = toplam - sayilan;
  return fark > 0
    ? `${kapsam} ${toplam} açık kayıt · ${sayilan} tanesi sayaca giriyor. ${fark} kayıt sizin düzeltebileceğiniz bir şey değil; listede kalır, sayaçta kalmaz.`
    : `${kapsam} ${toplam} açık kayıt · hepsi sayaca giriyor.`;
}

/** Tek sorun kaydının HTML'i. Saf: girdi kayıt, çıktı dize. */
export function sorunSatiri(s) {
  const yoksayildi = s?.durum === "yok-sayildi";
  const sayilmaz = sayilmiyorMu(s);
  const tur = SORUN_TUR_ETIKET[s?.tur] ?? s?.tur ?? "Sorun";
  const rozetler = [
    `<span class="tag ${sayilmaz ? "" : "bad"}">${escape(tur)}</span>`,
    sayilmaz
      ? '<span class="tag bilinmiyor" title="Bu kayıt sizin düzeltebileceğiniz bir şey değil; listede kalır, sayaçta kalmaz.">Sayaç dışı</span>'
      : "",
    yoksayildi ? '<span class="tag">Yoksayıldı</span>' : "",
  ].join("");
  const eylem =
    s?.durum === "cozuldu"
      ? '<span class="tag good">Çözüldü</span>'
      : `<button data-issue="${escape(s?.sorunId)}" data-operation="${yoksayildi ? "vazgec" : "yoksay"}">${yoksayildi ? "Yoksaymayı geri al" : "Yoksay"}</button>`;
  return `<article class="job sorun-kayit"><div class="row spread wrap"><strong class="job-title">${escape(sorunBasligi(s))}</strong><span class="row wrap">${rozetler}</span></div><p>${escape(sorunMetni(s))}</p><div class="row spread wrap"><span class="subtle">${escape(date(s?.at))}</span>${eylem}</div></article>`;
}

export function sorunListesiHTML(rows, sec = {}) {
  const liste = Array.isArray(rows) ? rows : [];
  if (liste.length) return liste.map((s) => sorunSatiri(s)).join("");
  return empty(
    sec.yoksayilanlar
      ? "Gösterilecek kayıt yok"
      : sec.dava
        ? "Bu dosyada açık sorun yok"
        : "Açık sorun yok",
    "Evrak indirme ve dönüşüm sorunları burada listelenir.",
  );
}

/** Yalnız seçili davayı mı gösteriyoruz? Dava seçili değilse her zaman "hepsi". */
export function sorunKapsamiDava() {
  return state.sorunKapsam === "dava" && Boolean(state.selectedCase);
}

/**
 * Sorun sekmesini çizer. Kapsayıcılar yoksa (ekran açık değil) hiçbir şeye
 * dokunmaz — poll ve eylem sonrası çağrıları bu yüzden güvenlidir.
 */
export function sorunlariCiz() {
  const kok = $("#sorun-liste");
  if (!kok) return;
  const davaKapsami = sorunKapsamiDava();
  const caseKey = davaKapsami ? state.selectedCase : null;
  if (!state.issues) {
    kok.innerHTML = empty("Sorunlar yükleniyor…", "", true);
    return;
  }
  const yoksayilanlar = Boolean($("#sorun-yoksayilan")?.checked);
  const kaynak = yoksayilanlar ? state.issues.hepsi : state.issues.acik;
  const rows = sorunKapsamla(kaynak, caseKey);
  const sayac = davaSorunSayaci(state.issues, caseKey);
  if ($("#sorun-sayaci"))
    $("#sorun-sayaci").textContent = sekmeSayaci(
      davaSorunSayaci(state.issues, null),
    );
  if ($("#sorun-ozet"))
    $("#sorun-ozet").textContent = sorunOzetMetni(sayac, { dava: davaKapsami });
  if ($("#sorun-kapsam")) {
    const dugme = $("#sorun-kapsam");
    dugme.disabled = !state.selectedCase;
    dugme.textContent = davaKapsami
      ? "Tüm dosyaları göster"
      : "Yalnız seçili dosya";
  }
  kok.innerHTML = sorunListesiHTML(rows, {
    dava: davaKapsami,
    yoksayilanlar,
  });
  kok.querySelectorAll("[data-issue]").forEach(
    (button) =>
      (button.onclick = () =>
        action(button, async () => {
          await api("sorunlar", {
            islem: button.dataset.operation,
            sorunId: button.dataset.issue,
          });
          await refreshIssues();
          await kanca.poll();
        })),
  );
  updatePending();
}

/**
 * Sorun listesini tazeler. YALNIZ yerel `sorunlar.json` okunur; portala hiçbir
 * istek gitmez, oturum aranmaz — oturumsuz arşivde sekme bu yüzden çalışır.
 */
export async function refreshIssues() {
  state.issues = await api("sorunlar");
  sorunlariCiz();
}
