#!/usr/bin/env node
// Test takımı koşucusu: SÜRE SINIRI + SIZINTI BEKÇİSİ.
//
// Neden: 15 Eylül'de `node --test dist/test/` 23 saat 48 dakika asılı kaldı.
// Sebep, testten sağ çıkan bir süreç kilidi yardımcısıydı (Python/flock);
// boruları açık kaldığı için koşucu hiç çıkamadı ve asılma SESSİZ kaldı.
// Bu betik üç şeyi görünür kılar:
//   1. Takım süre sınırını aşarsa hangi test DOSYASI'nda asıldığını yazar.
//   2. Koşudan sonra ortada kilit tutan YENİ çocuk süreç kalmışsa düşer.
//   3. Koşu TMPDIR altında artık `tensip-test-*` dizini bırakmışsa düşer.
//
// Kullanım: node bin/test-kos.mjs [ek node --test argümanları]
// Ortam: TEST_SURE_SINIRI_MS (takımın tamamı, öntanımlı 600000)
//        TEST_TIMEOUT_MS     (tek test, öntanımlı 120000)
//        TEST_HEDEF          (koşulacak dizin/dosya, öntanımlı dist/test/)

import { spawn, execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const TAKIM_SINIR_MS = Number(process.env["TEST_SURE_SINIRI_MS"] ?? 600_000);
const TEST_SINIR_MS = Number(process.env["TEST_TIMEOUT_MS"] ?? 120_000);
const HEDEF = process.env["TEST_HEDEF"] ?? fileURLToPath(new URL("../dist/test/", import.meta.url));

/** Kilit yardımcısı görünümündeki tüm süreçler: pid → komut satırı. */
function kilitTutanlar() {
  const harita = new Map();
  let cikti = "";
  try {
    cikti = execFileSync("ps", ["-Ao", "pid=,command="], { encoding: "utf8", maxBuffer: 16 << 20 });
  } catch {
    return harita;
  }
  for (const satir of cikti.split("\n")) {
    if (!satir.includes("fcntl")) continue;
    const m = /^\s*(\d+)\s+(.*)$/.exec(satir);
    if (m) harita.set(Number(m[1]), m[2]);
  }
  return harita;
}

function geciciDizinler() {
  try {
    return readdirSync(tmpdir()).filter((a) => a.startsWith("tensip-test-"));
  } catch {
    return [];
  }
}

/** pid'in altındaki tüm süreç ağacı (asılmayı hangi test dosyasının tuttuğunu görmek için). */
function altAgac(kok) {
  let cikti = "";
  try {
    cikti = execFileSync("ps", ["-Ao", "pid=,ppid=,command="], { encoding: "utf8", maxBuffer: 16 << 20 });
  } catch {
    return [];
  }
  const satirlar = [];
  for (const satir of cikti.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(satir);
    if (m) satirlar.push({ pid: Number(m[1]), ppid: Number(m[2]), komut: m[3] });
  }
  const secili = [];
  const kuyruk = [kok];
  const gorulen = new Set([kok]);
  while (kuyruk.length > 0) {
    const p = kuyruk.shift();
    for (const s of satirlar) {
      if (s.ppid === p && !gorulen.has(s.pid)) {
        gorulen.add(s.pid);
        secili.push(s);
        kuyruk.push(s.pid);
      }
    }
  }
  return secili;
}

const oncekiKilitler = kilitTutanlar();
const oncekiGecici = geciciDizinler().length;

const cocuk = spawn(
  process.execPath,
  ["--test", `--test-timeout=${TEST_SINIR_MS}`, ...process.argv.slice(2), HEDEF],
  { stdio: "inherit", detached: true },
);

// Kendi süreç grubunda koşuyor (asılmada tüm ağacı öldürebilmek için);
// kullanıcının Ctrl-C'si gruba elle iletilir.
for (const sinyal of ["SIGINT", "SIGTERM"]) {
  process.on(sinyal, () => {
    try { process.kill(-cocuk.pid, sinyal); } catch { /* zaten gitmiş */ }
  });
}

let asildi = false;
const zaman = setTimeout(() => {
  asildi = true;
  const agac = altAgac(cocuk.pid);
  console.error(`\n[test-kos] TAKIM ASILDI: ${TAKIM_SINIR_MS} ms doldu, koşu bitmedi.`);
  const testler = agac.filter((s) => s.komut.includes("dist/test/"));
  if (testler.length > 0) {
    console.error("[test-kos] hâlâ çalışan test dosyaları (ASILAN BUNLARDIR):");
    for (const s of testler) {
      const ad = /(\S*dist\/test\/\S+)/.exec(s.komut)?.[1] ?? s.komut.slice(0, 200);
      console.error(`  pid ${s.pid}: ${ad}`);
    }
  } else {
    console.error("[test-kos] çalışan test dosyası görünmüyor; asılma kapanışta.");
  }
  const kilitler = agac.filter((s) => s.komut.includes("fcntl"));
  for (const s of kilitler) {
    const yol = /(\S*\.tensipd\.lock)/.exec(s.komut)?.[1] ?? "(kilit yolu okunamadı)";
    console.error(`[test-kos] kilit tutan çocuk: pid ${s.pid}, kilit ${yol}`);
  }
  try { process.kill(-cocuk.pid, "SIGKILL"); } catch { /* zaten gitmiş */ }
}, TAKIM_SINIR_MS);

cocuk.on("exit", (kod, sinyal) => {
  clearTimeout(zaman);
  if (asildi) {
    process.exit(1);
    return;
  }
  // Kapanış yarışına küçük bir pay: yardımcı süreç EOF ile hemen ölür.
  setTimeout(() => {
    let cikisKodu = sinyal !== null ? 1 : (kod ?? 1);

    const sonrakiKilitler = kilitTutanlar();
    const yeni = [...sonrakiKilitler].filter(([pid]) => !oncekiKilitler.has(pid));
    if (yeni.length > 0) {
      console.error(`\n[test-kos] BEKÇİ DÜŞTÜ: koşudan sonra ${yeni.length} yeni kilit tutan süreç kaldı.`);
      for (const [pid, komut] of yeni) console.error(`  pid ${pid}: ${komut.slice(0, 200)}`);
      cikisKodu = cikisKodu === 0 ? 1 : cikisKodu;
    }

    const sonrakiGecici = geciciDizinler().length;
    if (sonrakiGecici > oncekiGecici) {
      console.error(
        `\n[test-kos] BEKÇİ DÜŞTÜ: geçici dizin sayısı arttı (${oncekiGecici} → ${sonrakiGecici}).`,
      );
      cikisKodu = cikisKodu === 0 ? 1 : cikisKodu;
    }

    if (cikisKodu === 0) {
      console.log(
        `[test-kos] bekçi temiz: yeni kilit süreci yok, geçici dizin sayısı ${sonrakiGecici} (önce ${oncekiGecici}).`,
      );
    }
    process.exit(cikisKodu);
  }, 500);
});
