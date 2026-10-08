// Süreç düzeyi CLI testi: `tensipd` daemon süreci + `tensip` istemci süreci.
// control.json keşfi, çıktı sözleşmesi (stdout tek JSON), çıkış kodları,
// durdurma temizliği.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, statSync, openSync, closeSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isiBekle } from "../src/cli/bekle.js";
import { MockUyap, opakToken } from "./mock-uyap/sunucu.js";
import { makeUdf, tmpKok } from "./yardimci.js";

const URETIM = fileURLToPath(new URL("../", import.meta.url));
const TENSIPD = join(URETIM, "src/cli/tensipd.js");
const UYAP = join(URETIM, "src/cli/tensip.js");
const CEREZ = "JSESSIONID=cli1234567890; NSC=1";

/** Asenkron spawn — spawnSync üst sürecin event loop'unu bloklar; mock
 *  aynı süreçte yaşadığından bu deadlock üretir. Bu yüzden spawn+await. */
async function calistir(
  komutlar: string[],
  zamanAsimiMs = 60_000
): Promise<{ kod: number; stdout: string; stderr: string }> {
  return new Promise((coz) => {
    const cocuk = spawn(process.execPath, [komutlar[0] === "tensipd" ? TENSIPD : UYAP, ...komutlar.slice(1)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    cocuk.stdout?.on("data", (c: Buffer) => (stdout += c.toString()));
    cocuk.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));
    const t = setTimeout(() => {
      cocuk.kill("SIGKILL");
      coz({ kod: -1, stdout, stderr: stderr + "\n[KILL: zaman aşımı]" });
    }, zamanAsimiMs);
    cocuk.on("close", (kod) => {
      clearTimeout(t);
      coz({ kod: kod ?? 1, stdout, stderr });
    });
  });
}

describe("cli süreç", () => {
  const ayar = tmpKok();
  const kok = tmpKok();
  const mock = new MockUyap({
    birimler: [
      { birimId: "3000", birimAdi: "CLI Test Sulh Hukuk Mahkemesi", yargiTuru: "0" },
      // P10a/T05 — AYNI esas numarasını taşıyan ikinci mahkeme. Belirsiz
      // `--dava` referansının yanlış dosyaya gitmediği ancak iki aday
      // gerçekten varken kanıtlanabilir.
      { birimId: "3001", birimAdi: "CLI Test 2. Sulh Hukuk Mahkemesi", yargiTuru: "0" },
    ],
    davalar: [
      {
        dosyaId: opakToken("cli-dosya-2"),
        birimAdi: "CLI Test 2. Sulh Hukuk Mahkemesi",
        birimId: "3001",
        esasNo: "2026/7",
        dosyaTur: "Hukuk Dava Dosyası",
        dosyaDurum: "Açık",
        yargiTuru: "0",
        evraklar: [
          {
            evrakId: opakToken("cli-evrak-2"),
            tur: "Dava Dilekçesi",
            gonderen: "Av. CLI",
            tip: "GLN",
            tarih: "05/09/2026",
            birimEvrakNo: "200",
            durum: "yuklu",
            contentTipi: "application/octet-stream",
            icerik: makeUdf(["İKİNCİ MAHKEME", "Bu dosya indirilmemeli."]),
          },
        ],
      },
      {
        dosyaId: opakToken("cli-dosya"),
        birimAdi: "CLI Test Sulh Hukuk Mahkemesi",
        birimId: "3000",
        esasNo: "2026/7",
        dosyaTur: "Hukuk Dava Dosyası",
        dosyaDurum: "Açık",
        yargiTuru: "0",
        evraklar: [
          {
            evrakId: opakToken("cli-evrak"),
            tur: "Dava Dilekçesi",
            gonderen: "Av. CLI",
            tip: "GLN",
            tarih: "05/09/2026",
            birimEvrakNo: "100",
            durum: "yuklu",
            contentTipi: "application/octet-stream",
            icerik: makeUdf(["DAVA DİLEKÇESİ", "Test içeriği."]),
          },
        ],
      },
    ],
  });
  let port = 0;
  let daemonCocuk: ChildProcess | undefined;

  before(async () => {
    port = await mock.baslat();
  });
  after(async () => {
    if (daemonCocuk) await cocukDurdur(daemonCocuk);
    await mock.durdur();
    ayar.temizle();
    kok.temizle();
  });

  test("daemon yokken tensip durum → çıkış 3", async () => {
    const r = await calistir(["tensip", "durum", `--ayar=${ayar.kok}`]);
    assert.equal(r.kod, 3, `stdout=${r.stdout} stderr=${r.stderr}`);
    // hata stderr'e NDJSON olarak gider; stdout temiz kalır
    const h = JSON.parse(r.stderr.split("\n")[0]!);
    assert.equal(h.hata.code, "APP_GONE");
  });

  test("P10a yardım↔işleyici sözleşmesi: yardımdaki her komut tanımlıdır", async () => {
    // T04'ün özü: yardımda duran bir komut `bilinmeyen komut` vermemeli.
    // Bu test P10a'dan ÖNCE `tensipd durum` yüzünden DÜŞÜYORDU.
    for (const ikili of [
      ["tensip", "uyap"],
      ["tensipd", "tensipd"],
    ] as const) {
      const y = await calistir([ikili[0], "--yardim"]);
      assert.equal(y.kod, 0, `yardım çalışmalı: ${y.stderr}`);
      const komutlar = JSON.parse(y.stdout).komutlar as string[];
      assert.ok(komutlar.length > 0);
      for (const komut of komutlar) {
        if (komut === "baslat") continue; // uzun ömürlü süreç; ayrı sınanır
        const r = await calistir([ikili[1], komut, `--ayar=${ayar.kok}`], 20_000);
        assert.ok(
          !r.stderr.includes("bilinmeyen komut"),
          `${ikili[1]} ${komut}: yardımda var ama işleyicisi yok (stderr=${r.stderr})`,
        );
      }
    }
  });

  test("`tensip yol` ve `tensip davalar` motor KAPALIYKEN registry'den yanıtlar", async () => {
    // "Bu dosyanın klasörü nerede" sorusu motorun açık olmasına bağlı olmamalı.
    const bos = tmpKok();
    try {
      const yok = await calistir(["tensip", "yol", "--dava", "çamlık", `--ayar=${bos.kok}`]);
      assert.equal(yok.kod, 3, "registry de yoksa haber hâlâ 'motor yok'tur");

      writeFileSync(
        join(bos.kok, "davalarim.json"),
        JSON.stringify({
          surum: 1,
          guncellenmeAt: "",
          davalar: [
            { caseKey: "Örnek İcra Dairesi\u00002026/1", birimAdi: "Örnek İcra Dairesi", dosyaNo: "2026/1", klonYolu: "/tmp/ornek-icra" },
            { caseKey: "Örnek Asliye Hukuk Mahkemesi\u00002026/2", birimAdi: "Örnek Asliye Hukuk Mahkemesi", dosyaNo: "2026/2", klonYolu: "/tmp/ornek-hukuk" },
            { caseKey: "Klonsuz Mahkeme\u00002026/3", birimAdi: "Klonsuz Mahkeme", dosyaNo: "2026/3" },
          ],
        }),
      );
      const y = await calistir(["tensip", "yol", "--dava", "örnek asliye hukuk", `--ayar=${bos.kok}`]);
      assert.equal(y.kod, 0, `stderr=${y.stderr}`);
      const cevap = JSON.parse(y.stdout);
      assert.equal(cevap.yol, "/tmp/ornek-hukuk");
      assert.equal(cevap.motor, false);

      const belirsiz = await calistir(["tensip", "yol", "--dava", "örnek", `--ayar=${bos.kok}`]);
      assert.equal(belirsiz.kod, 2, "iki aday → seçmez");
      const klonsuz = await calistir(["tensip", "yol", "--dava", "klonsuz", `--ayar=${bos.kok}`]);
      assert.equal(klonsuz.kod, 1);

      const d = await calistir(["tensip", "davalar", `--ayar=${bos.kok}`]);
      assert.equal(d.kod, 0);
      assert.equal(JSON.parse(d.stdout).davalar.length, 3);

      // Sınır: başka hiçbir komut bu yoldan geçmez.
      const e = await calistir(["tensip", "evraklar", "--dava", "örnek asliye hukuk", `--ayar=${bos.kok}`]);
      assert.equal(e.kod, 3);
    } finally {
      bos.temizle();
    }
  });

  test("`tensip --help` her komutun kullanım satırını da basar", async () => {
    // Ajan CLI'yi yalnız bu çıktıdan öğrenir; bayraklar kaynakta kalıp
    // ekrana çıkmazsa her ajan kendi kopyasını tutar ve o kopya bayatlar.
    const y = await calistir(["tensip", "--help"]);
    assert.equal(y.kod, 0, `stderr=${y.stderr}`);
    const yardim = JSON.parse(y.stdout) as { komutlar: string[]; kullanim: Record<string, string> };
    for (const komut of yardim.komutlar) {
      assert.equal(typeof yardim.kullanim[komut], "string", `${komut}: kullanım satırı yok`);
    }
    assert.match(yardim.kullanim["klonla"] ?? "", /--birim/);
  });

  test("P10a `tensipd tani` motor kapalıyken de çalışır ve sır taşımaz", async () => {
    const r = await calistir(["tensipd", "tani", `--ayar=${ayar.kok}`]);
    assert.equal(r.kod, 0, `stderr=${r.stderr}`);
    const t = JSON.parse(r.stdout);
    assert.equal(t.olcum, "yerel");
    assert.equal(t.motorDurumu, "ulaşılamadı");
    assert.equal(typeof t.surum.paket, "string");
    // Motor kapalıyken arşiv kökü TAHMİN EDİLMEZ (kalıcı kök ayarı P10b'nin).
    assert.equal(t.arsiv.kok, null);
    assert.ok(!/JSESSIONID|Bearer|caseKey/i.test(r.stdout));
  });

  test("P10a `tensip surum` daemon olmadan sürüm + dal/commit basar", async () => {
    const r = await calistir(["tensip", "surum"]);
    assert.equal(r.kod, 0, `stderr=${r.stderr}`);
    const v = JSON.parse(r.stdout);
    assert.equal(v.surumKaynagi, "package.json");
    assert.match(v.commit ?? "", /^[0-9a-f]{40}$/);
    assert.ok(v.calisanKok.length > 1);
  });

  test("daemon başlar, control.json yazılır", async () => {
    const cocuk = spawn(process.execPath, [
      TENSIPD,
      "baslat",
      `--ayar=${ayar.kok}`,
      `--portal=http://127.0.0.1:${port}`,
      "--web=false",
      "--istek-aralik=20",
      `--kok=${kok.kok}`,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    daemonCocuk = cocuk;
    // control.json bekle
    const dosya = join(ayar.kok, "control.json");
    for (let i = 0; i < 100; i++) {
      if (existsSync(dosya)) break;
      await new Promise((c) => setTimeout(c, 100));
    }
    assert.ok(existsSync(dosya), "control.json yazılmalı");
    const k = JSON.parse(readFileSync(dosya, "utf8"));
    assert.equal(k.version, 1);
    const s = statSync(dosya);
    assert.equal(s.mode & 0o777, 0o600);
  });

  test("tensip durum çalışır", async () => {
    // teşhis: daemon hâlâ canlı mı?
    const dosya = join(ayar.kok, "control.json");
    if (!existsSync(dosya)) assert.fail("control.json yok (daemon ölmüş)");
    const k = JSON.parse(readFileSync(dosya, "utf8"));
    try {
      process.kill(k.pid, 0);
    } catch {
      assert.fail(`daemon pid ${k.pid} ölü`);
    }
    const r = await calistir(["tensip", "durum", `--ayar=${ayar.kok}`]);
    assert.equal(r.kod, 0, `stderr=${r.stderr}`);
    const o = JSON.parse(r.stdout);
    assert.ok(o.oturum !== undefined);
    assert.ok(o.fren !== undefined);
  });

  test("tensip giris + davalarim + klonla", async () => {
    let r = await calistir(["tensip", "giris", `--ayar=${ayar.kok}`, `--cerez=${CEREZ}`]);
    assert.equal(r.kod, 0, `stderr=${r.stderr}`);
    assert.equal(JSON.parse(r.stdout).yontem, "manuel");

    r = await calistir(
      ["tensip", "davalarim", `--ayar=${ayar.kok}`, "--birim=CLI Test Sulh Hukuk Mahkemesi", "--yil=2026", "--sira=7", "--kapsam=hepsi"]
    );
    assert.equal(r.kod, 0, `stderr=${r.stderr}`);
    const d = JSON.parse(r.stdout);
    assert.equal(d.adet, 1);

    r = await calistir(
      ["tensip", "klonla", `--ayar=${ayar.kok}`, "--birim=CLI Test Sulh Hukuk Mahkemesi", "--esas=2026/7", "--kapsam=hepsi", `--avukat=CLI AVUKAT`]
    );
    assert.equal(r.kod, 0, `stderr=${r.stderr}`);
    const k = JSON.parse(r.stdout);
    assert.equal(k.durum, "hazir");
    assert.ok(k.sonuc?.klonYolu);
    assert.ok(existsSync(k.sonuc.klonYolu));
    const bitmis = await calistir(["tensip", "bekle", `--isId=${k.isId}`, `--ayar=${ayar.kok}`], 3000);
    assert.equal(bitmis.kod, 0, bitmis.stderr);
    assert.equal(JSON.parse(bitmis.stdout).durum, "hazir");

    r = await calistir(["tensip", "evraklar", `--ayar=${ayar.kok}`, "--dava=CLI Test Sulh Hukuk Mahkemesi 2026-7"]);
    assert.equal(r.kod, 0, `stderr=${r.stderr}`);
    const e = JSON.parse(r.stdout);
    assert.equal(e.adet, 1);
    assert.equal(e.evraklar[0].mdStatus, "ok");
  });

  test("P10a belirsiz --dava sessizce ilk adayı SEÇMEZ: çıkış 2, portala sıfır istek", async () => {
    // İkinci mahkemeyi de klonla → registry'de aynı esaslı iki dosya olur.
    const ikinci = await calistir(
      ["tensip", "klonla", `--ayar=${ayar.kok}`, "--birim=CLI Test 2. Sulh Hukuk Mahkemesi", "--esas=2026/7", "--kapsam=hepsi", "--avukat=CLI AVUKAT"]
    );
    assert.equal(ikinci.kod, 0, `stderr=${ikinci.stderr}`);
    const davalar = JSON.parse((await calistir(["tensip", "davalar", `--ayar=${ayar.kok}`])).stdout);
    assert.equal(davalar.davalar.length, 2, "iki dosya klonlanmış olmalı");

    const oncekiIstek = mock.istekler.length;
    const oncekiIsler = JSON.parse((await calistir(["tensip", "isler", `--ayar=${ayar.kok}`])).stdout)
      .isler.length as number;

    // "Sulh Hukuk Mahkemesi 2026-7" her iki birimin de adının içinde geçiyor.
    const r = await calistir(["tensip", "esitle", `--ayar=${ayar.kok}`, "--dava=Sulh Hukuk Mahkemesi 2026-7"]);
    assert.equal(r.kod, 2, `belirsiz referans çıkış 2 vermeli (stdout=${r.stdout})`);
    const h = JSON.parse(r.stderr.split("\n").find((l) => l.startsWith("{"))!);
    assert.equal(h.hata.code, "INVALID_INPUT");
    assert.deepEqual(h.hata.sebep.adaylar, [
      "CLI Test 2. Sulh Hukuk Mahkemesi 2026/7",
      "CLI Test Sulh Hukuk Mahkemesi 2026/7",
    ]);
    assert.equal(r.stdout, "", "belirsizlikte stdout kirlenmemeli");

    // YANLIŞ DAVAYA İNDİRME YOK: ne yeni iş açıldı ne portala istek gitti.
    const sonrakiIsler = JSON.parse((await calistir(["tensip", "isler", `--ayar=${ayar.kok}`])).stdout)
      .isler.length as number;
    assert.equal(sonrakiIsler, oncekiIsler, "belirsiz referans iş başlatmamalı");
    assert.equal(mock.istekler.length, oncekiIstek, "belirsiz referans portala gitmemeli");

    // Kesin birim adı verildiğinde aynı referans çözülür (tolerans kaybolmadı).
    const kesin = await calistir(["tensip", "yol", `--ayar=${ayar.kok}`, "--dava=CLI Test 2. Sulh Hukuk Mahkemesi 2026-7"]);
    assert.equal(kesin.kod, 0, `stderr=${kesin.stderr}`);
  });

  test("P10a `esitle --hepsi` sessizce düzeltilmez, AÇIKÇA reddedilir", async () => {
    const oncekiIsler = JSON.parse((await calistir(["tensip", "isler", `--ayar=${ayar.kok}`])).stdout)
      .isler.length as number;
    const oncekiIstek = mock.istekler.length;
    const r = await calistir([
      "uyap", "esitle", `--ayar=${ayar.kok}`, "--dava=CLI Test Sulh Hukuk Mahkemesi 2026-7", "--hepsi",
    ]);
    assert.equal(r.kod, 2, `stdout=${r.stdout} stderr=${r.stderr}`);
    assert.ok(r.stderr.includes("--hepsi uygulanmadı"), r.stderr);
    assert.ok(r.stderr.includes("uygulama penceresinden"), "kullanıcı doğru yere yönlendirilmeli");
    assert.equal(r.stdout, "");
    const sonrakiIsler = JSON.parse((await calistir(["tensip", "isler", `--ayar=${ayar.kok}`])).stdout)
      .isler.length as number;
    assert.equal(sonrakiIsler, oncekiIsler, "reddedilen komut iş başlatmamalı");
    assert.equal(mock.istekler.length, oncekiIstek);
    // Yardım metni artık --hepsi vaat etmiyor.
    const y = await calistir(["tensip", "--yardim"]);
    assert.ok(!y.stdout.includes("--hepsi"), "yardım kaldırılmış bayrağı vaat etmemeli");
  });

  test("P10a `tensipd durum` uygulandı; portala probe ATMAZ", async () => {
    const oncekiIstek = mock.istekler.length;
    const r = await calistir(["tensipd", "durum", `--ayar=${ayar.kok}`]);
    assert.equal(r.kod, 0, `stderr=${r.stderr}`);
    const o = JSON.parse(r.stdout);
    assert.ok(typeof o.kok === "string" && o.kok.length > 0);
    assert.ok(o.oturum !== undefined);
    assert.equal(mock.istekler.length, oncekiIstek, "`durum` {yerel:true} ile çağrılmalı");
  });

  test("P10a `tensipd tani` motor ayaktayken ÇALIŞAN süreci ölçer", async () => {
    const oncekiIstek = mock.istekler.length;
    const r = await calistir(["tensipd", "tani", `--ayar=${ayar.kok}`]);
    assert.equal(r.kod, 0, `stderr=${r.stderr}`);
    const t = JSON.parse(r.stdout);
    assert.equal(t.olcum, "motor");
    assert.equal(t.arsiv.kok, kok.kok, "motorun gerçek kökü raporlanmalı");
    assert.equal(t.ayar.dizin, ayar.kok);
    assert.equal(t.ayar.kontrolDosyasiVar, true);
    assert.ok(typeof t.calisma.instanceId === "string" && t.calisma.instanceId.length > 0);
    assert.equal(t.surum.uyusuyorMu, true);
    assert.ok(!/JSESSIONID|Bearer|"token"/i.test(r.stdout), "tanılama sır taşımamalı");
    assert.equal(mock.istekler.length, oncekiIstek, "tanılama portala gitmemeli");
  });

  test("tensipd durdur → süreç kapanır, control.json silinir", async () => {
    const r = await calistir(["tensipd", "durdur", `--ayar=${ayar.kok}`]);
    assert.equal(r.kod, 0, `stderr=${r.stderr}`);
    // süreç çıkışı bekle
    const cocuk = daemonCocuk;
    for (let i = 0; i < 50; i++) {
      if (cocuk === undefined || cocuk.exitCode !== null || cocuk.killed) break;
      await new Promise((c) => setTimeout(c, 100));
    }
    assert.ok(existsSync(join(ayar.kok, "control.json")) === false, "control.json temizlenmeli");
    // daemon kapalıyken istemci APP_GONE
    const r2 = await calistir(["tensip", "durum", `--ayar=${ayar.kok}`]);
    assert.equal(r2.kod, 3);
  });
});

test("log çift yazılmaz: stderr dosyaya yönlendirilse bile tek 'başlıyor'", async () => {
  // baslatici.sh düzeni: stderr AYNI log dosyasına yönlendirilir.
  // ayrintili yalnız TTY'de açık — dosyaya yönlendirilmiş stderr'de
  // AppLog + stderr çift yazım OLMAMALI.
  const ayar2 = tmpKok();
  const kok2 = tmpKok();
  let cocuk: ChildProcess | undefined;
  try {
    const logDosyasi = join(ayar2.kok, "tensip.log");
    const stderrFd = openSync(logDosyasi, "a");
    cocuk = spawn(process.execPath, [
      TENSIPD, "baslat", `--ayar=${ayar2.kok}`, "--portal=http://127.0.0.1:1", "--web=false", `--kok=${kok2.kok}`,
    ], { stdio: ["ignore", "ignore", stderrFd] });
    closeSync(stderrFd);
    const dosya = join(ayar2.kok, "control.json");
    for (let i = 0; i < 100 && !existsSync(dosya); i++) {
      await new Promise((c) => setTimeout(c, 100));
    }
    assert.ok(existsSync(dosya));
    await cocukDurdur(cocuk);
    const icerik = readFileSync(logDosyasi, "utf8");
    const adet = icerik.split("\n").filter((l) => /\[tensipd\] başlıyor v\d/.test(l)).length;
    assert.equal(adet, 1, `çift yazım! log:\n${icerik.slice(0, 500)}`);
  } finally {
    if (cocuk) await cocukDurdur(cocuk);
    ayar2.temizle();
    kok2.temizle();
  }
});

test("P10a --web anlaşılmayan değerde çıkış 2 verir; false/0 hâlâ kapatır", async () => {
  const ayar3 = tmpKok();
  const kok3 = tmpKok();
  try {
    const r = await calistir([
      "tensipd", "baslat", `--ayar=${ayar3.kok}`, "--portal=http://127.0.0.1:1", "--web=abc", `--kok=${kok3.kok}`,
    ], 20_000);
    assert.equal(r.kod, 2, `stderr=${r.stderr}`);
    const h = JSON.parse(r.stderr.split("\n").find((l) => l.startsWith("{"))!);
    assert.equal(h.hata.code, "INVALID_INPUT");
    // Reddedilen başlatma arkasında control.json bırakmaz.
    assert.equal(existsSync(join(ayar3.kok, "control.json")), false);
  } finally {
    ayar3.temizle();
    kok3.temizle();
  }
});

test("fren bayrakları tam sayı olmalı: NaN aralık freni sessizce kapatamaz", async () => {
  // `Number("abc")` NaN olur; NaN aralık hiç bekletmediği için yazım hatası
  // portala frensiz istek akışı demekti.
  for (const bayrak of ["--istek-aralik=abc", "--istek-sapma=-5", "--gunluk-tavan=0", "--gunluk-istek-tavan=1e3"]) {
    const ayar4 = tmpKok();
    const kok4 = tmpKok();
    try {
      const r = await calistir([
        "tensipd", "baslat", `--ayar=${ayar4.kok}`, "--portal=http://127.0.0.1:1", "--web=false", `--kok=${kok4.kok}`, bayrak,
      ], 20_000);
      assert.equal(r.kod, 2, `${bayrak}: stderr=${r.stderr}`);
      const h = JSON.parse(r.stderr.split("\n").find((l) => l.startsWith("{") && l.includes("hata"))!);
      assert.equal(h.hata.code, "INVALID_INPUT");
      assert.equal(existsSync(join(ayar4.kok, "control.json")), false, `${bayrak}: motor başlamamalı`);
    } finally {
      ayar4.temizle();
      kok4.temizle();
    }
  }
});

describe("çift başlatma", () => {
  const ayar = tmpKok();
  const kok = tmpKok();

  after(async () => {
    ayar.temizle();
    kok.temizle();
  });

  test("ikinci daemon IS_BUSY reddeder", async (t) => {
    const bir = spawn(process.execPath, [
      TENSIPD, "baslat", `--ayar=${ayar.kok}`, "--portal=http://127.0.0.1:1", "--web=false", `--kok=${kok.kok}`,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    t.after(() => cocukDurdur(bir));
    const dosya = join(ayar.kok, "control.json");
    for (let i = 0; i < 100 && !existsSync(dosya); i++) {
      await new Promise((c) => setTimeout(c, 100));
    }
    assert.ok(existsSync(dosya));
    const iki = await calistir(["tensipd", "baslat", `--ayar=${ayar.kok}`, "--portal=http://127.0.0.1:1", "--web=false", `--kok=${kok.kok}`], 15_000);
    assert.equal(iki.kod, 6, `stderr=${iki.stderr}`);
    const hata = JSON.parse(iki.stderr.split("\n").find((l) => l.startsWith("{"))!);
    assert.equal(hata.hata.code, "IS_BUSY");
    // temizle
    const b = JSON.parse(readFileSync(dosya, "utf8"));
    if (b.pid !== bir.pid) {
      process.kill(b.pid, "SIGTERM");
    }
    await cocukDurdur(bir);
    for (let i = 0; i < 50 && existsSync(dosya); i++) {
      await new Promise((c) => setTimeout(c, 100));
    }
  });
});


async function cocukDurdur(cocuk: ChildProcess): Promise<void> {
  if (cocuk.exitCode !== null || cocuk.signalCode !== null) return;
  const bitti = new Promise<void>((c) => cocuk.once("close", () => c()));
  cocuk.kill("SIGTERM");
  const zorla = setTimeout(() => cocuk.kill("SIGKILL"), 12_000);
  try { await bitti; } finally { clearTimeout(zorla); }
}

test("iş ilk sorgu ile abonelik arasında biterse ilk nabızla uzlaşır", async () => {
  let bitti = false;
  let kapandi = false;
  const istemci = {
    async cagir() { return { durum: bitti ? "hazir" : "calisiyor" }; },
    async *akis() {
      bitti = true; // Bitiş olayı abonelik açılmadan önce kaçtı.
      try { yield { tip: "nabiz" }; } finally { kapandi = true; }
    },
  };
  const sonuc = await isiBekle(istemci, "is-test");
  assert.equal(sonuc.durum, "hazir");
  assert.equal(kapandi, true, "erken dönüş akışı kapatmalı");
});

test("olmayan işte bekle akış açmadan NOT_FOUND döndürür", async () => {
  const istemci = {
    async cagir(): Promise<never> { throw new Error("NOT_FOUND"); },
    async *akis(): AsyncGenerator<unknown> { assert.fail("akış açılmamalı"); },
  };
  await assert.rejects(isiBekle(istemci, "yok"), /NOT_FOUND/);
});

describe("tensipd tani — eski motor ayrımı", () => {
  // P10a'nın var olma sebebi olan senaryo: kurulu tensipd bu checkout'a
  // symlink'li, motor ise ESKİ koddan başlamış ve `tani` ucunu tanımıyor.
  // Kör catch bunu "ulaşılamadı" diye raporluyordu — yani motor ayaktayken
  // kullanıcıya "motor yok" deniyordu.
  const ayar = tmpKok();
  let sunucu: import("node:http").Server;
  let port = 0;

  before(async () => {
    const { createServer } = await import("node:http");
    sunucu = createServer((req, res) => {
      res.writeHead(req.url === "/rpc/tani" ? 404 : 200, {
        "content-type": "application/json; charset=utf-8",
      });
      res.end(
        req.url === "/rpc/tani"
          ? JSON.stringify({ ok: false, error: { code: "NOT_FOUND", message: "bilinmeyen rpc: tani" } })
          : JSON.stringify({ ok: true, data: {} }),
      );
    });
    await new Promise<void>((r) => sunucu.listen(0, "127.0.0.1", r));
    port = (sunucu.address() as { port: number }).port;
    writeFileSync(
      join(ayar.kok, "control.json"),
      JSON.stringify({
        version: 1,
        port,
        token: "sahte-token-eski-motor",
        instanceId: "eski-motor",
        pid: process.pid,
        appVersion: "1.0.0",
      }),
    );
  });

  after(async () => {
    await new Promise<void>((r) => {
      sunucu.close(() => r());
      sunucu.closeAllConnections();
    });
    ayar.temizle();
  });

  test("ayakta ama tani'yi tanımayan motor 'ulaşılamadı' denmez", async () => {
    const r = await calistir(["tensipd", "tani", `--ayar=${ayar.kok}`]);
    assert.equal(r.kod, 0, r.stderr);
    const t = JSON.parse(r.stdout.trim()) as { olcum: string; motorDurumu: string };
    assert.equal(t.olcum, "yerel", "motor tani'yi bilmiyor, ölçüm yerele düşmeli");
    assert.notEqual(t.motorDurumu, "ulaşılamadı");
    assert.match(t.motorDurumu, /motor eski/);
  });

  test("gerçekten kapalı motorda 'ulaşılamadı' korunur", async () => {
    const bos = tmpKok();
    try {
      const r = await calistir(["tensipd", "tani", `--ayar=${bos.kok}`]);
      assert.equal(r.kod, 0, r.stderr);
      const t = JSON.parse(r.stdout.trim()) as { olcum: string; motorDurumu: string };
      assert.equal(t.olcum, "yerel");
      assert.equal(t.motorDurumu, "ulaşılamadı");
    } finally {
      bos.temizle();
    }
  });
});
