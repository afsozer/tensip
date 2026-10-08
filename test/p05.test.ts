import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Fren } from '../src/core/fren.js';
import { daemonKur, type Daemon } from '../src/server/daemon.js';
import { ManifestDepo } from '../src/store/manifest.js';
import { caseKeyYap } from '../src/store/registry.js';
import { MockUyap, opakToken, type MockDava } from './mock-uyap/sunucu.js';
import { makeHtml, tmpKok } from './yardimci.js';
import type { TopluIs } from '../src/jobs/toplu.js';
import type { IsKaydi } from '../src/jobs/orchestrator.js';

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
test('P05: yeni süreç sayaç/cooldown değerlerini korur, bekleyen işleri devralmaz', () => {
  const t = tmpKok();
  try {
    const dosya = join(t.kok, 'fren.json');
    const f = new Fren({ dosya }); f.yukle(); f.isBaslamadan(); f.cooldownBaslat(120_000);
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `import { Fren } from './dist/src/core/fren.js'; const f = new Fren({dosya:process.argv[1]}); f.yukle(); console.log(JSON.stringify(f.durum()));`, dosya], { encoding: 'utf8' });
    const result = JSON.parse(output);
    assert.equal(result.gunlukSayac, 1); assert.equal(result.bekleyen, 0); assert.ok(result.cooldownKalanSn > 100);
  } finally { t.temizle(); }
});
test('P05: gün İstanbul gece yarısında değişir, UTC gece yarısında ve saati geri alınca sıfırlanmaz', () => {
  const t = tmpKok();
  try {
    let now = Date.parse('2026-09-10T20:59:59Z');
    const f = new Fren({ dosya: join(t.kok, 'fren.json'), simdi: () => now }); f.yukle(); f.isBaslamadan(); f.cooldownBaslat(60_000);
    now += 1000; assert.equal(f.durum().gunlukSayac, 0); assert.equal(f.durum().gun, '2026-09-11'); assert.equal(f.durum().cooldownKalanSn, 59);
    now += 60_000; f.isBaslamadan(); now = Date.parse('2026-09-11T00:00:01Z'); assert.equal(f.durum().gunlukSayac, 1);
    now = Date.parse('2026-09-10T20:00:00Z'); assert.equal(f.durum().gunlukSayac, 1);
  } finally { t.temizle(); }
});
test('P05: eşzamanlı kabul tavanı aşmaz, yazma hatası işi kabul etmez', async () => {
  const t = tmpKok();
  try {
    const dosya = join(t.kok, 'fren.json'), f = new Fren({ dosya, gunlukTavan: 1 }); f.yukle();
    const results = await Promise.allSettled([Promise.resolve().then(() => f.isBaslamadan()), Promise.resolve().then(() => f.isBaslamadan())]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(JSON.parse(readFileSync(dosya, 'utf8')).gunlukSayac, 1);
    const other = new Fren({ dosya, gunlukTavan: 4 }); other.yukle(); rmSync(dosya); mkdirSync(dosya);
    assert.throws(() => other.isBaslamadan(), /kaydedilemedi/); assert.equal(other.durum().gunlukSayac, 1); assert.equal(other.durum().bekleyen, 0);
  } finally { t.temizle(); }
});
for (const name of ['fren.json', 'toplu-isler.json']) test(`P05: bozuk ${name} korunur ve motor kilidi bırakılır`, async () => {
  const t = tmpKok(); let daemon: Daemon | undefined;
  try {
    const options = { ayarDir: t.kok, kok: join(t.kok, 'archive'), oturumYenileMs: 0 };
    writeFileSync(join(t.kok, name), '{broken'); daemon = daemonKur(options);
    await assert.rejects(daemon.rpc.baslat(), /okunamadı/); assert.equal(readFileSync(join(t.kok, name), 'utf8'), '{broken'); await daemon.kapat();
    rmSync(join(t.kok, name)); daemon = daemonKur(options); await daemon.rpc.baslat();
  } finally { await daemon?.kapat(); t.temizle(); }
});

async function harness() {
  const t = tmpKok();
  const davalar: MockDava[] = [1, 2, 3].map(n => ({ dosyaId: opakToken(`p05-case-${n}`), birimAdi: 'P05 Test Mahkemesi', birimId: 'p05', esasNo: `2026/${n}`, dosyaTur: 'Hukuk Dava Dosyası', dosyaDurum: 'Açık', yargiTuru: '0', evraklar: [{ evrakId: opakToken(`p05-doc-${n}`), tur: 'Dilekçe', gonderen: 'Test', tip: 'GLN', tarih: '10/09/2026', birimEvrakNo: String(n), durum: 'yuklu', contentTipi: 'text/html', icerik: makeHtml(`<p>Test ${n}</p>`) }] }));
  const mock = new MockUyap({ birimler: [{ birimId: 'p05', birimAdi: 'P05 Test Mahkemesi', yargiTuru: '0' }], davalar }); await mock.baslat();
  const options = { ayarDir: t.kok, kok: join(t.kok, 'archive'), portalUrl: mock.adres(), istekAralikMs: 15, oturumYenileMs: 0 };
  let daemon = daemonKur(options); await daemon.rpc.baslat(); daemon.oturum.girisYap('JSESSIONID=p05', 'manuel');
  const keys = davalar.map((d, i) => {
    const key = caseKeyYap(d.birimAdi, d.esasNo), klonYolu = join(options.kok, String(i));
    daemon.registry.koy({ caseKey: key, portal: 'avukat', kaynak: ['portal'], dosyaNo: d.esasNo, birimAdi: d.birimAdi, birimId: d.birimId, group: 'Hukuk', kod: 'H', yargiTuru: '0', isIcra: false, isCbs: false, kapsam: 'hepsi', portalGoruldu: '', klonYolu });
    new ManifestDepo(join(klonYolu, 'uyap-project.json')).yaz({ dosyaId: d.dosyaId, mahkeme: d.birimAdi, birimId: d.birimId, esasNo: d.esasNo, isIcra: false, clonedAt: '', evraklar: [] });
    return key;
  });
  const call = async (name: string, body = {}): Promise<any> => daemon.isleyiciler.get(name)!(body);
  const history = async (): Promise<{ isler: IsKaydi[]; topluIsler: TopluIs[] }> => call('isler');
  const until = async (predicate: (h: Awaited<ReturnType<typeof history>>) => boolean) => {
    for (let n = 0; n < 500; n++) { const h = await history(); if (predicate(h)) return h; await wait(10); }
    throw new Error('Beklenen toplu iş durumuna gelmedi');
  };
  return { t, mock, keys, davalar, call, history, until,
    restart: async () => { await daemon.kapat(); daemon = daemonKur(options); await daemon.rpc.baslat(); },
    close: async () => { await daemon.kapat(); await mock.durdur(); t.temizle(); },
  };
}
test('P05: üç dosya sırayla tamamlanır; yeni/yenilenen/korunan/eksik sayıları ayrılır', async () => {
  const h = await harness();
  try {
    await h.call('toplu-esitle', { caseKeys: h.keys });
    const first = await h.until(x => x.topluIsler[0]?.durum === 'hazir');
    assert.equal(first.isler.length, 3); assert.ok(first.isler.every(j => (j.sonuc as any).yeniEvrak === 1));
    for (let i = 1; i < 3; i++) assert.ok(first.isler[i]!.baslamaAt >= first.isler[i - 1]!.bitisAt!);
    // Bir dosya yerelde değişmiş, bir dosyanın kaynağı kayıp ve portal indirmesi başarısız.
    const paths = [0, 1].map(i => { const dir = join(h.t.kok, 'archive', String(i)); const m = new ManifestDepo(join(dir, 'uyap-project.json')).oku()!; return join(dir, m.evraklar[0]!.path); });
    writeFileSync(paths[0]!, 'yerel değişiklik'); rmSync(paths[1]!); h.davalar[1]!.evraklar[0]!.durum = 'hata';
    await h.call('toplu-esitle', { caseKeys: [h.keys[2], h.keys[0], h.keys[1]] });
    const second = await h.until(x => x.topluIsler[1]?.durum === 'duraklatildi');
    const jobs = second.isler.slice(3);
    assert.equal((jobs[0]!.sonuc as any).korunanEvrak, 1);
    assert.equal((jobs[1]!.sonuc as any).yeniEvrak, 0); assert.equal((jobs[1]!.sonuc as any).yenilenenEvrak, 1);
    assert.equal((jobs[2]!.sonuc as any).eksikEvrak, 1); assert.equal(jobs[2]!.durum, 'eksikli');
    assert.equal(readFileSync(paths[0]!, 'utf8'), 'yerel değişiklik');
  } finally { await h.close(); }
});
test('P05: ilk dosya hatasında kalan sıra korunur; restart ve açık devam sağlam dosyayı atlar', async () => {
  const h = await harness();
  try {
    h.davalar[1]!.evraklar[0]!.durum = 'hata';
    const batch = await h.call('toplu-esitle', { caseKeys: h.keys });
    const stopped = await h.until(x => x.topluIsler[0]?.durum === 'duraklatildi');
    assert.equal(stopped.isler.length, 2); assert.equal(stopped.isler[0]!.durum, 'hazir');
    const before = h.mock.istekler.length; await h.restart(); await wait(60); assert.equal(h.mock.istekler.length, before);
    h.davalar[1]!.evraklar[0]!.durum = 'yuklu'; await h.call('toplu-devam', { id: batch.id });
    const done = await h.until(x => x.topluIsler[0]?.durum === 'hazir');
    assert.deepEqual(done.topluIsler[0]!.dosyalar.map(d => d.denemeler.length), [1, 2, 1]);
  } finally { await h.close(); }
});
for (const action of ['duraklat', 'iptal']) test(`P05: ${action} sonrası yeni dosya başlamaz; çift başlatma reddedilir`, async () => {
  const h = await harness();
  try {
    const batch = await h.call('toplu-esitle', { caseKeys: h.keys });
    await assert.rejects(h.call('toplu-esitle', { caseKeys: h.keys }), /işlem sürüyor/);
    await assert.rejects(h.call('esitle', { caseKey: h.keys[2] }), /Toplu eşitleme/);
    await h.call(`toplu-${action}`, { id: batch.id });
    const stopped = await h.until(x => x.topluIsler[0]?.durum === (action === 'iptal' ? 'iptal' : 'duraklatildi'));
    assert.ok(stopped.isler.length <= 1); assert.equal(stopped.topluIsler[0]!.dosyalar[1]!.denemeler.length, 0);
    await h.restart(); assert.equal((await h.history()).topluIsler[0]!.durum, action === 'iptal' ? 'iptal' : 'duraklatildi');
    if (action === 'iptal') await assert.rejects(h.call('toplu-devam', { id: batch.id }), /devam edilemez/);
    else { await h.call('toplu-iptal', { id: batch.id }); const cancelled = (await h.history()).topluIsler[0]!; assert.equal(cancelled.durum, 'iptal'); assert.equal(cancelled.talep, undefined); }
  } finally { await h.close(); }
});
test('P05: oturum bitiminde kuyruk durur, cooldown restartta korunur ve otomatik giriş yapılmaz', async () => {
  const h = await harness();
  try {
    h.mock.gecerliCerezRegexAyarla(/JSESSIONID=another/);
    const batch = await h.call('toplu-esitle', { caseKeys: h.keys });
    const stopped = await h.until(x => x.topluIsler[0]?.durum === 'duraklatildi');
    assert.equal(stopped.isler.length, 1); assert.equal(stopped.isler[0]!.hata?.code, 'OTURUM_BITTI');
    const before = h.mock.istekler.length; await h.restart();
    const status = await h.call('durum', { yerel: true }); assert.ok(status.fren.cooldownKalanSn > 0); assert.equal(status.girisSuruyor, false);
    await h.call('toplu-devam', { id: batch.id });
    const retry = await h.until(x => x.topluIsler[0]?.durum === 'duraklatildi');
    assert.equal(retry.isler.at(-1)!.hata?.code, 'OTOMASYON_BUTCESI'); assert.equal(h.mock.istekler.length, before);
  } finally { await h.close(); }
});
test('P05: arşiv dışı, mükerrer ve boş seçim ağ erişiminden önce reddedilir', async () => {
  const h = await harness();
  try {
    const before = h.mock.istekler.length;
    for (const keys of [[], ['yok'], [h.keys[0], h.keys[0]]]) await assert.rejects(h.call('toplu-esitle', { caseKeys: keys }));
    assert.equal(h.mock.istekler.length, before); assert.equal((await h.history()).isler.length, 0);
  } finally { await h.close(); }
});

test('P05: gerçek motor SIGKILL sonrası sıra/sayaç korunur, yalnız kalan dosyalar sürer; iptal kalıcıdır', { timeout: 30_000 }, () => {
  const result = JSON.parse(execFileSync(process.execPath, ['test/p05-restart-check.mjs'], { encoding: 'utf8', timeout: 25_000 }));
  assert.equal(result.queueSurvivesKill, true); assert.equal(result.counterSurvivesKill, true);
  assert.equal(result.preservedSources + result.remainingDownloads, 12); assert.equal(result.cancellationSurvivesKill, true);
});
