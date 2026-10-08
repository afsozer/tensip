import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { IsDepo, type KaliciIsKaydi } from '../src/jobs/depo.js';
import { daemonKur } from '../src/server/daemon.js';
import { tmpKok } from './yardimci.js';

const seed = (durum: KaliciIsKaydi['durum'] = 'duraklatildi'): KaliciIsKaydi => ({
  isId: 'test-job', tur: 'esitle', caseKey: 'Test\u00002026/4', durum,
  baslamaAt: '2026-09-09T00:00:00.000Z', ilerleme: { toplam: 10, biten: 3 },
});

test('P04: gerçek motor SIGKILL, yeni oturum ve kalan belgelerle devam', { timeout: 30_000 }, () => {
  const output = execFileSync(process.execPath, ['test/p04-restart-check.mjs'], { encoding: 'utf8', timeout: 25_000 });
  const result = JSON.parse(output);
  assert.equal(result.freshTokensResume, true);
  assert.equal(result.remainingDownloads + result.preservedSources, 24);
});

test('P04: bozuk ana depo yedekten kurtarılır; bozuk kopya korunur', () => {
  const t = tmpKok();
  try {
    const depo = new IsDepo(t.kok);
    depo.yaz([seed()]); depo.yaz([{ ...seed(), durum: 'iptal' }]);
    writeFileSync(depo.dosya, '{broken');
    const restored = new IsDepo(t.kok);
    assert.equal(restored.oku()[0]!.durum, 'duraklatildi');
    assert.equal(restored.kurtarmaGerekiyor(), true);
    const backup = readdirSync(t.kok).find(n => n.includes('.bozuk-'))!;
    assert.equal(readFileSync(join(t.kok, backup), 'utf8'), '{broken');
    unlinkSync(depo.dosya);
    assert.equal(new IsDepo(t.kok).oku().length, 1);
  } finally { t.temizle(); }
});

test('P04: geçerli yedeği olmayan bozuk depo startupı reddeder ve kilidi bırakır', async () => {
  const t = tmpKok();
  const daemon = daemonKur({ ayarDir: t.kok, kok: join(t.kok, 'archive'), oturumYenileMs: 0 });
  try {
    writeFileSync(join(t.kok, 'isler.json'), '{broken');
    await assert.rejects(daemon.rpc.baslat(), /iş deposu bozuk/);
    assert.equal(readFileSync(join(t.kok, 'isler.json'), 'utf8'), '{broken');
    unlinkSync(join(t.kok, 'isler.json'));
    const next = daemonKur({ ayarDir: t.kok, kok: join(t.kok, 'archive'), oturumYenileMs: 0 });
    await next.rpc.baslat(); await next.kapat();
  } finally { await daemon.kapat(); t.temizle(); }
});

test('P04: yinelenen kimlik ve eksik klon parametreleri reddedilir', () => {
  const t = tmpKok();
  try {
    const depo = new IsDepo(t.kok);
    assert.throws(() => depo.yaz([seed(), seed()]), /geçersiz/);
    assert.throws(() => depo.yaz([{ ...seed(), tur: 'klonla' }]), /geçersiz/);
    depo.yaz([{ ...seed(), hata: { code: 'TEST', message: 'JSESSIONID=secret-value' } }]);
    assert.equal(readFileSync(depo.dosya, 'utf8').includes('secret-value'), false);
  } finally { t.temizle(); }
});

test('P04: duraklatılmış iş kapanışta korunur, kalıcı iptal yeniden devam ettirilemez', async () => {
  const t = tmpKok();
  const make = () => daemonKur({ ayarDir: t.kok, kok: join(t.kok, 'archive'), oturumYenileMs: 0 });
  try {
    new IsDepo(t.kok).yaz([seed()]);
    const first = make(); await first.rpc.baslat(); await first.kapat();
    assert.equal(new IsDepo(t.kok).oku()[0]!.durum, 'duraklatildi');
    const next = make(); await next.rpc.baslat();
    assert.equal(next.orkestrator.iptal('test-job'), true);
    await next.kapat();
    const last = make(); await last.rpc.baslat();
    assert.equal(last.orkestrator.isGetir('test-job')!.durum, 'iptal');
    assert.equal(last.orkestrator.devamEt('test-job'), null);
    await last.kapat();
  } finally { t.temizle(); }
});

test('P04: kaydedilmiş aktif iptal talebi restartta iptal kalır', async () => {
  const t = tmpKok();
  const daemon = daemonKur({ ayarDir: t.kok, kok: join(t.kok, 'archive'), oturumYenileMs: 0 });
  try {
    new IsDepo(t.kok).yaz([{ ...seed('calisiyor'), iptalIsteniyor: true }]);
    await daemon.rpc.baslat();
    assert.equal(daemon.orkestrator.isGetir('test-job')!.durum, 'iptal');
  } finally { await daemon.kapat(); t.temizle(); }
});

test('P04: ilk kalıcı yazım başarısızsa hayalet iş veya portal isteği oluşmaz', async () => {
  const t = tmpKok();
  const daemon = daemonKur({ ayarDir: t.kok, kok: join(t.kok, 'archive'), portalUrl: 'http://127.0.0.1:1', oturumYenileMs: 0 });
  try {
    await daemon.rpc.baslat();
    mkdirSync(join(t.kok, 'isler.json'));
    assert.throws(() => daemon.orkestrator.esitleBaslat('Test\u00002026/4'));
    assert.equal(daemon.orkestrator.islerHepsi().length, 0);
  } finally {
    // Hata enjeksiyonunu kaldır, normal kapanışı doğrula.
    const { rmSync } = await import('node:fs');
    rmSync(join(t.kok, 'isler.json'), { recursive: true, force: true });
    await daemon.kapat(); t.temizle();
  }
});


test('P04: CLI eksikli/kesildi kayıtlarında olay akışını sonsuza kadar beklemez', async () => {
  const { isiBekle } = await import('../src/cli/bekle.js');
  for (const durum of ['eksikli', 'kesildi']) {
    const sonuc = await isiBekle({
      cagir: async () => ({ durum }),
      akis: async function* () { throw new Error('Terminal iş için akış açılmamalı'); },
    }, 'test-job');
    assert.equal(sonuc.durum, durum);
  }
});
