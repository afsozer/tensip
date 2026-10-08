// Bütün görünüm modüllerinin paylaştığı taban: DOM kısayolu, kaçırma, uygulama
// durumu, /api çağrısı, bekleyen eylem defteri ve oturum başlığı. Bu dosya
// hiçbir görünüm modülünü import etmez (döngü yasağı) ve modül gövdesinde DOM'a
// dokunmaz; bu yüzden saf yardımcıları node'dan da yüklenebilir.
export const $ = (selector, root = document) => root.querySelector(selector);
export const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        ch
      ],
  );
export const state = {
  page: "indirilenler",
  // Sayfa nesli: geç dönen yanıtın yeni ekrana yazmasını engeller. Modüller
  // arası paylaşıldığı için `let` değil state alanı (ES modülünde import edilen
  // bağ başka modülden artırılamaz).
  nesil: 0,
  status: null,
  cases: [],
  // caseKey → {toplam, kullanilabilir, dagilim} | {okunamadi:true}. Kaynağı
  // `hazirlik-ozet` RPC'si, yani MANİFEST; registry'deki sonEvrakSayisi değil.
  // Türetilmiş veridir, hiçbir yere yazılmaz.
  hazirlikOzetleri: new Map(),
  documents: [],
  // P15b — seçili davanın manifest seviyesindeki son eşitleme işaretçisi
  // ({esitlemeId, ilkIndirme, ...} | null). Kaynağı `evraklar` RPC'si; "yeni"
  // rozeti evrak damgasını bununla karşılaştırarak türetilir. Türetilmiş
  // veridir, hiçbir yere yazılmaz.
  sonEsitleme: null,
  selectedCase: null,
  selectedDocument: null,
  jobs: [],
  batches: [],
  batchSelection: new Set(),
  // Sorun listesi (P16): {acik, hepsi, hepsiAdet, acikAdet, sayilanAdet}.
  // Kaynağı `sorunlar` RPC'si; satır başına `sayilir` bayrağını SUNUCU koyar.
  issues: null,
  // P16 — sorun sekmesinin kapsamı: "dava" (seçili dosya) | "tumu".
  // Dava seçili değilken "dava" kapsamı kendiliğinden "tumu" gibi davranır.
  sorunKapsam: "dava",
  // P16/P06a — orta sütunun etkin sekmesi: "evrak" | "sorun" | "denetim".
  ortaSekme: "evrak",
  // P06a — son denetim raporu ({at, tamamlandi, sayilar, davalar, bulgular})
  // ya da hiç koşmadıysa null. Kaynağı `arsiv-denetle` RPC'si; DENETİM
  // KENDİLİĞİNDEN KOŞMAZ, bu alan yalnız "Denetle" düğmesiyle dolar.
  // Türetilmiş veridir, hiçbir yere yazılmaz ve uygulama kapanınca kaybolur.
  denetim: null,
  denetimHata: null,
  denetimSuruyor: false,
  // P06b — AÇIK ONARIM KARTI: {anahtar, asama, veri, hata} ya da null.
  // Aynı anda YALNIZ BİR satırın kartı açıktır. `asama` sırayla "calisiyor" →
  // "plan" → "sonuc" (ya da "hata"); "plan" aşamasında diskte TEK BAYT
  // değişmemiştir. Türetilmiş veridir, hiçbir yere yazılmaz.
  onarim: null,
  // P06a — denetim kapsamı: "tumu" (varsayılan; kullanıcının sorusu "arşivim
  // sağlam mı") | "dava". Dava seçili değilken "dava" kapsamı "tumu" gibi
  // davranır.
  denetimKapsam: "tumu",
  // P07a — Ajanda ekranının hafızası: {durusmalar, sorguAt, olcumAt,
  // onbellekten, gun, hata, taraflariEkle, aktarma, aktarmaHata}.
  // `durusmalar: null` "hiç sorgulanmadı" demektir; boş dizi "bu aralıkta
  // kayıt yok" demektir, ikisi ekranda ayrı görünür. SORGU YALNIZ DÜĞMEYLE
  // olur: sekmeye dönmek yeni portal isteği doğurmaz, eldeki sonuç VERİNİN
  // ÖLÇÜM ZAMANIYLA gösterilir — `sorguAt` tıklama anıdır, `olcumAt` verinin
  // gerçekten ölçüldüğü andır ve daemon'daki 10 dk'lık önbellek yüzünden ikisi
  // AYRIŞIR; ekranda yazılan `olcumAt`tır. Aktarma seçeneği `taraflariEkle`
  // VARSAYILAN KAPALIDIR (takvim iCloud'a eşitlenir).
  // Türetilmiş veridir, diske yazılmaz ve uygulama kapanınca kaybolur.
  ajanda: {
    durusmalar: null,
    sorguAt: null,
    olcumAt: null,
    onbellekten: false,
    gun: 7,
    hata: null,
    taraflariEkle: false,
    aktarma: null,
    aktarmaHata: null,
  },
  caseFilter: "",
  documentFilter: "",
  view: "evrak",
  preview: null,
  previewLoading: false,
  previewError: null,
  // P07b — SEKME HAFIZASI: {caseKey, sekmeler:{safahat,taraflar,hesap}}.
  // Her sekme `{yukleniyor, hata, veri}`; `veri: null` "hiç sorulmadı"
  // demektir, `veri.gorunum: []` "portal satır döndürmedi" demektir ve ikisi
  // ekranda AYRI görünür. SEKMEYE DÖNMEK YENİ SORGU DOĞURMAZ (P07a'daki
  // `state.ajanda` kalıbı): kutu doluysa eldeki sonuç, ölçüm zamanıyla
  // birlikte yeniden çizilir. Dava değişince kutular sıfırlanır.
  // Türetilmiş veridir, diske yazılmaz ve uygulama kapanınca kaybolur.
  detay: { caseKey: null, sekmeler: {} },
  // P10a — Ayarlar ekranındaki tanılama. Kaynağı `tani` RPC'si; sayfaya her
  // GİRİŞTE bir kez çekilir, 5 sn'lik durum yoklamasına EKLENMEZ (ölçüm alt
  // süreç doğurur). Türetilmiş veridir, hiçbir yere yazılmaz.
  tani: null,
  taniHata: null,
  archiveLoaded: false,
  loginPending: false,
  portal: {
    cases: [],
    search: "",
    status: "tumu",
    sort: "mahkeme",
    direction: "asc",
    page: 1,
    pageSize: 50,
    progress: "",
    error: null,
    loaded: false,
    loading: false,
    scrollTop: 0,
    query: { birim: "", yil: "", sira: "" },
    // P18a — listedeki opak `dosyaId`lerin HANGİ OTURUMA ait olduğu. Sunucu
    // liste yanıtında söyler; taraf sorgusu bunu geri gönderir ve sürüm
    // uyuşmuyorsa istek portala hiç gitmeden reddedilir. `null` iken düğme
    // kapalıdır: kimliğin hangi oturuma ait olduğunu bilmeden taraf sorulmaz.
    surum: null,
    // P18a — satırların EN SON HANGİ oturum kapısıyla çizildiği (web/taraf.js
    // `tarafOturumEngeli` çıktısı). `poll` bunu canlı kapıyla karşılaştırır;
    // ayrıştığında satırlar yeniden çizilir, aynıysa DOM'a dokunulmaz.
    cizilenEngel: null,
    // P18a — dosyaId → {durum, taraflar?, mesaj?}. Yalnız TIKLANAN satır için
    // dolar; liste açılması tek bir taraf isteği doğurmaz. Diske YAZILMAZ,
    // liste yenilenince `tarafNesil` artırılıp temizlenir.
    taraflar: new Map(),
    tarafNesil: 0,
  },
};
export const pendingActions = new Set();
// Görünüm modüllerinin giriş noktasına bağlandığı tek nokta. Yalnız iki alan
// taşır ve genel bir olay yoluna genişletilmez: poll (app.js atar) ve her
// eylemden sonra çalışacak tazeleme kancaları.
export const kanca = { poll: async () => {}, eylemSonrasi: [] };
let toastTimer;
export async function api(name, body = {}) {
  const response = await fetch(`/api/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": $('meta[name="csrf-token"]').content,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(name === "giris" ? 16 * 60_000 : 120_000),
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("Uygulamadan geçerli yanıt alınamadı. Yeniden deneyin.");
  }
  if (!response.ok || !result.ok) {
    const hata = new Error(result.error?.message || "İşlem tamamlanamadı.");
    // P07b — KOD ÇAĞIRANA ULAŞIR. "UYAP bu sorguyu saatte bir kez veriyor"
    // (OTOMASYON_BUTCESI) ile "bir şeyler bozuk" ekranda AYRI görünmeli;
    // metne bakarak ayırt etmek metin değişince sessizce bozulur.
    hata.kod = result.error?.code ?? null;
    throw hata;
  }
  return result.data;
}
export function toast(message) {
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("#toast").hidden = true), 6000);
}
export function empty(title, description = "", loading = false) {
  return `<div class="empty"><div class="empty-symbol">${loading ? '<span class="spinner"></span>' : "▤"}</div><strong>${escape(title)}</strong><p>${escape(description)}</p></div>`;
}
export function errorHTML(error) {
  return `<div class="notice error" role="alert">${escape(error.message || error)}</div>`;
}
export function date(value) {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? String(value)
    : d.toLocaleString("tr-TR", { dateStyle: "short", timeStyle: "short" });
}
export function isOnline() {
  return state.status?.oturum?.durum === "aktif";
}
export function actionKey(button) {
  if (button.dataset.batch) return `batch:${button.dataset.batch}`;
  // P06b — onarım düğmeleri SATIR BAŞINA ayrı anahtar alır; yoksa anahtar
  // düğme metnine düşerdi ve bir satırın "Metni yeniden üret"i beklerken
  // bütün satırlarınki kapanırdı.
  if (button.dataset.onar) return `onar:${button.dataset.onar}:${button.dataset.onarAsama ?? ""}`;
  return button.dataset.job
    ? `job:${button.dataset.job}`
    : button.dataset.issue
      ? `issue:${button.dataset.issue}`
      : button.dataset.download != null
        ? "download"
        : button.id || button.closest("form")?.id || button.textContent;
}
export function updatePending() {
  document.querySelectorAll("button").forEach((button) => {
    const busy = pendingActions.has(actionKey(button));
    if (busy) {
      button.dataset.busy = "true";
      button.disabled = true;
    } else if (button.dataset.busy) {
      delete button.dataset.busy;
      button.disabled = false;
    }
  });
}
export async function action(button, fn) {
  const key = actionKey(button);
  if (button.disabled || pendingActions.has(key)) return;
  pendingActions.add(key);
  updatePending();
  try {
    await fn();
  } catch (error) {
    toast(error.message);
  } finally {
    pendingActions.delete(key);
    updatePending();
    for (const f of kanca.eylemSonrasi) f();
    updateStatus();
  }
}
export function updateStatus() {
  const s = state.status;
  if (!s) return;
  const active = isOnline(),
    pending = state.loginPending || s.girisSuruyor;
  $("#session-label").textContent = active
    ? "UYAP oturumu açık"
    : pending
      ? "Giriş bekleniyor"
      : s.oturum?.durum === "kontrol_ediliyor"
        ? "Oturum kontrol ediliyor"
        : "UYAP oturumu kapalı";
  $("#session-detail").textContent = active
    ? "Dosya sorgulamaya hazır"
    : pending
      ? "Tarayıcıdaki adımları tamamlayın"
      : "Yerel arşiviniz erişilebilir";
  $("#session-dot").classList.toggle("online", active);
  $("#login-button").textContent = pending
    ? "Giriş sürüyor…"
    : active
      ? "Oturumu kapat"
      : "UYAP’a giriş yap";
  $("#login-button").disabled = !!pending || pendingActions.has("login-button");
  $("#cancel-login").hidden = !pending;
  $("#header-status").textContent = s.isler?.calisiyor
    ? `${s.isler.calisiyor} işlem sürüyor`
    : "Yerel arşiv";
  // P16 — rozet SAYILAN kayıtları gösterir (src/jobs/problems.ts
  // `eylemeDonukMu`). Sunucu hem burayı hem sekme sayacını aynı işlevden
  // besler; aynı sorun iki ekranda farklı sayılamaz.
  $("#issue-badge").textContent = s.sorunAcik || "";
  $("#issue-badge").hidden = !s.sorunAcik;
  $("#issue-badge").title = s.sorunAcikToplam
    ? `${Number(s.sorunAcik)} / ${Number(s.sorunAcikToplam)} açık kayıt sayaca giriyor`
    : "";
  document.querySelectorAll("[data-online]").forEach((el) => {
    el.hidden = active;
  });
  // P18a — taraf düğmesinin oturum kapısı BURADA DEĞİL. Eskiden burada tek
  // yönlü bir mandal vardı (yalnız kapatırdı) ve düğmeler oturum aktifken bile
  // kapalı kalabiliyordu; ölçülüp kaldırıldı. Kapı artık `app.js` içinde,
  // `state.status`un değiştiği tek yerde (poll) çift yönlü ölçülüyor ve
  // satırlar yeniden çiziliyor. Kural web/taraf.js `tarafOturumEngeli`.
}
