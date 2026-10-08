// Giriş noktası: gezinme, Dosyalar (portal) ekranı, Ayarlar, durum yoklaması ve
// açılış bağlantıları. Ortak ilkeller web/ortak.js'te; arşiv, işler ve ajanda
// ekranları kendi modüllerinde. Yeni bir modül eklenirse src/server/web.ts
// içindeki varlık izin listesine de eklenmelidir, yoksa sayfa boş açılır.
import {
  $,
  escape,
  state,
  api,
  toast,
  empty,
  errorHTML,
  isOnline,
  action,
  updatePending,
  updateStatus,
  kanca,
} from "./ortak.js";
import { portalSayfa, portalSonuclari } from "./portal.js";
import {
  tarafDugmesi,
  tarafSorgusuGerekli,
  tarafOzetiHTML,
  tarafOturumEngeli,
} from "./taraf.js";
import {
  renderArchive,
  refreshArchive,
  selectCase,
  renderBatchSelection,
  arsivDurumTazele,
  sorunRozetleriniTazele,
  detayYasiTazele,
} from "./arsiv.js";
import { renderOperations, renderJobs, frenTazele } from "./isler.js";
// P16 — sorun listesi tek modülde (web/sorunlar.js) ve tek ekranda
// (İndirilenler) yaşıyor; giriş noktası yalnız tazelemeyi tetikler.
import { refreshIssues, sorunSayilariAyristiMi } from "./sorunlar.js";
import { renderCalendar } from "./ajanda.js";
const titles = {
  indirilenler: [
    "İndirilenler",
    "Dosyalarınızı inceleyin, sorunları ilgili dosyanın yanında görün.",
  ],
  dosyalar: [
    "Dosyalar",
    "UYAP’taki dosyanızı bulun ve yerel arşivinize ekleyin.",
  ],
  islemler: [
    "İşlemler",
    "İndirme ve eşitlemelerin geçmişini takip edin, kesilen işleri devam ettirin.",
  ],
  ajanda: ["Ajanda", "Yaklaşan duruşma ve işlemlerinizi UYAP’tan sorgulayın."],
  ayarlar: ["Ayarlar", "Çalışma alanınız ve uygulama bilgileri."],
};
let pollBusy = false;
let portalRequest = 0;
// P18a — taraf düğmesinin oturum kapısı. Kapının kuralı web/taraf.js'te SAF
// fonksiyondadır (`tarafOturumEngeli`); burada yalnız canlı duruma bağlanır:
// liste hangi oturum sürümüyle alındıysa (`portal.surum`) canlı oturumun
// sürümüyle karşılaştırılır. Sürüm değişmediyse geçici bir "kontrol ediliyor"
// turu ya da henüz dönmemiş ilk yoklama düğmeyi KALICI olarak kapatmaz.
const tarafEngeli = () =>
  tarafOturumEngeli(state.status?.oturum, state.portal.surum);
// Dosyalar ekranı açıkken satırları yeniden çizen kapanış. renderPortal atar;
// `showCases` zaten sayfa/nesil kontrolü yaptığı için bayat referans zararsız.
let portalCiz = null;
/**
 * Oturum durumu her değiştiğinde (yalnız `poll` içinde olur) kapıyı yeniden
 * ölçer ve ÇİZİLENDEN farklıysa satırları yeniden çizer. Kapının iki yönü de
 * buradan işler: düğme kapanır ve GEREKTİĞİNDE yeniden AÇILIR.
 */
function tarafKapisiTazele() {
  if (state.page !== "dosyalar") return;
  if (tarafEngeli() === state.portal.cizilenEngel) return;
  portalCiz?.();
}
function navigate(page) {
  if (!titles[page]) page = "indirilenler";
  if (state.page === "dosyalar") {
    state.portal.scrollTop = window.scrollY;
    if (state.portal.loading) {
      portalRequest++;
      state.portal.loading = false;
      state.portal.progress = `${state.portal.cases.length} dosya · Sekme değiştiği için sorgu durduruldu; sonuçlar kısmi.`;
    }
  }
  state.nesil++;
  state.page = page;
  document.querySelectorAll("[data-page]").forEach((button) => {
    button.classList.toggle("active", button.dataset.page === page);
    button.setAttribute(
      "aria-current",
      button.dataset.page === page ? "page" : "false",
    );
  });
  $("#page-title").textContent = titles[page][0];
  $("#page-description").textContent = titles[page][1];
  if (location.hash !== `#${page}`) history.replaceState(null, "", `#${page}`);
  ({
    indirilenler: renderArchive,
    dosyalar: renderPortal,
    islemler: renderOperations,
    ajanda: renderCalendar,
    // Tanılama sayfaya GİRİŞTE bir kez ölçülür. poll() içindeki 5 sn'lik
    // renderSettings() çağrısı yalnız önbellekten çizer; oraya eklenirse tur
    // başına iki alt süreç doğar (python3 + pdftotext).
    ayarlar: () => {
      renderSettings();
      void refreshTani();
    },
  })[page]();
  updatePending();
}
function renderPortal() {
  const pageId = state.nesil;
  const portal = state.portal;
  $("#page").innerHTML =
    `<div class="notice" data-online ${isOnline() ? "hidden" : ""}>Dosya sorgulamak için UYAP’a giriş yapın. Yerel arşivinizi oturum açmadan kullanabilirsiniz.</div><section class="panel"><div class="panel-title"><h2>Dosyalarınız</h2><p class="subtle">Hukuk, ceza ve icra dosyalarınızı listeleyin veya esas numarasıyla arayın.</p><div class="row wrap"><button class="primary" id="list-all">Tüm dosyaları listele</button><button id="stop-list" hidden>Listelemeyi durdur</button></div><p class="subtle">İdari yargı, CBS, vatandaş ve yüksek mahkeme özel sorguları bu listeye dahil değildir.</p><p id="list-progress" role="status"></p></div><form id="portal-form" class="form-grid"><label>Mahkeme / birim<input name="birim" list="court-options" required placeholder="Örn. Denizli 1. İş Mahkemesi" autocomplete="off"></label><datalist id="court-options"></datalist><label>Esas yılı<input name="yil" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" required placeholder="2026" aria-label="Dört haneli esas yılı"></label><label>Esas sırası<input name="sira" inputmode="numeric" pattern="[0-9]+" required placeholder="123"></label><button class="primary" type="submit">Dosyayı sorgula</button></form></section><section class="panel" id="portal-results">${empty("Dosyanızı arşive ekleyin", "Sorgu sonuçlarından indireceğiniz dosyayı seçebilirsiniz.")}</section>`;
  ["birim", "yil", "sira"].forEach((name) => {
    const input = $("#portal-form [name=" + name + "]");
    if (input) input.value = portal.query[name];
  });
  const controls = document.createElement("div");
  controls.className = "panel portal-controls";
  controls.innerHTML =
    '<div class="row wrap"><label>Yerel ara<input id="portal-search" placeholder="Mahkeme, esas veya tür…"></label><label>Durum<select id="portal-status"><option value="tumu">Tümü</option><option value="acik">Açık</option><option value="kapali">Kapalı</option><option value="bilinmeyen">Diğer / belirsiz</option></select></label><label>Sırala<select id="portal-sort"><option value="mahkeme">Mahkeme</option><option value="esas">Esas no</option><option value="tur">Tür</option><option value="durum">Durum</option></select></label><button id="portal-direction" class="quiet" type="button"></button></div><p class="subtle" id="portal-summary"></p>';
  $("#portal-results").before(controls);
  $("#portal-search").value = portal.search;
  $("#portal-status").value = portal.status;
  $("#portal-sort").value = portal.sort;
  $("#portal-search").oninput = (e) => {
    portal.search = e.target.value;
    portal.page = 1;
    showCases(portal.cases);
  };
  $("#portal-status").onchange = (e) => {
    portal.status = e.target.value;
    portal.page = 1;
    showCases(portal.cases);
  };
  $("#portal-sort").onchange = (e) => {
    portal.sort = e.target.value;
    portal.page = 1;
    showCases(portal.cases);
  };
  $("#portal-direction").onclick = () => {
    portal.direction = portal.direction === "asc" ? "desc" : "asc";
    showCases(portal.cases);
  };
  $("#list-progress").textContent = portal.progress;
  api("birimler")
    .then((data) => {
      if (
        state.page === "dosyalar" &&
        pageId === state.nesil &&
        $("#court-options")
      )
        $("#court-options").innerHTML = (data.birimler || [])
          .map((b) => `<option value="${escape(b.birimAdi)}"></option>`)
          .join("");
    })
    .catch(() => {});
  // ── P18a — satır başına taraf ────────────────────────────────────────────
  // TIKLANMADIKÇA PORTALA İSTEK GİTMEZ. Listeyi açmak 29 dosya için 29 istek
  // atmak demek olurdu; kullanıcı bunu açıkça reddetti. Otomatik ya da toplu
  // çekme YOKTUR — yalnız tıklanan satır tek bir istek doğurur ve o satırın
  // sonucu bellekte tutulur (`state.portal.taraflar`, diske yazılmaz).
  // Kapı (`tarafEngeli`) modül seviyesindedir: yalnız çizim değil, `poll` de
  // ölçer ve ayrıştığında satırları yeniden çizdirir (bkz. tarafKapisiTazele).
  function tarafDugmeHTML(c) {
    const d = tarafDugmesi(portal.taraflar.get(c.dosyaId), {
      engel: tarafEngeli(),
    });
    return `${d.kapali ? "disabled " : ""}title="${escape(d.baslik)}">${escape(d.etiket)}</button>`;
  }
  function tarafSatiriHTML(c) {
    const kayit = portal.taraflar.get(c.dosyaId);
    if (kayit?.durum !== "geldi" && kayit?.durum !== "hata") return "";
    const govde =
      kayit.durum === "hata"
        ? `<span class="taraf-hata">${escape(kayit.mesaj || "Taraf bilgisi alınamadı.")}</span>`
        : tarafOzetiHTML(kayit.taraflar, escape, {
            adTavani: 3,
            rolTavani: 4,
          }) ||
          '<span class="subtle">Portal bu dosya için taraf döndürmedi.</span>';
    return `<tr class="taraf-satiri"><td colspan="5">${govde}</td></tr>`;
  }
  async function tarafGetir(c) {
    const kimlik = c?.dosyaId;
    if (!kimlik) return;
    // İkinci tıklama: "geldi" ve "yukleniyor" durumlarında istek DOĞMAZ.
    if (!tarafSorgusuGerekli(portal.taraflar.get(kimlik))) return;
    if (tarafEngeli()) return;
    const nesil = portal.tarafNesil;
    const surum = portal.surum;
    portal.taraflar.set(kimlik, { durum: "yukleniyor" });
    showCases(portal.cases);
    let kayit;
    try {
      const data = await api("liste-taraflar", { dosyaId: kimlik, surum });
      // Yanıt hangi dosyaya ait olduğunu söyler. Sorulan satır değilse HİÇBİR
      // ŞEY gösterilmez: yanlış dosyanın taraflarını göstermek bu üründeki en
      // kötü hatadır. (Sunucu ayrıca oturum sürümünü doğrular.)
      if (data.dosyaId !== kimlik)
        throw new Error("Yanıt başka bir dosyaya ait; listeyi yenileyin.");
      kayit = { durum: "geldi", taraflar: data.taraflar || [] };
    } catch (error) {
      kayit = { durum: "hata", mesaj: error.message };
    }
    // Liste arada yenilendiyse bellek düşmüştür; geç gelen yanıt yazılmaz.
    if (nesil !== portal.tarafNesil) return;
    portal.taraflar.set(kimlik, kayit);
    showCases(portal.cases);
  }
  /** Liste yenilendi: taraf belleği düşer, oturum damgası yeniden alınır. */
  function tarafBellegiDusur() {
    portal.taraflar.clear();
    portal.tarafNesil++;
    portal.surum = null;
  }
  function showCases(cases) {
    portal.cases = cases;
    if (
      !(
        state.page === "dosyalar" &&
        pageId === state.nesil &&
        $("#portal-results") &&
        $("#portal-summary")
      )
    )
      return;
    // Bu çizimin dayandığı oturum kapısı. `poll` bununla karşılaştırır: kapı
    // değiştiyse satırlar yeniden çizilir, değişmediyse DOM'a dokunulmaz.
    portal.cizilenEngel = tarafEngeli();
    const filtered = portalSonuclari(cases, portal);
    const page = portalSayfa(filtered, portal.page, portal.pageSize);
    portal.page = page.page;
    $("#list-progress").textContent = portal.progress;
    $("#portal-summary").textContent =
      `${filtered.length} / ${cases.length} dosya · Sayfa ${page.page}/${page.totalPages}`;
    $("#portal-direction").textContent =
      portal.direction === "asc" ? "A→Z" : "Z→A";
    $("#portal-results").innerHTML = page.items.length
      ? `<div class="table-wrap"><table><thead><tr><th>Mahkeme</th><th>Esas no</th><th>Tür</th><th>Durum</th><th></th></tr></thead><tbody>${page.items.map((c, i) => `<tr><td>${escape(c.birimAdi)}</td><td>${escape(c.esasNo)}</td><td>${escape(c.dosyaTur || "—")}</td><td>${escape(c.dosyaDurum || "Bilinmeyen")}</td><td class="row wrap"><button data-taraflar="${i}" ${tarafDugmeHTML(c)}<button class="primary" data-download="${i}" ${/^\d{4}\/\d+$/.test(c.esasNo) ? "" : 'disabled title="Birleşik esas numaralı dosyaların indirilmesi henüz desteklenmiyor"'}>${/^\d{4}\/\d+$/.test(c.esasNo) ? (state.cases.some((k) => k.birimAdi === c.birimAdi && k.dosyaNo === c.esasNo) ? "Arşivi aç" : "Arşive indir") : "Yalnız listeleme"}</button></td></tr>${tarafSatiriHTML(c)}`).join("")}</tbody></table></div><div class="row spread portal-pages"><span class="subtle">${filtered.length ? (page.page - 1) * portal.pageSize + 1 : 0}–${Math.min(page.page * portal.pageSize, filtered.length)} / ${filtered.length}</span><span class="row"><button id="portal-prev" ${page.page <= 1 ? "disabled" : ""}>Önceki</button><button id="portal-next" ${page.page >= page.totalPages ? "disabled" : ""}>Sonraki</button></span></div>`
      : empty(
          portal.loading
            ? "Dosyalar sorgulanıyor…"
            : !portal.loaded
              ? "Dosyalarınızı listeleyin"
              : cases.length
                ? "Yerel filtreye uyan dosya yok"
                : "Dosya bulunamadı",
          cases.length
            ? "Yerel arama veya durum filtresini değiştirin."
            : portal.loaded
              ? "Sorgu tamamlandı; sonuç boş."
              : "Tüm dosyaları listeleyin veya mahkeme ve esas numarasıyla arayın.",
          portal.loading,
        );
    if (portal.error)
      $("#portal-results").insertAdjacentHTML(
        "afterbegin",
        errorHTML({ message: portal.error }),
      );
    document.querySelectorAll("[data-download]").forEach(
      (b) =>
        (b.onclick = () =>
          action(b, async () => {
            const c = page.items[Number(b.dataset.download)];
            if (
              state.cases.some(
                (k) => k.birimAdi === c.birimAdi && k.dosyaNo === c.esasNo,
              )
            ) {
              navigate("indirilenler");
              const archivePage = state.nesil;
              await refreshArchive();
              if (state.page !== "indirilenler" || state.nesil !== archivePage)
                return;
              const local = state.cases.find(
                (k) => k.birimAdi === c.birimAdi && k.dosyaNo === c.esasNo,
              );
              if (local) await selectCase(local.caseKey);
              return;
            }
            await api("klonla", {
              birim: c.birimAdi,
              esas: c.esasNo,
              kapsam: "hepsi",
            });
            toast(
              "İndirme başlatıldı. İşlemler ekranından takip edebilirsiniz.",
            );
            await poll();
          })),
    );
    document
      .querySelectorAll("[data-taraflar]")
      .forEach(
        (b) => (b.onclick = () => tarafGetir(page.items[Number(b.dataset.taraflar)])),
      );
    if ($("#portal-prev"))
      $("#portal-prev").onclick = () => {
        portal.page--;
        showCases(portal.cases);
      };
    if ($("#portal-next"))
      $("#portal-next").onclick = () => {
        portal.page++;
        showCases(portal.cases);
      };
    updatePending();
  }
  // Oturum kapısı değişince satırları yeniden çizecek kapanış (bkz. poll).
  portalCiz = () => showCases(portal.cases);
  showCases(portal.cases);
  requestAnimationFrame(() => {
    if (state.page === "dosyalar" && state.nesil === pageId)
      window.scrollTo(0, portal.scrollTop);
  });
  let stop = false;
  $("#stop-list").onclick = () => {
    stop = true;
    $("#stop-list").disabled = true;
  };
  $("#list-all").onclick = (event) =>
    action(event.currentTarget, async () => {
      const request = ++portalRequest;
      stop = false;
      tarafBellegiDusur();
      portal.cases = [];
      portal.error = null;
      portal.loaded = false;
      portal.loading = true;
      portal.progress = "Dosyalar sorgulanıyor…";
      portal.page = 1;
      showCases([]);
      const stopButton = $("#stop-list"),
        searchButton = $("#portal-form button[type=submit]");
      stopButton.hidden = false;
      stopButton.disabled = false;
      searchButton.disabled = true;
      const cases = [],
        seen = new Set();
      let next = {},
        pages = 0;
      const current = () => request === portalRequest;
      try {
        while (next && !stop && current()) {
          const data = await api("dosyalar-listele", next);
          if (!current()) return;
          // P18a — bu sayfadaki opak kimliklerin oturum damgası. Motor bunu
          // göndermiyorsa (eski sürüm çalışıyor olabilir) `null` kalır ve taraf
          // düğmesi sebebiyle birlikte KAPALI durur; tahminle sorgu atılmaz.
          portal.surum = Number.isInteger(data.surum) ? data.surum : null;
          let added = 0;
          for (const c of data.davalar || []) {
            if (!seen.has(c.dosyaId)) {
              seen.add(c.dosyaId);
              cases.push(c);
              added++;
            }
          }
          portal.loaded = true;
          showCases(cases);
          portal.progress = `${cases.length} dosya bulundu · ${data.kapsam} (${Number(data.kapsamIndex) + 1}/${data.kapsamSayisi})`;
          if (state.page === "dosyalar" && pageId === state.nesil)
            $("#list-progress").textContent = portal.progress;
          if (
            data.sinir ||
            ++pages >= 200 ||
            ((data.davalar || []).length && !added)
          )
            throw new Error(
              "Liste tamamlanamadı: sayfa sınırı veya tekrarlanan portal yanıtı. Bulunan dosyalar aşağıda korunuyor.",
            );
          next = data.sonraki;
        }
        if (current())
          portal.progress = `${cases.length} dosya · ${next ? "Listeleme durduruldu; sonuçlar kısmi" : "Desteklenen kapsamın listesi tamamlandı"} · ${new Date().toLocaleString("tr-TR")}`;
      } catch (error) {
        if (current()) {
          portal.error = `${cases.length} dosya bulundu; liste tamamlanmadı. ${error.message}`;
          portal.progress = `${cases.length} dosya bulundu; liste tamamlanmadı. ${error.message}`;
          if (state.page === "dosyalar" && pageId === state.nesil)
            showCases(cases);
        }
      } finally {
        if (current()) {
          portal.loading = false;
          portal.loaded = true;
        }
        if (current() && state.page === "dosyalar" && pageId === state.nesil) {
          stopButton.hidden = true;
          searchButton.disabled = false;
          showCases(portal.cases);
        }
      }
    });
  $("#portal-form").onsubmit = (event) => {
    event.preventDefault();
    const form = event.currentTarget,
      button = $("button[type=submit]", form),
      values = new FormData(form);
    portal.query = {
      birim: String(values.get("birim") || "").trim(),
      yil: String(values.get("yil") || ""),
      sira: String(values.get("sira") || ""),
    };
    action(button, async () => {
      const request = ++portalRequest;
      tarafBellegiDusur();
      portal.cases = [];
      portal.error = null;
      portal.loaded = false;
      portal.loading = true;
      portal.progress = "Dosya sorgulanıyor…";
      portal.page = 1;
      $("#list-all").disabled = true;
      $("#list-progress").textContent = "";
      $("#portal-results").innerHTML = empty("Dosya sorgulanıyor…", "", true);
      try {
        const data = await api("davalarim", {
          birim: values.get("birim").trim(),
          yil: values.get("yil"),
          sira: values.get("sira"),
          kapsam: "hepsi",
        });
        if (request !== portalRequest) return;
        portal.loaded = true;
        portal.surum = Number.isInteger(data.surum) ? data.surum : null;
        portal.progress = `${(data.davalar || []).length} dosya · Sorgu tamamlandı · ${new Date().toLocaleString("tr-TR")}`;
        showCases(data.davalar || []);
      } catch (error) {
        if (request === portalRequest) {
          portal.error = error.message;
          portal.progress = "Sorgu tamamlanamadı.";
        }
      } finally {
        if (request === portalRequest) {
          portal.loading = false;
          showCases(portal.cases);
          if (state.page === "dosyalar" && pageId === state.nesil)
            $("#list-all").disabled = false;
        }
      }
    });
  };
}
// P10a — tanılama panosu. `tani` yanıtı sırsızdır (token/çerez/dava bilgisi
// taşımaz) ama YEREL KLASÖR YOLLARI içerir; panelin altındaki uyarı bunun için
// duruyor. Değerler yalnız gösterilir, hiçbiri geri yazılmaz.
function taniSatirlari(t) {
  const kisaCommit = t.kaynak?.commit ? t.kaynak.commit.slice(0, 10) : "—";
  const dal = t.kaynak?.dal || (t.kaynak?.gitBicim === "detached" ? "(HEAD ayrık)" : "—");
  const d = t.kaynak?.derleme || {};
  const derlemeMetni =
    d.taze === true
      ? "güncel"
      : d.taze === false
        ? "kaynak dosyalar derlemeden yeni — değişiklik henüz çalışmıyor olabilir"
        : "ölçülemedi";
  const komut = t.kaynak?.kurulanKomut;
  const komutMetni = !komut
    ? "PATH'te tensipd bulunamadı"
    : `${komut.yol} → ${komut.cozulmus}${komut.ayniKokMu ? "" : " · BAŞKA klasör"}`;
  const sat = [
    ["Paket sürümü", t.surum?.paket || "—"],
    [
      "Çalışan motor sürümü",
      t.surum?.motor == null
        ? "—"
        : `${t.surum.motor}${t.surum.uyusuyorMu === false ? " · paketle UYUŞMUYOR" : ""}`,
    ],
    ["Çalışan kod klasörü", t.kaynak?.calisanKok || "—"],
    ["Dal / commit", `${dal} · ${kisaCommit}`],
    ["Derleme", derlemeMetni],
    ["Kurulu tensipd komutu", komutMetni],
    ["Node", `${t.calisma?.node || "—"} · ${t.calisma?.platform || "—"}/${t.calisma?.arch || "—"}`],
    ["Motor kimliği", t.calisma?.instanceId || "—"],
    ["PDF metin aracı", t.bagimlilik?.pdftotext?.var ? "kurulu" : "yok"],
    [
      "Tek örnek kilidi (python3)",
      t.bagimlilik?.python3?.fcntl ? "çalışıyor" : "eksik",
    ],
    [
      "Arşiv klasörü",
      t.arsiv?.kok
        ? `${t.arsiv.kok} · ${!t.arsiv.var ? "bulunamadı" : t.arsiv.yazilabilir ? "yazılabilir" : "yazma izni yok"}`
        : "—",
    ],
    ["Ayar klasörü", t.ayar?.dizin || "—"],
  ];
  return sat
    .map(([k, v]) => `<dt>${escape(k)}</dt><dd>${escape(v)}</dd>`)
    .join("");
}
function taniPaneli() {
  if (state.taniHata)
    return `<section class="panel"><div class="panel-title"><h2>Tanılama</h2></div>${errorHTML({ message: state.taniHata })}</section>`;
  const t = state.tani;
  if (!t)
    return `<section class="panel"><div class="panel-title"><h2>Tanılama</h2></div>${empty("Tanılama ölçülüyor", "Sürüm, çalışan kod ve yardımcı araçlar kontrol ediliyor.", true)}</section>`;
  const uyarilar = (t.uyarilar || [])
    .map((u) => `<div class="notice" role="status">${escape(u)}</div>`)
    .join("");
  return `<section class="panel"><div class="panel-title"><h2>Tanılama</h2><p class="subtle">Bir şey beklediğiniz gibi çalışmıyorsa önce buraya bakın.</p></div>${uyarilar}<dl class="details-grid">${taniSatirlari(t)}</dl><p class="subtle">${escape(t.not || "")}</p></section>`;
}
function renderSettings() {
  const s = state.status;
  $("#page").innerHTML =
    `<section class="panel"><div class="panel-title"><h2>Çalışma alanı</h2><p class="subtle">İndirilen dosyalar bu bilgisayardaki arşivinizde tutulur.</p></div><dl class="details-grid"><dt>Arşiv klasörü</dt><dd>${escape(s?.kok || "Bilgi bekleniyor…")}</dd><dt>Uygulama sürümü</dt><dd>${escape(s?.appVersion || "—")}</dd><dt>Portal</dt><dd>${escape(s?.portal || "—")}</dd><dt>Arşivdeki dosya</dt><dd>${s?.davaSayisi == null ? "—" : escape(s.davaSayisi)}</dd></dl></section>${taniPaneli()}<section class="panel"><h2>UYAP bağlantısı</h2><p>Giriş sırasında açılan tarayıcıdaki kimlik ve imza adımlarını tamamlayın. Oturum kapandığında indirdiğiniz belgelere erişmeye devam edebilirsiniz.</p></section>`;
}
let taniRequest = 0;
async function refreshTani() {
  const request = ++taniRequest;
  state.tani = null;
  state.taniHata = null;
  try {
    const t = await api("tani");
    if (request !== taniRequest) return;
    state.tani = t;
  } catch (error) {
    if (request !== taniRequest) return;
    state.taniHata = error.message;
  }
  if (state.page === "ayarlar") renderSettings();
}
async function poll() {
  if (pollBusy || document.hidden) return;
  pollBusy = true;
  // P07b incelemesi — ayrıntı sekmesindeki YAŞ CÜMLESİ ("… 3 dk önce") burada
  // tazelenir. Yeni istek yok, yeniden çizim yok: yalnız duran satırın metni
  // yeniden yazılır. Eskiden yaş yalnız yeniden çizimde hesaplandığı için
  // sekmede oturan kullanıcının ekranında "portaldan az önce alındı" donuyor,
  // bir saatlik önbellek verisi taze görünüyordu.
  detayYasiTazele();
  try {
    let isBitti = false;
    const [statusResult, jobsResult] = await Promise.allSettled([
      api("durum"),
      api("isler"),
    ]);
    const errors = [];
    if (statusResult.status === "fulfilled") {
      state.status = statusResult.value;
      updateStatus();
      // `state.status` YALNIZ burada değişir; taraf düğmesinin oturum kapısı da
      // yalnız buradan yeniden ölçülür. Kapı ayrıştıysa Dosyalar satırları
      // yeniden çizilir — düğme hem kapanır hem gerektiğinde yeniden AÇILIR.
      tarafKapisiTazele();
      if (state.page === "ayarlar") renderSettings();
      frenTazele(state.status.fren);
    } else errors.push(statusResult.reason.message);
    if (jobsResult.status === "fulfilled") {
      const previous = new Map(state.jobs.map((j) => [j.isId, j.durum]));
      const newJobs = jobsResult.value.isler || [];
      const finished = newJobs.some(
        (j) =>
          ["hazir", "eksikli", "hata", "iptal", "kesildi"].includes(j.durum) &&
          previous.get(j.isId) !== j.durum,
      );
      const batches = jobsResult.value.topluIsler || [];
      const changed =
        JSON.stringify(newJobs) !== JSON.stringify(state.jobs) ||
        JSON.stringify(batches) !== JSON.stringify(state.batches);
      state.batches = batches;
      renderBatchSelection();
      state.jobs = newJobs;
      if (changed) renderJobs();
      // P16 — kalıcı durum şeridi mevcut turdan beslenir: yeni RPC ve yeni
      // zamanlayıcı yok, yoklama sıklığı aynı 5 sn. Şerit imza değişmedikçe
      // DOM'a dokunmaz.
      arsivDurumTazele();
      if (finished) {
        isBitti = true;
        try {
          await refreshArchive(true);
        } catch (error) {
          errors.push(error.message);
        }
      }
    } else errors.push(jobsResult.reason.message);
    // ELLE UI KONTROLÜNDE YAKALANAN KUSUR (P16 incelemesi): sorun anlık
    // görüntüsü YALNIZ iş bitince tazeleniyordu, sol menü rozeti ise her
    // turda. Motor kaydı iş SÜRERKEN yazdığından aynı ekranda iki farklı sayı
    // duruyordu; kayıt son `finished` olayından sonra doğduğunda fark hiç
    // kapanmıyordu (45 sn'den uzun ölçüldü). Artık sayılar AYRIŞTIĞINDA da
    // tazeleniyor — durağan durumda ek istek yok, tur başına hâlâ iki istek.
    if (
      state.page === "indirilenler" &&
      (isBitti || sorunSayilariAyristiMi(state.status, state.issues))
    )
      try {
        await refreshIssues();
        sorunRozetleriniTazele();
      } catch (error) {
        errors.push(error.message);
      }
    $("#connection-error").hidden = !errors.length;
    $("#connection-error").textContent = errors.length
      ? `Bilgiler güncellenemedi: ${[...new Set(errors)].join(" ")}`
      : "";
  } finally {
    pollBusy = false;
  }
}
// Görünüm modülleri poll'ü doğrudan import etmez (ES döngüsü kurmamak için);
// giriş noktası kancaya bağlar.
kanca.poll = poll;
$("#login-button").onclick = (event) =>
  action(event.currentTarget, async () => {
    if (isOnline()) {
      await api("cikis");
      await poll();
      toast("UYAP oturumu kapatıldı.");
    } else {
      state.loginPending = true;
      updateStatus();
      toast("Açılan tarayıcıda UYAP girişini tamamlayın.");
      try {
        await api("giris");
        toast("UYAP giriş işlemi tamamlandı.");
      } finally {
        state.loginPending = false;
        await poll();
        updateStatus();
      }
    }
  });
$("#cancel-login").onclick = (e) =>
  action(e.currentTarget, async () => {
    await api("giris-iptal");
    state.loginPending = false;
    await poll();
    updateStatus();
  });
document
  .querySelectorAll("[data-page]")
  .forEach((button) => (button.onclick = () => navigate(button.dataset.page)));
window.addEventListener("hashchange", () => navigate(location.hash.slice(1)));
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) poll();
});
navigate(location.hash.slice(1) || "indirilenler");
poll();
setInterval(poll, 5000);
