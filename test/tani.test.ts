// P10a — görünür sürüm, tanılama ve katı dava çözücü.
//
// Üç sözleşmeyi sabitler:
//  1. Sürümün TEK yazılı kaynağı package.json'dur; src/ içinde sabit kalmadı.
//  2. Tanılama SIR TAŞIMAZ, hiçbir dosya YAZMAZ, ağa çıkmaz.
//  3. Belirsiz `--dava` referansında ilk aday SESSİZCE SEÇİLMEZ (T05).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import {
  derlemeDurumu,
  gitKimligi,
  kaynakKoku,
  paketSurumu,
  SURUM_BILINMIYOR,
  surumBilgisi,
} from "../src/core/surum.js";
import { taniTopla, taniBellegiBosalt } from "../src/server/tani.js";
import { davaRefCoz, type DavaKaydi } from "../src/cli/dava-cozucu.js";
import { daemonKur } from "../src/server/daemon.js";
import { tmpKok } from "./yardimci.js";

const DEPO = fileURLToPath(new URL("../../", import.meta.url));

function tsDosyalari(dizin: string, out: string[] = []): string[] {
  for (const g of readdirSync(dizin, { withFileTypes: true })) {
    const tam = join(dizin, g.name);
    if (g.isDirectory()) tsDosyalari(tam, out);
    else if (g.name.endsWith(".ts")) out.push(tam);
  }
  return out;
}

describe("P10a sürüm tek kaynak", () => {
  test("paketSurumu package.json:version ile birebir aynıdır", () => {
    const beklenen = JSON.parse(readFileSync(join(DEPO, "package.json"), "utf8")).version as string;
    assert.equal(paketSurumu(), beklenen);
    assert.equal(surumBilgisi().kaynak, "package.json");
  });

  test("kaynakKoku depo kökünü gösterir (package.json oradadır)", () => {
    assert.ok(statSync(join(kaynakKoku(), "package.json")).isFile());
  });

  test("src/ içinde sürüm sabiti KALMADI — tek yazılı yer package.json", () => {
    const surum = paketSurumu();
    const suclular: string[] = [];
    for (const dosya of tsDosyalari(join(DEPO, "src"))) {
      const metin = readFileSync(dosya, "utf8");
      // Yorum satırlarında sürümden söz edilebilir; aranan şey KOD sabitidir:
      // tırnak içinde geçen çıplak sürüm dizesi.
      if (metin.includes(`"${surum}"`) || metin.includes(`'${surum}'`)) suclular.push(dosya);
    }
    assert.deepEqual(suclular, [], `sürüm sabiti kalmış: ${suclular.join(", ")}`);
  });

  test("bellek KÖKE göre anahtarlanır; {bellek:false} diski yeniden okur", () => {
    // Eskiden `surumBellek` süreç geneliydi ve `kok` argümanını YOK SAYIYORDU:
    // ilk çağrıdan sonra hangi kökle çağrılırsa çağrılsın ilk kökün sürümü
    // dönüyordu (P10b/P10c'de farklı kökle çağıracak ilk kişi için tuzak).
    const t = tmpKok();
    try {
      writeFileSync(join(t.kok, "package.json"), JSON.stringify({ version: "1.0.0-olcum" }));
      assert.equal(surumBilgisi(t.kok).surum, "1.0.0-olcum");
      // Depo kökü kendi sürümünü vermeye devam eder — bellek kökler arası sızmaz.
      assert.equal(surumBilgisi().surum, paketSurumu());

      // Aynı süreçte dosya ilerledi.
      writeFileSync(join(t.kok, "package.json"), JSON.stringify({ version: "2.0.0-olcum" }));
      // Bellekli okuma MOTORUN KİMLİĞİDİR: sabit kalır.
      assert.equal(surumBilgisi(t.kok).surum, "1.0.0-olcum");
      // Taze okuma diskin O ANKİ hâlini verir…
      assert.equal(surumBilgisi(t.kok, { bellek: false }).surum, "2.0.0-olcum");
      // …ve belleği TAZELEMEZ; yoksa motorun kimliği süreç ortasında kayardı.
      assert.equal(surumBilgisi(t.kok).surum, "1.0.0-olcum");

      // Okunamayan kök "bilinmiyor" der, başka kökün belleğine düşmez.
      assert.deepEqual(surumBilgisi("/bu/yol/kesinlikle/yok-12345"), {
        surum: SURUM_BILINMIYOR,
        kaynak: "bilinmiyor",
      });
    } finally {
      t.temizle();
    }
  });

  test("sürüm uyuşmazlığı ÜRETİMİN yolundan da görünür (izole motor kopyası)", async () => {
    // test/tani.test.ts'teki eski uyuşmazlık testi yalnız `taniTopla({motorSurum})`
    // ENJEKSİYONUNU kanıtlıyordu. Üretimde motor sürümü de paket sürümü de aynı
    // `paketSurumu()` çağrısından gelir (tensipd.ts:20 → daemon.ts `tani`), yani
    // bellek süreç geneliyken kıyas AYNI değeri iki kez karşılaştırıyor ve
    // uyuşmazlık ASLA görünmüyordu. Burası o yolu birebir kurar: derlenmiş motor
    // izole bir köke kopyalanır, açılışta sürüm okunur, sonra DİSKTEKİ paket
    // ilerletilir ve motor yeniden başlatılmadan tanılama çağrılır.
    const t = tmpKok();
    try {
      cpSync(join(DEPO, "dist", "src"), join(t.kok, "dist", "src"), { recursive: true });
      writeFileSync(join(t.kok, "package.json"), JSON.stringify({ version: "1.0.0-eski" }));
      const surumM = await import(
        pathToFileURL(join(t.kok, "dist", "src", "core", "surum.js")).href
      );
      const taniM = await import(
        pathToFileURL(join(t.kok, "dist", "src", "server", "tani.js")).href
      );
      const motor = surumM.paketSurumu() as string; // tensipd.ts:20 ile aynı an
      assert.equal(motor, "1.0.0-eski");

      writeFileSync(join(t.kok, "package.json"), JSON.stringify({ version: "1.1.0-yeni" }));
      const tani = taniM.taniTopla({ motorSurum: motor }) as {
        surum: { paket: string; motor: string; uyusuyorMu: boolean };
        uyarilar: string[];
      };
      assert.equal(tani.surum.motor, "1.0.0-eski");
      assert.equal(tani.surum.paket, "1.1.0-yeni");
      assert.equal(tani.surum.uyusuyorMu, false);
      assert.ok(
        tani.uyarilar.some((u) => u.includes("1.0.0-eski") && u.includes("1.1.0-yeni")),
        `uyuşmazlık uyarısı bekleniyordu: ${JSON.stringify(tani.uyarilar)}`,
      );
    } finally {
      t.temizle();
    }
  });

  test("kur betiği plist sürümünü package.json'dan türetir", () => {
    const betik = readFileSync(join(DEPO, "uygulama", "uygulama-kur.sh"), "utf8");
    assert.ok(!betik.includes(paketSurumu()), "kur betiğinde sürüm sabiti kalmamalı");
    assert.ok(
      betik.includes("CFBundleShortVersionString</key><string>${SURUM}</string>"),
      "plist sürümü ${SURUM} ile yazılmalı",
    );
    // Tırnaksız heredoc olmadan ${SURUM} genişlemez; kurulum sessizce
    // "${SURUM}" dizesi taşıyan bir plist üretirdi.
    assert.ok(
      betik.includes('cat > "$APP/Contents/Info.plist" <<EOF'),
      "plist heredoc'u tırnaksız olmalı",
    );
    // Kabukta gerçekten package.json sürümüne çözülüyor mu?
    const cikti = execFileSync(
      "/bin/bash",
      ["-c", 'cd "$1" && node -p "require(\'./package.json\').version"', "_", DEPO],
      { encoding: "utf8" },
    ).trim();
    assert.equal(cikti, paketSurumu());
  });
});

describe("P10a git kimliği — git binary'si çalıştırılmadan", () => {
  function sahteDepo(kur: (gitDir: string, kok: string) => void): { kok: string; temizle: () => void } {
    const t = tmpKok();
    const gitDir = join(t.kok, ".git");
    mkdirSync(gitDir, { recursive: true });
    kur(gitDir, t.kok);
    return t;
  }

  test("loose ref: dal ve commit çözülür", () => {
    const t = sahteDepo((g) => {
      writeFileSync(join(g, "HEAD"), "ref: refs/heads/main\n");
      mkdirSync(join(g, "refs", "heads"), { recursive: true });
      writeFileSync(join(g, "refs", "heads", "main"), `${"a".repeat(40)}\n`);
    });
    try {
      assert.deepEqual(gitKimligi(t.kok), { dal: "main", commit: "a".repeat(40), bicim: "loose" });
    } finally {
      t.temizle();
    }
  });

  test("packed-refs: loose ref yokken de commit bulunur", () => {
    const t = sahteDepo((g) => {
      writeFileSync(join(g, "HEAD"), "ref: refs/heads/ozellik/x\n");
      writeFileSync(
        join(g, "packed-refs"),
        `# pack-refs with: peeled fully-peeled sorted\n${"b".repeat(40)} refs/heads/ozellik/x\n${"c".repeat(40)} refs/tags/v1\n^${"d".repeat(40)}\n`,
      );
    });
    try {
      assert.deepEqual(gitKimligi(t.kok), {
        dal: "ozellik/x",
        commit: "b".repeat(40),
        bicim: "packed",
      });
    } finally {
      t.temizle();
    }
  });

  test("detached HEAD: dal null, commit dolu", () => {
    const t = sahteDepo((g) => writeFileSync(join(g, "HEAD"), `${"e".repeat(40)}\n`));
    try {
      assert.deepEqual(gitKimligi(t.kok), { dal: null, commit: "e".repeat(40), bicim: "detached" });
    } finally {
      t.temizle();
    }
  });

  test("worktree: .git bir DOSYA ise gitdir izlenir, ref ortak dizinden okunur", () => {
    const t = tmpKok();
    try {
      const ana = join(t.kok, "ana", ".git");
      mkdirSync(join(ana, "refs", "heads"), { recursive: true });
      writeFileSync(join(ana, "refs", "heads", "yan"), `${"f".repeat(40)}\n`);
      const wt = join(ana, "worktrees", "yan");
      mkdirSync(wt, { recursive: true });
      writeFileSync(join(wt, "HEAD"), "ref: refs/heads/yan\n");
      writeFileSync(join(wt, "commondir"), "../..\n");
      const calisma = join(t.kok, "calisma");
      mkdirSync(calisma, { recursive: true });
      writeFileSync(join(calisma, ".git"), `gitdir: ${wt}\n`);
      assert.deepEqual(gitKimligi(calisma), {
        dal: "yan",
        commit: "f".repeat(40),
        bicim: "loose",
      });
    } finally {
      t.temizle();
    }
  });

  test(".git yoksa veya bozuksa null/kısmi döner, ASLA atmaz", () => {
    const bos = tmpKok();
    try {
      assert.equal(gitKimligi(bos.kok), null);
    } finally {
      bos.temizle();
    }
    const bozuk = tmpKok();
    try {
      mkdirSync(join(bozuk.kok, ".git"));
      writeFileSync(join(bozuk.kok, ".git", "HEAD"), "anlamsız içerik\n");
      assert.deepEqual(gitKimligi(bozuk.kok), { dal: null, commit: null, bicim: "bilinmiyor" });
    } finally {
      bozuk.temizle();
    }
    // Commit'i olmayan yeni dal: dal bilinir, commit bilinmez.
    const yeni = tmpKok();
    try {
      mkdirSync(join(yeni.kok, ".git"));
      writeFileSync(join(yeni.kok, ".git", "HEAD"), "ref: refs/heads/yeni\n");
      assert.deepEqual(gitKimligi(yeni.kok), { dal: "yeni", commit: null, bicim: "bilinmiyor" });
    } finally {
      yeni.temizle();
    }
  });

  test("bu checkout'ta dal/commit gerçekten okunur (.git dosyalarından)", () => {
    const k = gitKimligi();
    assert.ok(k !== null, "depoda .git var; kimlik okunmalı");
    const head = readFileSync(join(DEPO, ".git", "HEAD"), "utf8").trim();
    if (head.startsWith("ref: ")) {
      assert.equal(k!.dal, head.slice(5).replace("refs/heads/", ""));
    }
    assert.match(k!.commit ?? "", /^[0-9a-f]{40}$/);
  });

  test("derlemeDurumu src ile dist'i karşılaştırır ve atmaz", () => {
    const d = derlemeDurumu();
    assert.ok(d.kaynakEnYeni !== null, "src/ altında .ts bulunmalı");
    assert.ok(d.derlemeEnYeni !== null, "dist/src altında .js bulunmalı");
    assert.equal(typeof d.taze, "boolean");
    const yok = tmpKok();
    try {
      assert.deepEqual(derlemeDurumu(yok.kok), {
        kaynakEnYeni: null,
        derlemeEnYeni: null,
        taze: null,
      });
    } finally {
      yok.temizle();
    }
  });
});

describe("P10a tanılama sırsızdır ve yazmaz", () => {
  test("çıktıda token/çerez/Bearer/kimlik deseni geçmez", () => {
    taniBellegiBosalt();
    const kok = tmpKok();
    try {
      const t = taniTopla({
        motorSurum: paketSurumu(),
        kok: kok.kok,
        ayarDizin: kok.kok,
        instanceId: "ins-abc",
      });
      const metin = JSON.stringify(t);
      for (const desen of [
        /JSESSIONID/i,
        /Bearer/i,
        /"?token"?\s*[:=]/i,
        /cookie/i,
        /caseKey/i,
        /evrakId/i,
        /dosyaId/i,
      ]) {
        assert.ok(!desen.test(metin), `tanılamada sır deseni: ${desen}`);
      }
      // Yapının kendisi beklenen alanları taşır (sırsızlık boşluktan gelmesin).
      assert.equal(t.surum.paket, paketSurumu());
      assert.equal(t.calisma.instanceId, "ins-abc");
      assert.equal(typeof t.calisma.node, "string");
      assert.ok(t.not.length > 10, "paylaşım uyarısı bulunmalı");
    } finally {
      kok.temizle();
    }
  });

  test("ölçüm HİÇBİR dosya oluşturmaz (arşiv kökü çağrı öncesi/sonrası aynı)", () => {
    taniBellegiBosalt();
    const kok = tmpKok();
    try {
      const once = readdirSync(kok.kok).sort();
      const t = taniTopla({ kok: kok.kok, ayarDizin: kok.kok });
      assert.deepEqual(readdirSync(kok.kok).sort(), once);
      assert.equal(t.arsiv.var, true);
      assert.equal(t.arsiv.yazilabilir, true);
    } finally {
      kok.temizle();
    }
  });

  test("salt-okunur kökte yazilabilir=false ve anlaşılır uyarı verilir", () => {
    taniBellegiBosalt();
    const kok = tmpKok();
    try {
      chmodSync(kok.kok, 0o500);
      const t = taniTopla({ kok: kok.kok });
      assert.equal(t.arsiv.var, true);
      assert.equal(t.arsiv.yazilabilir, false);
      assert.ok(
        t.uyarilar.some((u) => u.includes("yazma izni yok")),
        `uyarı bekleniyordu: ${JSON.stringify(t.uyarilar)}`,
      );
    } finally {
      chmodSync(kok.kok, 0o700);
      kok.temizle();
    }
  });

  test("olmayan kök 'bulunamadı' der; PATH_FORBIDDEN/atma yok", () => {
    taniBellegiBosalt();
    const t = taniTopla({ kok: "/bu/yol/kesinlikle/yok-12345" });
    assert.equal(t.arsiv.var, false);
    assert.equal(t.arsiv.yazilabilir, false);
    assert.ok(t.uyarilar.some((u) => u.includes("bulunamadı")));
  });

  test("sürüm uyuşmazlığı gizlenmez, uyarı olarak çıkar", () => {
    taniBellegiBosalt();
    const t = taniTopla({ motorSurum: "0.0.1-eski" });
    assert.equal(t.surum.uyusuyorMu, false);
    assert.ok(t.uyarilar.some((u) => u.includes("0.0.1-eski")));
    taniBellegiBosalt();
    const u = taniTopla({ motorSurum: paketSurumu() });
    assert.equal(u.surum.uyusuyorMu, true);
    assert.ok(!u.uyarilar.some((m) => m.includes("paket dosyası")));
  });

  test("pdftotext ve python3 ölçümü 30 sn belleklenir (ardışık çağrı fork etmez)", () => {
    taniBellegiBosalt();
    const bir = taniTopla({});
    const t0 = Date.now();
    const iki = taniTopla({});
    const gecen = Date.now() - t0;
    assert.deepEqual(iki.bagimlilik, bir.bagimlilik);
    // İki alt süreç (python3 + pdftotext taraması) yeniden doğsaydı bu ölçüm
    // milisaniyeler değil onlarca ms sürerdi; eşik cömert tutuldu.
    assert.ok(gecen < 150, `önbellek çalışmıyor olabilir: ${gecen} ms`);
  });

  test("pdftotext yokluğu teknik olmayan dille anlatılır, yol ya null ya mutlaktır", () => {
    taniBellegiBosalt();
    const t = taniTopla({});
    const p = t.bagimlilik.pdftotext;
    assert.ok(p.yol === null || p.yol.startsWith("/"), `beklenmeyen yol: ${p.yol}`);
    if (!p.var) assert.ok(p.not.includes("brew install poppler"));
    else assert.ok(p.not.includes("metni"));
  });

  test("çalışan kaynak ve kurulu komut raporlanır (git çalıştırılmadan)", () => {
    taniBellegiBosalt();
    const t = taniTopla({});
    assert.ok(statSync(join(t.kaynak.calisanKok, "package.json")).isFile());
    assert.ok(["loose", "packed", "detached", "bilinmiyor", null].includes(t.kaynak.gitBicim));
    if (t.kaynak.kurulanKomut !== null) {
      assert.ok(t.kaynak.kurulanKomut.cozulmus.startsWith("/"));
      assert.equal(typeof t.kaynak.kurulanKomut.ayniKokMu, "boolean");
    }
  });

  test("daemon `tani` işleyicisi gövdeyi yok sayar ve oturuma dokunmaz", async () => {
    const ayar = tmpKok();
    const kok = tmpKok();
    try {
      const d = daemonKur({ ayarDir: ayar.kok, kok: kok.kok, portalUrl: "http://127.0.0.1:1" });
      taniBellegiBosalt();
      const t = (await d.isleyiciler.get("tani")!({
        kok: "/etc",
        caseKey: "gizli",
        yol: "/etc/passwd",
      })) as { arsiv: { kok: string }; surum: { paket: string } };
      // Gövdedeki `kok` YOK SAYILDI: ölçülen kök daemon'ın kendi köküdür.
      assert.equal(t.arsiv.kok, kok.kok);
      assert.equal(t.surum.paket, paketSurumu());
    } finally {
      ayar.temizle();
      kok.temizle();
    }
  });
});

describe("P10a katı dava çözücü (T05)", () => {
  const kayit = (birimAdi: string, dosyaNo: string): DavaKaydi => ({
    caseKey: `${birimAdi}\u0000${dosyaNo}`,
    birimAdi,
    dosyaNo,
  });
  const iki = [
    kayit("Denizli 1. Asliye Hukuk Mahkemesi", "2026/928"),
    kayit("Denizli 2. Asliye Hukuk Mahkemesi", "2026/928"),
  ];

  test("kesin eşleşme, aynı esaslı iki mahkeme varken bile doğru kaydı verir", () => {
    assert.equal(
      davaRefCoz(iki, "Denizli 2. Asliye Hukuk Mahkemesi 2026-928"),
      iki[1]!.caseKey,
    );
  });

  test("belirsiz referansta İLK ADAY SEÇİLMEZ: INVALID_INPUT + aday listesi", () => {
    let yakalandi = false;
    try {
      davaRefCoz(iki, "Asliye Hukuk Mahkemesi 2026-928");
    } catch (e) {
      yakalandi = true;
      const h = e as { code?: string; message?: string; details?: { adaylar?: string[] } };
      assert.equal(h.code, "INVALID_INPUT");
      assert.deepEqual(h.details?.adaylar, [
        "Denizli 1. Asliye Hukuk Mahkemesi 2026/928",
        "Denizli 2. Asliye Hukuk Mahkemesi 2026/928",
      ]);
      // Ham caseKey (NUL ayraçlı) kullanıcıya BASILMAZ.
      assert.ok(!h.message!.includes("\u0000"));
      assert.ok(h.message!.includes("Denizli 1."));
      assert.ok(h.message!.includes("Denizli 2."));
    }
    assert.ok(yakalandi, "belirsiz referans sessizce çözülmemeli");
  });

  test("kırpılmış birim adı TEK adaya uyuyorsa eskisi gibi çözülür", () => {
    const tek = [kayit("Denizli 1. Asliye Hukuk Mahkemesi", "2026/928")];
    assert.equal(davaRefCoz(tek, "Asliye Hukuk Mahkemesi 2026-928"), tek[0]!.caseKey);
  });

  test("aynı birim+esas iki kez kayıtlıysa da belirsizlik bildirilir", () => {
    const ikiz = [
      kayit("Aynı Mahkeme", "2026/1"),
      { ...kayit("Aynı Mahkeme", "2026/1"), caseKey: "Aynı Mahkeme\u00002026/1#2" },
    ];
    assert.throws(() => davaRefCoz(ikiz, "Aynı Mahkeme 2026-1"), /belirsiz/);
  });

  test("ham caseKey ile tam eşleşme çalışır; hiç aday yoksa NOT_FOUND", () => {
    assert.equal(davaRefCoz(iki, "Denizli 1. Asliye Hukuk Mahkemesi 2026/928"), iki[0]!.caseKey);
    assert.throws(
      () => davaRefCoz(iki, "Yok Mahkemesi 2026-999"),
      (e: { code?: string }) => e.code === "NOT_FOUND",
    );
  });

  test("serbest yazım: gündelik ad tek kayda çözülür, belirsizse yine SEÇMEZ", () => {
    const arsiv = [
      kayit("Çamlık İcra Dairesi", "2026/924"),
      kayit("Çamlık Asliye Hukuk Mahkemesi", "2026/928"),
      kayit("Denizli 3. Asliye Ceza Mahkemesi", "2026/951"),
    ];
    assert.equal(davaRefCoz(arsiv, "çamlık asliye hukuk"), arsiv[1]!.caseKey);
    assert.equal(davaRefCoz(arsiv, "CAMLIK ASLIYE"), arsiv[1]!.caseKey, "aksansız/büyük harf");
    assert.equal(davaRefCoz(arsiv, "2026/951"), arsiv[2]!.caseKey, "yalnız esas no");
    assert.equal(davaRefCoz(arsiv, "çamlık 2026-924"), arsiv[0]!.caseKey, "tire biçimli esas");
    assert.throws(
      () => davaRefCoz(arsiv, "çamlık"),
      (e: { code?: string; details?: { adaylar?: string[] } }) =>
        e.code === "INVALID_INPUT" && e.details?.adaylar?.length === 2,
    );
    // Rakamlı sözcük ÖNEKLE tutmaz: "2026/92" yazan kişi 2026/924'ü de
    // 2026/928'i de istemiyor olabilir; tahmin yanlış dosyayı açar.
    assert.throws(
      () => davaRefCoz([arsiv[1]!], "2026/92"),
      (e: { code?: string }) => e.code === "NOT_FOUND",
    );
  });

  test("boş registry ve biçimsiz referans atar, çökmeyle değil kodla", () => {
    assert.throws(
      () => davaRefCoz([], "herhangi bir şey"),
      (e: { code?: string }) => e.code === "NOT_FOUND",
    );
  });
});

describe("P10a derleme ↔ çalışan süreç farkı", () => {
  // "Derlendi" ile "ÇALIŞIYOR" ayrı sorulardır. derleme.taze yalnız kaynak↔dist
  // kıyasıdır; motor derlemeden ÖNCE başladıysa dist güncel olsa bile çalışan
  // kod eskidir. Bu, kurulu komutun geliştirme checkout'una symlink'li olduğu
  // bu projede en sık karşılaşılan durumdur.
  test("derleme çalışan motordan yeniyse uyarı çıkar", () => {
    taniBellegiBosalt();
    const eskiSurec = Date.parse("2000-01-01T00:00:00Z");
    const t = taniTopla({ instanceId: "motor-1", surecBaslangicMs: eskiSurec });
    assert.equal(t.calisma.baslangicAt, new Date(eskiSurec).toISOString());
    assert.ok(
      t.uyarilar.some((u) => u.includes("Derleme çalışan motordan yeni")),
      `uyarı bekleniyordu, çıkanlar: ${JSON.stringify(t.uyarilar)}`,
    );
  });

  test("motor derlemeden yeniyse uyarı çıkmaz", () => {
    taniBellegiBosalt();
    const t = taniTopla({ instanceId: "motor-1", surecBaslangicMs: Date.now() + 60_000 });
    assert.ok(!t.uyarilar.some((u) => u.includes("Derleme çalışan motordan yeni")));
  });

  test("CLI ölçümünde (instanceId yok) bu uyarı hiç üretilmez", () => {
    // CLI süreci az önce başlar; orada "süreç derlemeden eski" her zaman doğru
    // çıkar ve kullanıcıya anlamsız bir uyarı gösterirdi.
    taniBellegiBosalt();
    const t = taniTopla({ surecBaslangicMs: Date.parse("2000-01-01T00:00:00Z") });
    assert.ok(!t.uyarilar.some((u) => u.includes("Derleme çalışan motordan yeni")));
  });
});
