// İşlemler ekranı: iş kartları, toplu sıra kartları ve fren özeti. Kart HTML'i
// web/toplu.js'te üretilir; burası DOM'a yazar ve olayları bağlar.
//
// P16 — SORUN LİSTESİ BURADAN ÇIKTI. Sorunlar artık İndirilenler ekranındaki
// "Sorunlar" sekmesinde, tek modülde (web/sorunlar.js) yaşıyor. Bu dosyaya
// ikinci bir kopya EKLENMEZ: iki ekranda iki liste, iki farklı sayı demektir.
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
import { topluKartlar, frenMetni, evrakSonucu } from "./toplu.js";

/**
 * P06b — SEÇİLİ ONARIM işinin sonucu. `evrakSonucu` eşitleme sayaçlarını
 * (yeni/yenilenen/korunan) yazar; onarımda o sayaçlar YOKTUR ve yazılsaydı
 * kart "0 yeni evrak" diye yanıltırdı.
 */
export function onarimSonucu(sonuc) {
  if (!sonuc || typeof sonuc !== "object") return "";
  const istenen = Number(sonuc.istenen) || 0;
  if (!istenen) return "";
  const parcalar = [`${Number(sonuc.onarilan) || 0}/${istenen} evrak onarıldı`];
  if (Number(sonuc.atlanan) > 0)
    parcalar.push(`${Number(sonuc.atlanan)} satır zaten yerindeydi`);
  if (Number(sonuc.eksikEvrak) > 0)
    parcalar.push(`${Number(sonuc.eksikEvrak)} satır onarılamadı`);
  return `<p class="subtle">${escape(parcalar.join(" · "))}.</p>`;
}

const statusNames = {
  bekliyor: "Bekliyor",
  calisiyor: "Çalışıyor",
  hazir: "Tamamlandı",
  hata: "Hata",
  iptal: "İptal edildi",
  duraklatildi: "Duraklatıldı",
  eksikli: "Eksik kaldı",
  kesildi: "Yeniden başlatma nedeniyle kesildi",
};

export function renderOperations() {
  $("#page").innerHTML =
    `<section class="panel"><div class="row spread panel-title"><h2>İşlemler</h2><button id="refresh-operations" class="quiet">Yenile</button></div><p class="subtle">İşlem geçmişi yerel olarak saklanır. Kesilen veya eksik kalan işleri yeni oturum açtıktan sonra devam ettirebilirsiniz.</p><p class="subtle">Evrak sorunları İndirilenler ekranındaki “Sorunlar” sekmesinde, ilgili dosyanın yanında listelenir.</p><div id="fren-status"></div><div id="batch-list"></div><div id="job-list"></div></section>`;
  $("#refresh-operations").onclick = (e) =>
    action(e.currentTarget, () => kanca.poll());
  renderJobs();
}
// poll'ün durum turunda fren şeridini tazelemesi için; ekran açık değilse hiç
// dokunmaz (eski davranışın birebir karşılığı).
export function frenTazele(fren) {
  if ($("#fren-status")) $("#fren-status").innerHTML = frenMetni(fren);
}
export function renderJobs() {
  const root = $("#job-list");
  if (!root) return;
  $("#fren-status").innerHTML = frenMetni(state.status?.fren);
  $("#batch-list").innerHTML = topluKartlar(state.batches, state.jobs);
  $("#batch-list")
    .querySelectorAll("[data-batch]")
    .forEach((button) => {
      button.onclick = () =>
        action(button, async () => {
          await api(`toplu-${button.dataset.action}`, {
            id: button.dataset.batch,
          });
          await kanca.poll();
        });
    });
  const batchJobs = new Set(
    state.batches.flatMap((b) => b.dosyalar.flatMap((d) => d.denemeler)),
  );
  const recovery = state.status?.isDepo?.kurtarildi
    ? '<div class="notice" role="status">İş geçmişi yedekten kurtarıldı. Bozuk kopya korunmuştur; devam kararını siz verin.</div>'
    : "";
  root.innerHTML = state.jobs.length
    ? recovery +
      state.jobs
        .map((job) => {
          const total = Number(job.ilerleme?.toplam) || 0,
            done = Number(job.ilerleme?.biten) || 0,
            percent = total ? Math.min(100, (done / total) * 100) : 0;
          const devamEdildi = Boolean(job.devamIsId) || batchJobs.has(job.isId),
            devamMetni = batchJobs.has(job.isId)
              ? "Toplu eşitlemenin dosya sonucu. Yukarıdaki sıra düğmeleriyle yönetin."
              : job.devamIsId
                ? `Bu iş ${escape(job.devamIsId)} kimliğiyle devam ettirildi.`
                : job.oncekiIsId
                  ? `Önceki iş: ${escape(job.oncekiIsId)}`
                  : "";
          return `<article class="job"><div class="row spread wrap"><div><strong class="job-title">${escape(job.caseKey?.replaceAll("\u0000", " · ") || { klonla: "Dosya indirme", esitle: "Dosya eşitleme", onar: "Seçili onarım" }[job.tur] || job.tur || "İşlem")}</strong><div class="subtle">${escape(date(job.baslamaAt))}</div></div><span class="tag ${job.durum === "hazir" ? "good" : ["hata", "eksikli", "kesildi"].includes(job.durum) ? "bad" : ""}">${escape(statusNames[job.durum] || job.durum)}</span></div>${total ? `<div class="progress-track" aria-label="${done} / ${total} evrak"><span style="width:${percent}%"></span></div><div class="subtle">${done} / ${total} evrak</div>` : ""}${job.tur === "onar" ? onarimSonucu(job.sonuc) : evrakSonucu(job.sonuc)}${job.sonuc?.eksikEvrak > 0 ? `<p class="notice">${Number(job.sonuc.eksikEvrak)} ${job.tur === "onar" ? "evrak onarılamadı" : "evrak indirilemedi"}. Ayrıntılar İndirilenler ekranındaki Sorunlar sekmesinde.</p>` : ""}${job.hata ? `<p class="subtle">${escape(job.hata.message || job.hata)}</p>` : ""}${devamMetni ? `<p class="subtle">${devamMetni}</p>` : ""}<div class="actions" style="margin-top:10px">${!devamEdildi && ["calisiyor", "bekliyor"].includes(job.durum) ? `<button data-job="${escape(job.isId)}" data-action="duraklat">Duraklat</button>` : ""}${!devamEdildi && ["duraklatildi", "kesildi", "eksikli"].includes(job.durum) ? `<button data-job="${escape(job.isId)}" data-action="devam">Devam et</button>` : ""}${!devamEdildi && ["calisiyor", "bekliyor", "duraklatildi", "kesildi", "eksikli"].includes(job.durum) ? `<button data-job="${escape(job.isId)}" data-action="iptal" class="quiet">İptal et</button>` : ""}</div></article>`;
        })
        .join("")
    : recovery +
      empty(
        "Devam eden işlem yok",
        "Başlattığınız indirme ve eşitlemeler burada görünür.",
      );
  root.querySelectorAll("[data-job]").forEach(
    (button) =>
      (button.onclick = () =>
        action(button, async () => {
          await api(button.dataset.action, { isId: button.dataset.job });
          await kanca.poll();
        })),
  );
  updatePending();
}
