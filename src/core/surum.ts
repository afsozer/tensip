// Sürüm ve kaynak kimliği — TEK KAYNAK.
//
// P10a kuralı: paket sürümü kaynak kodunda İKİNCİ KEZ YAZILMAZ. Tek yazılı yer
// `package.json`'dur ve buradan çalışma anında okunur (aynı desen: web.ts
// varlıklarını `new URL("../../../web/", import.meta.url)` ile bulur). Okunamazsa
// "bilinmiyor" döner; uydurma bir sürüm numarası ÜRETİLMEZ, çünkü sahte bir
// numara "hangi kod çalışıyor" sorusunu yanlış yanıtlar.
//
// Kaynak (checkout) kimliği `.git` dizini OKUNARAK çözülür; `git` binary'si
// ÇALIŞTIRILMAZ. Gerekçe iki türlü: (1) tanılama bir alt sürecin asılmasına
// bağlanmamalı, (2) kurulu uygulamada git yüklü olmayabilir. Her okuma
// hatası `null`/kısmi sonuçla karşılanır — tanılama ASLA atmaz.

import { readFileSync, statSync, readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** package.json okunamadığında görünen değer. Sürüm numarası DEĞİLDİR. */
export const SURUM_BILINMIYOR = "bilinmiyor";

export interface SurumBilgisi {
  surum: string;
  kaynak: "package.json" | "bilinmiyor";
}

/**
 * Çalışan kodun kökü (depo / kurulum dizini).
 *
 * Derlenmiş hâlde bu dosya `dist/src/core/surum.js`tir; üç seviye yukarısı
 * depo köküdür. `src/server/web.ts`in varlık çözümü ile aynı varsayım.
 */
export function kaynakKoku(): string {
  return fileURLToPath(new URL("../../../", import.meta.url));
}

// KÖKE göre bellek. Süreç genelinde TEK bir değer tutmak iki şeyi birden
// bozuyordu: (1) `kok` argümanı sessizce yutuluyordu — ikinci çağrı hangi kökle
// gelirse gelsin ilk kökün sürümünü alıyordu; (2) daha kötüsü, tanılamadaki
// "motor ne diyor, paket dosyası ne diyor" kıyası AYNI belleği iki kez okuduğu
// için hiçbir zaman uyuşmazlık göremiyordu (`uyusuyorMu` daima true, uyarı hiç
// çıkmaz). Uyuşmazlık uyarısının varlık sebebi tam da bu senaryodur: paket
// güncellenmiş, motor eski kodla çalışmaya devam ediyor.
const surumBellek = new Map<string, SurumBilgisi>();

function surumOku(kok: string): SurumBilgisi {
  try {
    const ham = readFileSync(join(kok, "package.json"), "utf8");
    const v = (JSON.parse(ham) as { version?: unknown }).version;
    return typeof v === "string" && v.trim() !== ""
      ? { surum: v.trim(), kaynak: "package.json" }
      : { surum: SURUM_BILINMIYOR, kaynak: "bilinmiyor" };
  } catch {
    return { surum: SURUM_BILINMIYOR, kaynak: "bilinmiyor" };
  }
}

/**
 * package.json'daki sürüm.
 *
 * Varsayılan olarak kök başına BİR KEZ okunur: motorun kimliği (`paketSurumu`)
 * süreç ömrü boyunca sabit kalmalıdır, yoksa "hangi sürüm çalışıyor" sorusu
 * çağrı anına göre değişen bir cevap alır.
 *
 * `bellek: false` diski YENİDEN okur ve belleği TAZELEMEZ. Tanılama bu yolu
 * kullanır (src/convert/pdftext.ts `pdftotextBul(false)` ile aynı desen):
 * "motor 1.1.0 diyor, paket dosyası 1.2.0 diyor" cümlesi ancak iki değer AYRI
 * anlardan geldiğinde kurulabilir. Taze okuma belleği ezseydi motorun kimliği
 * süreç ortasında sessizce kayar ve uyarı bir daha hiç çıkmazdı.
 *
 * Maliyet: tek `readFileSync` + `JSON.parse` (~1 KB). Tanılama sayfaya her
 * girişte bir kez çağrılır; 5 sn'lik durum yoklamasına EKLENMEZ.
 */
export function surumBilgisi(
  kok = kaynakKoku(),
  sec: { bellek?: boolean } = {},
): SurumBilgisi {
  if (sec.bellek === false) return surumOku(kok);
  const anahtar = resolve(kok);
  const onceki = surumBellek.get(anahtar);
  if (onceki !== undefined) return onceki;
  const sonuc = surumOku(kok);
  surumBellek.set(anahtar, sonuc);
  return sonuc;
}

/**
 * Paket sürümü. Motorda, CLI'da ve kur betiğinde aynı değer görünsün diye
 * sabit yerine BU çağrılır.
 */
export function paketSurumu(): string {
  return surumBilgisi().surum;
}

export interface GitKimlik {
  /** Çıkık dal adı; detached HEAD'de null. */
  dal: string | null;
  /** 40 haneli sha; çözülemezse null. */
  commit: string | null;
  /** Commit'in nereden okunduğu — kanıtın kaynağı görünür kalsın diye. */
  bicim: "loose" | "packed" | "detached" | "bilinmiyor";
}

/** `<kok>/.git` dizin mi, worktree/submodule işaretçisi mi? */
function gitDizini(kok: string): string | null {
  const aday = join(kok, ".git");
  let st;
  try {
    st = statSync(aday);
  } catch {
    return null;
  }
  if (st.isDirectory()) return aday;
  if (!st.isFile()) return null;
  // worktree / submodule: ".git" dosyası "gitdir: <yol>" taşır
  try {
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(aday, "utf8"));
    if (!m) return null;
    const yol = m[1]!.trim();
    return isAbsolute(yol) ? yol : resolve(kok, yol);
  } catch {
    return null;
  }
}

/** Worktree'de ref'ler ortak dizindedir; `commondir` onu gösterir. */
function ortakDizin(gitDir: string): string {
  try {
    const yol = readFileSync(join(gitDir, "commondir"), "utf8").trim();
    if (yol === "") return gitDir;
    return isAbsolute(yol) ? yol : resolve(gitDir, yol);
  } catch {
    return gitDir;
  }
}

function refOku(dizinler: string[], ref: string): string | null {
  for (const d of dizinler) {
    try {
      const s = readFileSync(join(d, ref), "utf8").trim();
      if (/^[0-9a-f]{40}$/.test(s)) return s;
    } catch {
      /* sıradaki */
    }
  }
  return null;
}

function packedRefOku(dizinler: string[], ref: string): string | null {
  for (const d of dizinler) {
    let metin;
    try {
      metin = readFileSync(join(d, "packed-refs"), "utf8");
    } catch {
      continue;
    }
    for (const satir of metin.split("\n")) {
      if (satir.startsWith("#") || satir.startsWith("^")) continue;
      const m = /^([0-9a-f]{40})\s+(.+)$/.exec(satir.trim());
      if (m && m[2] === ref) return m[1]!;
    }
  }
  return null;
}

/**
 * Çıkık dal ve commit — yalnız dosya okuyarak.
 *
 * `.git` yoksa (kurulu paket, kopyalanmış klasör) null döner: "git bilgisi yok"
 * geçerli bir cevaptır ve uydurulmaz. Desteklenen hâller: loose ref,
 * packed-refs, detached HEAD, worktree (`.git` dosyası + `commondir`).
 */
export function gitKimligi(kok = kaynakKoku()): GitKimlik | null {
  const gitDir = gitDizini(kok);
  if (gitDir === null) return null;
  const ortak = ortakDizin(gitDir);
  const dizinler = ortak === gitDir ? [gitDir] : [gitDir, ortak];
  let head;
  try {
    head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
  } catch {
    return null;
  }
  if (/^[0-9a-f]{40}$/.test(head)) {
    return { dal: null, commit: head, bicim: "detached" };
  }
  const m = /^ref:\s*(.+)$/.exec(head);
  if (!m) return { dal: null, commit: null, bicim: "bilinmiyor" };
  const ref = m[1]!.trim();
  const dal = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
  const loose = refOku(dizinler, ref);
  if (loose !== null) return { dal, commit: loose, bicim: "loose" };
  const packed = packedRefOku(dizinler, ref);
  if (packed !== null) return { dal, commit: packed, bicim: "packed" };
  // Dal adı bilinir ama commit çözülemedi (henüz commit'siz dal, bozuk ref).
  return { dal, commit: null, bicim: "bilinmiyor" };
}

export interface DerlemeDurumu {
  /** En yeni `src/**\/*.ts` değişiklik zamanı (ISO) — yoksa null. */
  kaynakEnYeni: string | null;
  /** En yeni `dist/src/**\/*.js` değişiklik zamanı (ISO) — yoksa null. */
  derlemeEnYeni: string | null;
  /** Derleme kaynaktan yeni mi? Ölçülemezse null. */
  taze: boolean | null;
}

function enYeniMtime(dizin: string, uzanti: string): number | null {
  let en: number | null = null;
  let girisler;
  try {
    girisler = readdirSync(dizin, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const g of girisler) {
    const tam = join(dizin, g.name);
    if (g.isDirectory()) {
      const alt = enYeniMtime(tam, uzanti);
      if (alt !== null && (en === null || alt > en)) en = alt;
      continue;
    }
    if (!g.name.endsWith(uzanti)) continue;
    try {
      const t = statSync(tam).mtimeMs;
      if (en === null || t > en) en = t;
    } catch {
      /* yok say */
    }
  }
  return en;
}

/**
 * "Derlendi" ile "çalışıyor" farkının ölçülebilir imzası.
 *
 * `src/` altındaki en yeni TypeScript dosyası, çalışan `dist/src/` çıktısından
 * yeniyse kullanıcı kaydettiği değişikliği çalışır sanabilir. Bu ölçüm hiçbir
 * şeyi düzeltmez; yalnız görünür kılar.
 */
export function derlemeDurumu(kok = kaynakKoku()): DerlemeDurumu {
  const kaynak = enYeniMtime(join(kok, "src"), ".ts");
  const derleme = enYeniMtime(join(kok, "dist", "src"), ".js");
  return {
    kaynakEnYeni: kaynak === null ? null : new Date(kaynak).toISOString(),
    derlemeEnYeni: derleme === null ? null : new Date(derleme).toISOString(),
    taze: kaynak === null || derleme === null ? null : derleme >= kaynak,
  };
}
