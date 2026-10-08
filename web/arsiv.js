// İndirilenler ekranı: yerel arşivdeki dosya listesi, evrak listesi, metin
// önizlemesi ve dosya ayrıntı sekmeleri. Satır üreticileri (davaSatiri,
// evrakSatiri) saf tutulur ve node'dan sınanır; DOM'a yalnız çağrı anında
// dokunulur, modül gövdesinde dokunulmaz.
import {
  $,
  escape,
  state,
  pendingActions,
  api,
  toast,
  empty,
  errorHTML,
  action,
  updatePending,
  kanca,
  date,
} from "./ortak.js";
import {
  sorunlariCiz,
  refreshIssues,
  davaSorunSayaci,
  sorunKapsamiDava,
} from "./sorunlar.js";
import { denetimCiz, denetimiCalistir, denetimKapsamiDava } from "./denetim.js";
import { topluIlerleme } from "./toplu.js";
import { tarafOzetiHTML, tarafOzetMetni } from "./taraf.js";
import {
  bosKutu,
  detayHTML,
  kutuTamamla,
  sorgulanmaliMi,
  yasTazelemeMetni,
} from "./detay.js";
import {
  categoryName,
  davaRozetleri,
  rozetler,
  evrakGruplari,
  grupBasligi,
  evrakOzeti,
  ozetMetni,
  onizlemeBosluk,
  kaynakSorunlu,
  kaynakUyarisi,
  kaynakBosluk,
} from "./evrak-durum.js";

let selectionGeneration = 0,
  archiveRequest = 0,
  documentRequest = 0;

function currentCase() {
  return state.cases.find((c) => c.caseKey === state.selectedCase);
}
export function davaSatiri(
  c,
  secili = state.selectedCase,
  secim = state.batchSelection,
  ozet = state.hazirlikOzetleri.get(c?.caseKey),
  // P16 — sorun rozeti sekmeyle AYNI sayıdan beslenir; `state.issues` yoksa
  // sayaç 0 döner ve satır P15c'deki hâliyle birebir aynı HTML'i üretir.
  sorun = davaSorunSayaci(state.issues, c?.caseKey),
) {
  const aktif = c.caseKey === secili;
  // P18b — taraf satırı REGISTRY'den gelir (klon/eşitleme sırasında bir kez
  // yazıldı), portaldan DEĞİL: oturum kapalıyken de görünür ve bu satırı
  // çizmek portala tek istek atmaz. Taraf taşımayan ESKİ kayıtta `taraf`
  // boş dizedir ve satır P16'daki hâliyle birebir aynı çizilir.
  const taraf = tarafOzetiHTML(c.taraflar, escape, { adTavani: 2, rolTavani: 3 });
  const tarafBaslik =
    taraf && c.taraflarAt
      ? ` title="${escape(`${tarafOzetMetni(c.taraflar, { adTavani: 99, rolTavani: 99 })} · ${date(c.taraflarAt)} tarihinde alındı`)}"`
      : "";
  return `<div class="archive-choice"><label class="archive-check"><input type="checkbox" data-select-case="${encodeURIComponent(c.caseKey)}" aria-label="${escape(c.birimAdi)} ${escape(c.dosyaNo)} toplu eşitleme için seç" ${secim.has(c.caseKey) ? "checked" : ""} ${c.klonYolu ? "" : "disabled"}></label><button class="list-item ${aktif ? "active" : ""}" data-case="${encodeURIComponent(c.caseKey)}" aria-pressed="${aktif}"><strong>${escape(c.birimAdi)}</strong><small>${escape(c.dosyaNo)} · ${escape(c.dosyaTur || "Dosya")}</small>${taraf ? `<small class="taraf-ozet"${tarafBaslik}>${taraf}</small>` : ""}${davaRozetleri(c, ozet, sorun)
    .map((r) => `<span class="tag ${r.sinif}">${escape(r.metin)}</span>`)
    .join(" ")}${c.dosyaDurum ? ` <span class="tag">${escape(c.dosyaDurum)}</span>` : ""}</button></div>`;
}
export function evrakSatiri(
  d,
  secili = state.selectedDocument,
  sonEsitleme = state.sonEsitleme,
) {
  const aktif = d.path === secili;
  // P15c — kaynağı erişilemez satır SOLUKLAŞIR. Sınıf yalnız sorun varken
  // eklenir; `kaynakDurum` taşımayan satırın HTML'i bayt bayt eskisi gibidir
  // (boş sınıf listesi de dahil — golden string'ler bunun bekçisi).
  const sinif = [aktif ? "active" : "", kaynakSorunlu(d) ? "soluk" : ""]
    .filter(Boolean)
    .join(" ");
  return `<button class="list-item ${sinif}" data-document="${escape(d.path)}" aria-pressed="${aktif}"><strong>${escape(d.tur || d.path?.split("/").pop() || "Evrak")}</strong><small>${escape(d.tarih || "Tarih belirtilmemiş")}${d.birimEvrakNo ? ` · Evrak ${escape(d.birimEvrakNo)}` : ""}${d.category ? ` · ${escape(categoryName(d.category))}` : ""}</small>${rozetler(d, sonEsitleme)
    .map((r) => `<span class="tag ${r.sinif}">${escape(r.metin)}</span>`)
    .join("")}</button>`;
}
export function renderArchive() {
  $("#page").innerHTML =
    `<div id="arsiv-durum" class="arsiv-durum" role="status" aria-live="polite" hidden></div><section class="workspace" aria-label="Yerel dosya arşivi"><div class="column"><div class="column-head"><div class="row spread"><h2>Dosyalar <span class="subtle" id="case-count"></span></h2><button id="refresh-cases" class="quiet" aria-label="Yerel arşivi yenile" title="Yerel arşivi yenile">↻</button></div><input class="search" id="case-search" aria-label="Arşivde dosya ara" placeholder="Mahkeme veya dosya no…" value="${escape(state.caseFilter)}"></div><div class="list" id="case-list"></div><div class="column-footer"><label class="row"><input type="checkbox" id="batch-select-visible" style="width:auto"> Görünen dosyaları seç</label><p class="subtle" id="batch-preview"></p><button id="sync-batch">Seçilenleri sırayla eşitle</button></div></div><div class="column"><div class="column-head"><div class="tabs orta-tabs" role="tablist" aria-label="Evraklar, sorunlar ve denetim"><button data-orta="evrak" role="tab">Evraklar</button><button data-orta="sorun" role="tab">Sorunlar <span id="sorun-sayaci"></span></button><button data-orta="denetim" role="tab">Denetim <span id="denetim-sayaci"></span></button></div><div id="evrak-araclar"><input class="search" id="document-search" aria-label="Evrak ara" placeholder="Evrak adı veya türü…" value="${escape(state.documentFilter)}"><p class="subtle sekme-not" id="document-count"></p></div><div id="sorun-araclar" hidden><div class="row wrap"><button id="sorun-kapsam" class="quiet"></button><label class="row"><input id="sorun-yoksayilan" type="checkbox" style="width:auto;margin:0"> Yoksayılanlar</label></div><p class="subtle sekme-not" id="sorun-ozet"></p></div><div id="denetim-araclar" hidden><div class="row wrap"><button id="denetim-calistir">Denetle</button><button id="denetim-kapsam" class="quiet"></button></div><p class="subtle sekme-not" id="denetim-ozet"></p><p class="subtle sekme-not" id="denetim-at"></p></div></div><div class="list" id="document-list"></div><div class="list" id="sorun-liste" hidden></div><div class="list" id="denetim-liste" hidden></div><div class="column-footer actions" id="evrak-eylemler"><button id="sync-case">Dosyayı eşitle</button><button id="open-folder" class="quiet">Klasörü aç</button></div></div><div class="column preview-column"><div id="preview" style="display:flex;flex-direction:column;min-height:0;flex:1"></div></div></section>`;
  $("#case-search").addEventListener("input", (e) => {
    state.caseFilter = e.target.value;
    renderCases();
  });
  $("#document-search").addEventListener("input", (e) => {
    state.documentFilter = e.target.value;
    renderDocuments();
  });
  $("#refresh-cases").onclick = (e) =>
    action(e.currentTarget, async () => {
      await refreshArchive(true);
      await refreshIssues();
    });
  document.querySelectorAll("[data-orta]").forEach((button) => {
    button.onclick = () => ortaSekmeSec(button.dataset.orta);
  });
  $("#sorun-kapsam").onclick = () => {
    state.sorunKapsam = sorunKapsamiDava() ? "tumu" : "dava";
    sorunlariCiz();
  };
  $("#sorun-yoksayilan").onchange = () => sorunlariCiz();
  // P06a — denetim YALNIZ bu düğmeyle koşar. Sekmeye girmek, dava seçmek ya da
  // 5 sn'lik `poll` turu denetim BAŞLATMAZ.
  $("#denetim-calistir").onclick = (e) => denetimiCalistir(e.currentTarget);
  $("#denetim-kapsam").onclick = () => {
    state.denetimKapsam = denetimKapsamiDava() ? "tumu" : "dava";
    // Kapsam değişince ESKİ RAPOR SİLİNMEZ ama artık başka bir kapsamı
    // anlatıyor olabilir; özet satırı raporun kendi kapsamını yazdığı için
    // kullanıcı hangi kümeye baktığını görür.
    denetimCiz();
  };
  $("#sync-case").onclick = (e) =>
    action(e.currentTarget, async () => {
      const key = state.selectedCase;
      if (!key) return;
      await api("esitle", { caseKey: key });
      // P16 — "İşlemler ekranından takip edebilirsiniz" tost'u KALDIRILDI:
      // ilerleme artık bu ekranın üstündeki durum şeridinde görünüyor.
      toast("Eşitleme başlatıldı.");
      await kanca.poll();
    });
  $("#batch-select-visible").onchange = (e) => {
    for (const c of filteredCases()) {
      if (e.target.checked && c.klonYolu) state.batchSelection.add(c.caseKey);
      else state.batchSelection.delete(c.caseKey);
    }
    renderCases();
  };
  $("#sync-batch").onclick = (e) =>
    action(e.currentTarget, async () => {
      await api("toplu-esitle", { caseKeys: [...state.batchSelection] });
      state.batchSelection.clear();
      // P16 — ekran DEĞİŞTİRİLMEZ. Sıra ilerlemesi durum şeridinde görünür;
      // kullanıcıyı arşivden koparmak, başlattığı işi izlemesinin bedeli olmamalı.
      await kanca.poll();
    });
  $("#open-folder").onclick = (e) =>
    action(e.currentTarget, () =>
      api("klasor-ac", { caseKey: state.selectedCase }),
    );
  renderCases();
  renderDocuments();
  renderPreview();
  ortaSekmeCiz();
  arsivDurumTazele();
  // Sorun listesi YEREL `sorunlar.json`dan gelir; portala istek atmaz, oturum
  // aramaz. Bu yüzden oturum kapalıyken de sekme dolu açılır.
  refreshIssues()
    .then(sorunRozetleriniTazele)
    .catch(() => {
      if ($("#sorun-liste") && !state.issues)
        $("#sorun-liste").innerHTML = errorHTML(
          new Error("Sorun listesi okunamadı."),
        );
    });
  if (!state.archiveLoaded)
    refreshArchive().catch((error) => {
      if (state.page === "indirilenler")
        $("#case-list").innerHTML = errorHTML(error);
    });
}

/**
 * Orta sütunun sekme durumu. Evrak listesi ve sorun listesi AYNI sütunu
 * paylaşır: sorun, ilgili olduğu arşivin yanında durur. Sekme yalnız
 * görünürlük değiştirir; iki liste de kendi verisini korur.
 */
export function ortaSekmeSec(ad) {
  state.ortaSekme = ad === "sorun" || ad === "denetim" ? ad : "evrak";
  ortaSekmeCiz();
}
function gizle(secici, deger) {
  const el = $(secici);
  if (el) el.hidden = deger;
}
function ortaSekmeCiz() {
  if (!$("#sorun-liste")) return;
  // P06a — üçüncü sekme. Etkin sekme tek bir değerdir; "evrak değil" artık
  // "sorun" demek DEĞİLDİR, bu yüzden her görünürlük kendi eşitliğinden gelir.
  const etkin =
    state.ortaSekme === "sorun" || state.ortaSekme === "denetim"
      ? state.ortaSekme
      : "evrak";
  const evrak = etkin === "evrak";
  document.querySelectorAll("[data-orta]").forEach((b) => {
    const aktif = b.dataset.orta === etkin;
    b.classList.toggle("active", aktif);
    b.setAttribute("aria-selected", String(aktif));
  });
  gizle("#document-list", !evrak);
  gizle("#evrak-araclar", !evrak);
  gizle("#evrak-eylemler", !evrak);
  gizle("#sorun-liste", etkin !== "sorun");
  gizle("#sorun-araclar", etkin !== "sorun");
  gizle("#denetim-liste", etkin !== "denetim");
  gizle("#denetim-araclar", etkin !== "denetim");
  if (etkin === "sorun") sorunlariCiz();
  // Sekmeye girmek denetim KOŞTURMAZ: yalnız eldeki raporu (ya da "henüz
  // çalıştırılmadı" boşluğunu) çizer.
  if (etkin === "denetim") denetimCiz();
}

// ── P16 kalıcı durum şeridi ─────────────────────────────────────────────────
// Kaynak: `isler` yanıtındaki `isler` + `topluIsler` — YENİ RPC YOK. Ölçüldü:
// `isler` yanıtı iş başına `ilerleme {toplam, biten}` taşıyor ve bu sayaç
// YALNIZ indirme döngüsünü sayıyor (src/jobs/orchestrator.ts `ilerlemeyiKaydet`
// yalnız evrak indirme döngülerinde artıyor). Dönüşümün ayrı bir sayacı
// isler'de YOK; `donusumleriTetikle` indirme bittikten sonra aynı iş
// `calisiyor`ken koşuyor. Bu yüzden şerit dönüşüm için SAYI UYDURMAZ:
// biten === toplam iken iş hâlâ çalışıyorsa "metinler hazırlanıyor" der.
// Sayı isteyen bir gösterge yeni bir RPC gerektirirdi; gerekmedi.
const IS_ADI = { klonla: "Dosya indirme", esitle: "Dosya eşitleme" };
export function isBasligi(job) {
  return (
    job?.caseKey?.replaceAll("\u0000", " · ") ||
    IS_ADI[job?.tur] ||
    job?.tur ||
    "İşlem"
  );
}
/** İşin şu anki aşaması: {metin, yuzde|null}. `yuzde` yalnız indirme için. */
export function isAsamasi(job) {
  const toplam = Number(job?.ilerleme?.toplam) || 0;
  const biten = Number(job?.ilerleme?.biten) || 0;
  if (job?.durum === "bekliyor") return { metin: "Sırada", yuzde: null };
  if (toplam === 0) return { metin: "Evrak listesi alınıyor…", yuzde: null };
  if (biten < toplam)
    return {
      metin: `${biten} / ${toplam} evrak indirildi`,
      yuzde: Math.min(100, (biten / toplam) * 100),
    };
  return {
    metin: `${toplam} / ${toplam} evrak indirildi · metinler hazırlanıyor…`,
    yuzde: 100,
  };
}
/**
 * Durum şeridinin HTML'i. İş yoksa BOŞ DİZE döner ve şerit `hidden` kalır —
 * kabul ölçütü "iş yokken yer kaplamaz" bu boş dizeyle karşılanır.
 */
export function arsivDurumHTML(jobs, batches) {
  const isler = (jobs ?? []).filter((j) =>
    ["calisiyor", "bekliyor"].includes(j?.durum),
  );
  // SIRA DURUMLARI İŞ DURUMLARI DEĞİLDİR. Toplu sıra sözlüğü
  // src/jobs/toplu.ts:12'de `calisiyor | duraklatildi | kesildi | hazir |
  // iptal`; `bekliyor` bu sözlükte HİÇ YOK — süzgeçte ölü bir değerdi ve
  // çıkarıldı. `duraklatildi` ise eksikti: src/jobs/toplu.ts:133-137 bir dosya
  // hata alınca sırayı durdurup mesaj yazıyor, o anda çalışan iş de kalmıyor
  // ve şerit boşalıp gizleniyordu — arşiv ekranında "bitti" ile "yarıda kaldı"
  // birebir aynı görünüyordu. `kesildi`/`iptal` KAPSAM DIŞI: ikisi de motorun
  // kapanışı ya da kullanıcının kendi iptalidir, yeni bir haber taşımaz.
  const siralar = (batches ?? []).filter((b) =>
    ["calisiyor", "duraklatildi"].includes(b?.durum),
  );
  if (!isler.length && !siralar.length) return "";
  const calisan = isler.filter((j) => j.durum === "calisiyor");
  const bekleyen = isler.length - calisan.length;
  const satirlar = calisan.map((job) => {
    const a = isAsamasi(job);
    return `<div class="arsiv-durum-is"><div class="row spread wrap"><strong class="job-title">${escape(isBasligi(job))}</strong><span class="subtle">${escape(a.metin)}</span></div>${a.yuzde === null ? "" : `<div class="progress-track" aria-label="${escape(a.metin)}"><span style="width:${a.yuzde}%"></span></div>`}</div>`;
  });
  const sira = siralar.map((b) => {
    const i = topluIlerleme(b, jobs ?? []);
    const durdu = b.durum === "duraklatildi";
    // Duraklayan sıra kendi mesajını taşır (src/jobs/toplu.ts:135). Şerit
    // yalnız GÖSTERİR; "Devam et" düğmesi İşlemler ekranında tek sahiptedir
    // ve alttaki satır zaten oraya yönlendiriyor.
    const not = durdu
      ? `<p class="subtle">${escape(b.mesaj || "Sıra duraklatıldı.")}</p>`
      : "";
    return `<div class="arsiv-durum-is"><div class="row spread wrap"><strong class="job-title">Toplu eşitleme sırası${durdu ? " · duraklatıldı" : ""}</strong><span class="subtle">${i.biten} / ${i.toplam} dosya tamamlandı</span></div>${not}</div>`;
  });
  const kuyruk = bekleyen
    ? `<p class="subtle">${bekleyen} iş sırada.</p>`
    : "";
  return `${sira.join("")}${satirlar.join("")}${kuyruk}<p class="subtle">Duraklatma, devam ve iptal düğmeleri İşlemler ekranındadır.</p>`;
}
// Aynı HTML'i her turda yeniden yazmak odak ve seçimi bozar; imza değişmedikçe
// DOM'a dokunulmaz. Yeni bir zamanlayıcı KURULMAZ — şerit app.js'in mevcut
// 5 sn'lik `poll` turundan beslenir.
let sonDurumImza = null;
// ELLE UI KONTROLÜNDE YAKALANAN KUSUR (P16 incelemesi): önbellek yalnız
// #arsiv-durum YOKKEN sıfırlanıyordu. Ekran değiştirip 5 sn'lik tur geçmeden
// geri dönüldüğünde renderArchive() TAZE (boş, hidden) bir kapsayıcı yaratıyor
// ama imza aynı kaldığı için erken dönülüyor ve şerit gizli kalıyordu. İndirme
// sürerken imza her turda değiştiğinden kendiliğinden düzeliyordu; "Evrak
// listesi alınıyor…" aşamasında, yalnız bekleyen iş varken ya da sıra satırı
// sabitken imza DEĞİŞMEZ ve şerit süresiz gizli kalıyordu. Bu yüzden önbellek
// artık yazdığı ELEMENTİ de hatırlıyor: element yenilendiyse imza aynı olsa
// bile yeniden yazılır.
let sonDurumKok = null;
export function arsivDurumTazele() {
  const kok = $("#arsiv-durum");
  if (!kok) {
    sonDurumImza = null;
    sonDurumKok = null;
    return;
  }
  const html = arsivDurumHTML(state.jobs, state.batches);
  if (html === sonDurumImza && kok === sonDurumKok) return;
  sonDurumImza = html;
  sonDurumKok = kok;
  kok.innerHTML = html;
  kok.hidden = html === "";
}
function filteredCases() {
  return state.cases.filter((c) =>
    `${c.birimAdi} ${c.dosyaNo}`
      .toLocaleLowerCase("tr")
      .includes(state.caseFilter.toLocaleLowerCase("tr")),
  );
}
function renderCases() {
  if (!$("#case-list")) return;
  $("#case-count").textContent = state.archiveLoaded
    ? `(${state.cases.length})`
    : "";
  const items = filteredCases();
  $("#case-list").innerHTML = items.length
    ? items.map((c) => davaSatiri(c)).join("")
    : empty(
        state.archiveLoaded
          ? state.caseFilter
            ? "Eşleşen dosya bulunamadı"
            : "Arşiviniz henüz boş"
          : "Arşiv yükleniyor",
        state.archiveLoaded && !state.caseFilter
          ? "Dosyalar ekranından bir dosya indirerek başlayın."
          : "",
        !state.archiveLoaded,
      );
  $("#case-list")
    .querySelectorAll("[data-case]")
    .forEach(
      (button) =>
        (button.onclick = () =>
          selectCase(decodeURIComponent(button.dataset.case))),
    );
  $("#case-list")
    .querySelectorAll("[data-select-case]")
    .forEach((input) => {
      input.onchange = () => {
        const key = decodeURIComponent(input.dataset.selectCase);
        input.checked
          ? state.batchSelection.add(key)
          : state.batchSelection.delete(key);
        renderBatchSelection();
      };
    });
  renderBatchSelection();
}
/**
 * P16 — dava satırlarındaki sorun rozetini tazeler.
 *
 * ELLE UI KONTROLÜNDE YAKALANDI: bir kaydı yoksaydıktan sonra başlıktaki rozet
 * ve sekme sayacı 4→3 düşerken dava satırı "3 sorun" demeye devam ediyordu —
 * yani AYNI SORUN İKİ YERDE FARKLI SAYILIYORDU. `sorunlariCiz()` yalnız sorun
 * sütununu çizer; dava sütunu bu fonksiyonla eşitlenir.
 *
 * İmza değişmedikçe DOM'a dokunulmaz: her eylemden sonra listeyi yeniden
 * çizmek gereksiz DOM işidir ve seçim/odak durumunu sarsar.
 */
let sonSorunImza = null;
export function sorunRozetleriniTazele() {
  if (!$("#case-list")) {
    sonSorunImza = null;
    return;
  }
  const imza = (state.issues?.acik ?? [])
    .map((x) => `${x.caseKey}:${x.sayilir === false ? 0 : 1}`)
    .sort()
    .join("|");
  if (imza === sonSorunImza) return;
  sonSorunImza = imza;
  renderCases();
}
export function renderBatchSelection() {
  if (!$("#sync-batch")) return;
  const count = state.batchSelection.size;
  $("#batch-preview").textContent = `${count} dosya seçildi. Aynı anda bir dosya işlenir; en fazla 50 dosya seçilebilir.`;
  $("#sync-batch").disabled =
    !count ||
    count > 50 ||
    pendingActions.has("sync-batch") ||
    state.batches.some((b) => b.durum === "calisiyor");
  const visible = filteredCases().filter((c) => c.klonYolu);
  $("#batch-select-visible").checked =
    visible.length > 0 && visible.every((c) => state.batchSelection.has(c.caseKey));
  $("#batch-select-visible").indeterminate =
    !$("#batch-select-visible").checked &&
    visible.some((c) => state.batchSelection.has(c.caseKey));
}
/**
 * Evrak listesinin HTML'i. Ek evraklar ana evrakın altında gruplanır
 * (web/evrak-durum.js `evrakGruplari`). Grup KATLANMAZ: katlama bir ekin
 * varlığını ilk bakışta gizlerdi; burada yalnız girinti ve üye özeti var.
 * data-document düğmeleri aynı kaldığı için olay bağlama değişmez.
 */
export function evrakListesiHTML(evraklar, secili = state.selectedDocument) {
  return evrakGruplari(evraklar)
    .map((g) => {
      if (!g.oksuz && g.ekler.length === 0) return evrakSatiri(g.ana, secili);
      return `<div class="doc-group">${g.ana ? evrakSatiri(g.ana, secili) : ""}<p class="doc-group-head">${escape(grupBasligi(g))}</p><div class="doc-group-members">${g.ekler.map((e) => evrakSatiri(e, secili)).join("")}</div></div>`;
    })
    .join("");
}
function renderDocuments() {
  if (!$("#document-list")) return;
  $("#sync-case").disabled =
    !state.selectedCase || pendingActions.has("sync-case");
  $("#open-folder").disabled =
    !state.selectedCase || pendingActions.has("open-folder");
  const docs = state.documents.filter((d) =>
    `${d.tur} ${d.path} ${d.category}`
      .toLocaleLowerCase("tr")
      .includes(state.documentFilter.toLocaleLowerCase("tr")),
  );
  const suzuldu = docs.length !== state.documents.length;
  $("#document-count").textContent = !state.selectedCase
    ? ""
    : `${suzuldu ? `(${docs.length}/${state.documents.length} gösteriliyor)` : `(${state.documents.length})`}${docs.length ? ` · ${ozetMetni(evrakOzeti(docs), { suzuldu })}` : ""}`;
  $("#document-list").innerHTML = !state.selectedCase
    ? empty("Bir dosya seçin", "Dosyanın evrakları burada listelenir.")
    : docs.length
      ? evrakListesiHTML(docs)
      : empty(
          state.documentFilter
            ? "Eşleşen evrak bulunamadı"
            : "Bu dosyada evrak yok",
        );
  $("#document-list")
    .querySelectorAll("[data-document]")
    .forEach(
      (button) =>
        (button.onclick = () => selectDocument(button.dataset.document)),
    );
}
export async function refreshArchive(force = false) {
  const id = ++archiveRequest;
  // Hazırlık özeti dava satırının SAYI kaynağıdır; ama başarısız olursa arşiv
  // listesi yine de çizilmeli — o durumda satır registry sayacına "(kayıtlı)"
  // notuyla düşer. Her iki çağrı da yalnız yerel dosya okur, portala gitmez.
  const [data, ozet] = await Promise.all([
    api("davalar"),
    api("hazirlik-ozet").catch(() => null),
  ]);
  if (id !== archiveRequest) return;
  if (ozet)
    state.hazirlikOzetleri = new Map(
      (ozet.ozetler || []).map((o) => [o.caseKey, o]),
    );
  state.cases = data.davalar || [];
  state.batchSelection = new Set(
    [...state.batchSelection].filter((k) =>
      state.cases.some((c) => c.caseKey === k && c.klonYolu),
    ),
  );
  state.archiveLoaded = true;
  if (state.selectedCase && !currentCase()) {
    state.selectedCase = null;
    state.documents = [];
    state.sonEsitleme = null;
    state.selectedDocument = null;
    state.preview = null;
    selectionGeneration++;
  }
  renderCases();
  sorunlariCiz();
  if (state.selectedCase && force) await refreshDocuments();
  else renderDocuments();
}
export async function selectCase(key) {
  if (key === state.selectedCase) return;
  state.selectedCase = key;
  // P07b — sekme hafızası dava değişince BOŞALIR: başka dosyanın safahatını
  // ya da taraf adlarını göstermek bu üründeki en kötü hatadır.
  state.detay = { caseKey: key, sekmeler: {} };
  state.selectedDocument = null;
  state.documents = [];
  state.sonEsitleme = null;
  state.preview = null;
  state.view = "evrak";
  state.previewError = null;
  state.previewLoading = false;
  selectionGeneration++;
  renderCases();
  renderDocuments();
  renderPreview();
  // Sorun sekmesi seçimi izler: kapsam "dava" ise liste yeni davaya daralır.
  sorunlariCiz();
  // P06a — denetim sekmesi de seçimi izler ama YALNIZ kapsam düğmesi ve özet
  // satırı tazelenir; DENETİM YENİDEN KOŞMAZ. Eldeki rapor olduğu gibi kalır ve
  // hangi kapsamda alındığını kendisi yazar.
  denetimCiz();
  await refreshDocuments().catch((error) => {
    if (state.selectedCase === key && $("#document-list"))
      $("#document-list").innerHTML = errorHTML(error);
  });
}
/**
 * Seçili davanın evrak listesini tazeler.
 *
 * P15c DÜZELTMESİ — satır rozeti ile "Asıl belgeyi aç" düğmesi AYNI ölçümden
 * beslenir. Eskiden bu fonksiyon yalnız renderDocuments() ile bitiyordu, düğmeyi
 * kapatan/açan mantık ise yalnız renderPreview() içindeydi; seçili evrak listede
 * durduğu sürece renderPreview hiç çalışmıyordu. Sonuç iki yönde de yanlıştı:
 * silinen belgede satır "Eksik" derken düğme AÇIK kalıyor, geri gelen belgede
 * satır düzelirken düğme KAPALI kalıyordu.
 *
 * İkinci renderPreview çağrısı tek başına yetmez: `seciliKaynak()` önce
 * `state.preview.kaynakDurum`a bakar, o da seçim anında alınmış BAYAT ölçümdür.
 * Bu yüzden önce önizlemedeki ölçüm taze satır ölçümüyle eşitlenir.
 *
 * Önizleme yalnız ölçüm DEĞİŞTİYSE yeniden çizilir; koşulsuz çizim her ↻'de
 * metnin kaydırma konumunu başa alırdı.
 */
export async function refreshDocuments() {
  const key = state.selectedCase,
    id = ++documentRequest;
  if (!key) return;
  const data = await api("evraklar", { caseKey: key });
  if (state.selectedCase !== key || id !== documentRequest) return;
  const oncekiKaynak = seciliKaynak();
  state.documents = data.evraklar || [];
  // P15b — işaretçi evrak listesiyle AYNI yanıttan gelir; ayrı çağrıyla
  // alınsaydı iki yanıt farklı eşitlemelere ait olabilir ve rozet yanlış
  // satırlara düşerdi.
  state.sonEsitleme = data.sonEsitleme ?? null;
  const satir = state.selectedDocument
    ? state.documents.find((d) => d.path === state.selectedDocument)
    : undefined;
  let onizlemeyiCiz = false;
  if (state.selectedDocument && !satir) {
    state.selectedDocument = null;
    state.preview = null;
    selectionGeneration++;
    onizlemeyiCiz = true;
  } else if (
    state.preview &&
    satir &&
    typeof satir.kaynakDurum === "string" &&
    satir.kaynakDurum !== state.preview.kaynakDurum
  ) {
    // SESSİZ VARSAYILAN korunur: ölçüm taşımayan satır (eski motor) önizlemedeki
    // değeri EZMEZ, yalnız gerçekten ölçülmüş bir değer yerine geçer.
    state.preview = { ...state.preview, kaynakDurum: satir.kaynakDurum };
  }
  renderDocuments();
  if (onizlemeyiCiz || seciliKaynak() !== oncekiKaynak) renderPreview();
}
async function selectDocument(path) {
  state.selectedDocument = path;
  state.view = "evrak";
  state.preview = null;
  state.previewError = null;
  state.previewLoading = true;
  const generation = ++selectionGeneration,
    key = state.selectedCase;
  renderDocuments();
  renderPreview();
  try {
    const data = await api("evrak-oku", { caseKey: key, path });
    if (generation !== selectionGeneration) return;
    state.preview = data;
  } catch (error) {
    if (generation !== selectionGeneration) return;
    state.previewError = error.message;
  } finally {
    if (generation === selectionGeneration) {
      state.previewLoading = false;
      renderPreview();
    }
  }
}
function renderPreview() {
  const root = $("#preview");
  if (!root) return;
  const c = currentCase();
  if (!c) {
    root.innerHTML = empty(
      "Arşiviniz elinizin altında",
      "İncelemek için bir dosya ve evrak seçin.",
    );
    return;
  }
  root.innerHTML = `<div class="preview-head"><span class="eyebrow">${escape(c.dosyaNo)}</span><h2>${escape(c.birimAdi)}</h2><div class="tabs" aria-label="Dosya ayrıntıları">${[
    ["evrak", "Evrak"],
    ["safahat", "Safahat"],
    ["taraflar", "Taraflar"],
    ["hesap", "Hesap"],
  ]
    .map(
      ([id, title]) =>
        `<button data-detail="${id}" class="${state.view === id ? "active" : ""}" aria-pressed="${state.view === id}">${title}</button>`,
    )
    .join(
      "",
    )}</div>${state.view === "evrak" && state.selectedDocument ? '<div class="actions"><button id="open-document">Asıl belgeyi aç ↗</button><button id="retry-preview" class="quiet">Metni yenile</button></div>' : ""}</div><div class="preview-body" id="preview-content"></div>`;
  root.querySelectorAll("[data-detail]").forEach(
    (button) =>
      (button.onclick = () => {
        if (button.dataset.detail === "evrak") {
          if (!state.preview && state.selectedDocument) {
            selectDocument(state.selectedDocument);
            return;
          }
          state.view = "evrak";
          selectionGeneration++;
          state.previewLoading = false;
          state.previewError = null;
          renderPreview();
        } else loadDetail(button.dataset.detail);
      }),
  );
  if ($("#open-document"))
    $("#open-document").onclick = (e) =>
      action(e.currentTarget, () =>
        api("evrak-ac", {
          caseKey: state.selectedCase,
          path: state.selectedDocument,
        }),
      );
  if ($("#retry-preview")) {
    $("#retry-preview").disabled = state.previewLoading;
    $("#retry-preview").onclick = () => selectDocument(state.selectedDocument);
  }
  updatePending();
  // P15c — kaynağı diskte olmayan/erişilemeyen evrakta "Asıl belgeyi aç"
  // KAPANIR: bugüne kadar düğme tıklanıyor, sunucu ham `ENOENT … stat
  // '/mutlak/yol'` döndürüyordu. updatePending()'den SONRA: o yalnız
  // data-busy taşıyan düğmeleri yeniden açar, bunu geri açmaz.
  const kaynak = seciliKaynak();
  const acDugme = $("#open-document");
  if (acDugme && kaynakSorunlu({ kaynakDurum: kaynak })) {
    acDugme.disabled = true;
    acDugme.title = kaynakUyarisi(kaynak) ?? "";
  }
  const body = $("#preview-content");
  // P07b — ayrıntı sekmeleri KENDİ durumunu taşır (state.detay); evrak
  // önizlemesinin `previewLoading`/`previewError` alanlarına bakmaz. Aksi
  // hâlde yarıda kalmış bir evrak yüklemesi safahat sekmesini "Yükleniyor…"
  // ekranında kilitlerdi.
  if (state.view !== "evrak") {
    // Ham alan adı ve JSON metni YOK: başlıklar motorun `gorunum` yapısından
    // gelir (src/uyap/detay-goster.ts).
    body.innerHTML = detayHTML(state.view, detayKutusu(state.view));
    const yenile = $("#detay-yenile");
    if (yenile)
      yenile.onclick = (e) =>
        action(e.currentTarget, () => loadDetail(state.view, true));
    return;
  }
  if (state.previewLoading) {
    body.innerHTML = empty("Yükleniyor…", "", true);
    return;
  }
  if (state.previewError) {
    body.innerHTML = errorHTML(state.previewError);
    return;
  }
  if (!state.selectedDocument) {
    body.innerHTML = empty(
      "Bir evrak seçin",
      "Hazır metin burada görüntülenir. Asıl belgeyi kendi uygulamasında açabilirsiniz.",
    );
    return;
  }
  if (state.preview?.metin == null) {
    // Boş önizleme tek tip bir cümle değil: sebebi söyler. `hazirlik` alanı
    // evrak-oku yanıtında TÜRETİLİR (src/server/belgeler.ts), manifest'e yazılmaz.
    // P15c — metin de yoksa ÖNCE kaynak sebebi gelir: "dönüşüm bekliyor" demek,
    // dosyanın hiç yerinde olmadığı bir evrakta yanlış beklenti kurar.
    const [baslik, aciklama] =
      kaynakBosluk(kaynak) ?? onizlemeBosluk(state.preview?.hazirlik);
    body.innerHTML = empty(baslik, aciklama);
    return;
  }
  const pre = document.createElement("pre");
  pre.textContent = state.preview.metin;
  // P15c — KARAR (Eksik 3): kaynak yok/erişilemez olsa da önizleme AÇIK kalır;
  // metnin daha önce üretilmiş bir kopya olduğu üstünde tek satırla söylenir.
  const uyari = kaynakUyarisi(kaynak);
  if (!uyari) {
    body.replaceChildren(pre);
    return;
  }
  const not = document.createElement("div");
  not.className = "notice";
  not.textContent = uyari;
  body.replaceChildren(not, pre);
}

/**
 * Seçili evrakın KAYNAK durumu. Öncelik `evrak-oku` yanıtındadır (seçim anında
 * alınmış en taze ölçüm); yanıt henüz gelmediyse liste satırındaki ölçüme
 * düşülür, böylece düğme yüklenirken de doğru durumda olur. İkisi de yoksa
 * undefined döner ve hiçbir şey kısıtlanmaz (eski motor yanıtı).
 */
function seciliKaynak() {
  const taze = state.preview?.kaynakDurum;
  if (typeof taze === "string") return taze;
  return state.documents.find((d) => d.path === state.selectedDocument)
    ?.kaynakDurum;
}
/**
 * Seçili davanın sekme hafızası. Dava değişmişse kutular sıfırlanır: başka
 * dosyanın safahatını göstermek bu üründeki en kötü hatadır.
 */
function detayKutulari() {
  if (state.detay.caseKey !== state.selectedCase)
    state.detay = { caseKey: state.selectedCase, sekmeler: {} };
  return state.detay.sekmeler;
}
export function detayKutusu(ad) {
  const kutular = detayKutulari();
  if (!kutular[ad]) kutular[ad] = bosKutu();
  return kutular[ad];
}
/**
 * Sekme verisini getirir. SEKMEYE DÖNMEK YENİ İSTEK DOĞURMAZ: kutuda sonuç
 * varsa (ya da bir istek sürüyorsa) portala gidilmez, eldeki sonuç ölçüm
 * zamanıyla yeniden çizilir. `zorla` yalnız "Yenile" düğmesinden gelir.
 */
async function loadDetail(name, zorla = false) {
  state.view = name;
  const kutu = detayKutusu(name);
  if (!sorgulanmaliMi(kutu, zorla)) {
    renderPreview();
    return;
  }
  kutu.yukleniyor = true;
  const generation = ++selectionGeneration,
    key = state.selectedCase;
  renderPreview();
  let sonuc;
  try {
    const data = await api(name, { caseKey: key });
    sonuc = {
      veri: {
        adet: data.adet ?? (data.satirlar || []).length,
        gorunum: data.gorunum,
        sira: data.sira ?? null,
        sorguAt: data.sorguAt ?? null,
        onbellekten: data.onbellekten === true,
      },
    };
  } catch (error) {
    sonuc = { hata: { mesaj: error.message, kod: error.kod ?? null } };
  }
  // Geciken yanıt EKRANA YAZILMAZ (sürüm değişmişse), ama "yükleniyor"
  // bayrağı KOŞULSUZ düşer — bayrağı korumanın içinde bırakmak sekmeyi
  // kalıcı "Yükleniyor…" ekranında kilitliyordu (bkz. kutuTamamla).
  const yazilsin = generation === selectionGeneration;
  kutuTamamla(kutu, { ...sonuc, yazilsin });
  if (yazilsin) renderPreview();
}

/**
 * Duran yaş satırını tazeler. YENİ İSTEK YOK: yalnız `.detay-durum` metni
 * yeniden yazılır. 5 sn'lik `poll` turundan çağrılır (app.js); ayrı bir
 * zamanlayıcı kurulmaz.
 */
export function detayYasiTazele() {
  if (state.page !== "indirilenler" || state.view === "evrak") return;
  const satir = $(".detay-durum p");
  if (!satir) return;
  const kutu = state.detay?.sekmeler?.[state.view];
  if (!kutu || state.detay.caseKey !== state.selectedCase) return;
  const metin = yasTazelemeMetni(kutu);
  if (metin !== null && satir.textContent !== metin) satir.textContent = metin;
}
// Her eylemden sonra arşiv düğmelerinin ve toplu seçim özetinin tazelenmesi.
// Eskiden action()'ın finally bloğundaydı; sırası ve guard'ı aynen korunur.
kanca.eylemSonrasi.push(() => {
  if (state.page === "indirilenler") {
    const sync = $("#sync-case"),
      folder = $("#open-folder");
    if (sync)
      sync.disabled = !state.selectedCase || pendingActions.has("sync-case");
    if (folder)
      folder.disabled =
        !state.selectedCase || pendingActions.has("open-folder");
    arsivDurumTazele();
    // Yoksay/geri al `action()` üzerinden geçer; dava satırı buradan eşitlenir.
    sorunRozetleriniTazele();
  }
  renderBatchSelection();
});
