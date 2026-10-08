// Kaçırma tek yerde: web/ortak.js. Buradaki eski ikiz kopya kaldırıldı.
import { escape as esc } from "./ortak.js";
const names = { calisiyor: 'Çalışıyor', duraklatildi: 'Duraklatıldı', kesildi: 'Kesildi', hazir: 'Tamamlandı', iptal: 'İptal edildi', hata: 'Hata', eksikli: 'Eksik evrak', bekliyor: 'Bekliyor' };
export function frenMetni(fren) {
  if (!fren) return '';
  return `<p class="subtle">Bugün ${Number(fren.gunlukSayac)} / ${Number(fren.gunlukTavan)} dosya işi başlatıldı · İstanbul saati.${fren.cooldownKalanSn > 0 ? ` Yeni iş için ${Number(fren.cooldownKalanSn)} sn bekleme var.` : ''}<br>Her eşitleme veya devam denemesi bir iş sayılır; evrak ve portal isteği sayısı değildir. Bu, uygulamanın koruyucu sınırıdır; UYAP'ın resmî kotası değildir.</p>`;
}
export function evrakSonucu(sonuc) {
  if (!sonuc || !Number.isFinite(sonuc.yeniEvrak)) return '';
  return `<p class="subtle">${Number(sonuc.yeniEvrak)} yeni · ${Number(sonuc.yenilenenEvrak) || 0} yeniden indirilen · ${Number(sonuc.korunanEvrak) || 0} korunan · ${Number(sonuc.eksikEvrak) || 0} eksik evrak</p>`;
}
/**
 * P16 — bir toplu sıranın "kaç dosya bitti / kaç dosya var" özeti. Hem işlem
 * kartları hem arşiv ekranındaki durum şeridi buradan besleniyor; iki ekranın
 * aynı sırayı farklı sayması bu yüzden mümkün değil.
 */
export function topluIlerleme(q, jobs) {
  const byId = new Map((jobs ?? []).map(j => [j.isId, j]));
  const dosyalar = q?.dosyalar ?? [];
  return {
    biten: dosyalar.filter(d => byId.get(d.denemeler.at(-1))?.durum === 'hazir').length,
    toplam: dosyalar.length,
  };
}
export function topluKartlar(queues, jobs) {
  const byId = new Map(jobs.map(j => [j.isId, j]));
  return [...queues].reverse().map(q => {
    const done = topluIlerleme(q, jobs).biten;
    return `<article class="job"><div class="row spread wrap"><strong>Toplu eşitleme · ${done} / ${q.dosyalar.length} dosya tamamlandı</strong><span class="tag ${q.durum === 'hazir' ? 'good' : ''}">${esc(names[q.durum])}</span></div>${q.talep && q.durum === 'calisiyor' ? '<p class="notice">Durdurma talebi alındı; sürmekte olan evrak işlemi bitince duracak. Sonraki dosya başlamayacak.</p>' : ''}${q.mesaj ? `<p class="notice">${esc(q.mesaj)}</p>` : ''}<ol class="batch-results">${q.dosyalar.map(d => {
      const job = byId.get(d.denemeler.at(-1));
      return `<li><strong>${esc(d.caseKey.replaceAll('\u0000', ' · '))}</strong><span class="subtle">${esc(job ? names[job.durum] : q.durum === 'iptal' ? 'Başlatılmadı (kuyruk iptal edildi)' : 'Sırada')}${d.denemeler.length > 1 ? ` · ${d.denemeler.length}. deneme` : ''}</span>${evrakSonucu(job?.sonuc)}${job?.hata ? `<p class="subtle">${esc(job.hata.message)}</p>` : ''}</li>`;
    }).join('')}</ol><div class="actions">${q.durum === 'calisiyor' && !q.talep ? `<button data-batch="${esc(q.id)}" data-action="duraklat">Sırayı duraklat</button>` : ''}${['duraklatildi', 'kesildi'].includes(q.durum) ? `<button data-batch="${esc(q.id)}" data-action="devam">Sıraya devam et</button>` : ''}${!['hazir', 'iptal'].includes(q.durum) && q.talep !== 'iptal' ? `<button class="quiet" data-batch="${esc(q.id)}" data-action="iptal">Sırayı iptal et</button>` : ''}</div></article>`;
  }).join('');
}
