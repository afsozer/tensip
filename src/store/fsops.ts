// Dosya sistemi işlemleri: atomik yazım + yol güvenliği (containment).
// Dosya sistemi ilkeleri:
//  - JSON yazımı: tmp dosya + rename + chmod 0600 (sır içermez ama evrak olabilir)
//  - containment: kök dışına kesin yazım yasası (PATH_FORBIDDEN)
//
// P06c — JSON ve BELGE yazımı artık AYNI gövdedir (`atomikYaz`). İkisi ayrı
// yazıldığı sürece belge yolu sessizce zayıf kaldı: fsync yoktu, hata hâlinde
// geçici dosya ortada kalıyordu ve geçici ad aynı milisaniyede çakışabiliyordu.

import {
  chmodSync,
  mkdirSync,
  openSync,
  closeSync,
  fsyncSync,
  renameSync,
  rmSync,
  writeFileSync,
  constants,
  realpathSync,
  statSync,
  lstatSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join, dirname, resolve, sep } from "node:path";
import { Hata, KODLAR } from "../core/errors.js";

// Node'un basename'i: lib'den özel içe aktarma yerine kendi kısayolumuz
import { basename } from "node:path";

/**
 * P06c — ATOMİK YAZIMIN GEÇİCİ ADI, TEK YERDE.
 *
 * Ad üç parçadan kurulur: süreç kimliği + `randomUUID()` + `.tmp`. Baştaki
 * nokta bilerektir (arayüz ve denetim gizli dosyayı evrak sanmasın).
 *
 * NEDEN UUID: eski metin yazıcısı `Date.now()` kullanıyordu ve indirme
 * döngüsü aynı milisaniyede iki dosya yazabiliyordu; aynı ada iki yazım
 * birbirinin geçici dosyasını ezerdi. Süre damgası ölçüm için de yeterli
 * değildi — hangi yazımın yarım kaldığını ayırt etmiyordu.
 *
 * Bu ad DENETİMİN de tanıdığı desendir (`yarimYazimHedefi`): yarım kalmış bir
 * yazımın artığı "kayıtsız dosya" ile aynı kefeye girmesin diye.
 */
export function geciciYazimYolu(dosya: string): string {
  return join(dirname(dosya), `.${basename(dosya)}.${process.pid}.${randomUUID()}.tmp`);
}

/**
 * Bir dosya adı ATOMİK YAZIMIN yarım kalmış artığı mı? Öyleyse yazılmakta
 * olan dosyanın adı, değilse `null`.
 *
 * Eski (`Date.now()`) ve yeni (UUID) desenin ikisini de tanır: kesinti eski
 * sürümde olduysa artık bugün de görünür kalsın.
 */
export function yarimYazimHedefi(ad: string): string | null {
  const es = /^\.(.+)\.\d+\.([0-9a-fA-F]{8,13}|[0-9a-fA-F-]{36})\.tmp$/.exec(ad);
  return es === null ? null : es[1]!;
}

/**
 * P06c — TEK ATOMİK YAZICI GÖVDESİ.
 *
 * `O_EXCL` ile açar (var olan bir dosyanın üstüne asla yazmaz), yazar,
 * **fsync** eder, kapatır, `rename` ile yerine koyar ve hata hâlinde geçici
 * dosyayı temizler. Temizlik YALNIZ biz açtıysak yapılır: `O_EXCL` `EEXIST`
 * ile düşerse o dosya BİZİM değildir ve silinmesi başkasının yazımını yok
 * etmek olurdu.
 *
 * fsync neden var: `rename` döndükten sonra elektrik giderse ad yerinde olur
 * ama baytlar diskte olmayabilir; manifest "bu belge var, sha256'sı şu" derken
 * dosya boş ya da yarım çıkar. Bu, bu turda üç kez kovalanan "belge sessizce
 * kayboldu" sınıfının dosya sistemi katmanıdır.
 *
 * BEDELİ UCUZ DEĞİL, ÖLÇÜLDÜ (14 Eylül 2026, bu makine, APFS, 7 tur):
 *   • 108 belge × 34 KB salt yazım: 11,9 ms → 451,6 ms (belge başına
 *     0,11 ms → 4,18 ms). fsync'in kendisi ~4 ms'lik SABİT bir bedeldir.
 *   • 108 belgelik uçtan uca klon (sahte portal, `istekAralikMs: 1`):
 *     2441 ms → 3275 ms, yani +834 ms (%34). Fark iki fsync/belgedir
 *     (kaynak + `.md` türevi); manifest zaten fsync'liydi.
 * KABUL GEREKÇESİ: gerçek portalda istek arası 3–5 sn'dir (`src/core/fren.ts`),
 * yani 108 belgelik gerçek bir klon en az 5,4 dk sürer ve +0,83 sn onun
 * binde üçüdür. Kullanıcının göremeyeceği bu bedel karşılığında, elektrik kesilse
 * bile manifestin bildirdiği belge diskte GERÇEKTEN durur. Türevi fsync'ten
 * muaf tutmak bedeli yarıya indirirdi ve BİLEREK YAPILMADI: iki ayrı
 * dayanıklılık sınıfı, bu paketin kapattığı kusurun ta kendisiydi.
 * SINIR (abartılmasın): macOS'ta `fsync(2)` veriyi aygıta indirir ama aygıtın
 * kendi önbelleğinden geçtiğini garanti etmez; onun için `F_FULLFSYNC`
 * gerekir ve o ÇAĞRILMIYOR. Bu yazıcı "süreç ölürse tutarlı" sözünü verir,
 * "diskin kendi önbelleği de dâhil her koşulda" sözünü vermez.
 */
function atomikYaz(dosya: string, yaz: (fd: number) => void, mod: number): void {
  mkdirSync(dirname(dosya), { recursive: true });
  const gecici = geciciYazimYolu(dosya);
  let bizActik = false;
  try {
    const fd = openSync(gecici, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mod);
    bizActik = true;
    try {
      yaz(fd);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(gecici, dosya);
    try { chmodSync(dosya, mod); } catch { /* platform */ }
  } finally {
    if (bizActik) rmSync(gecici, { force: true });
  }
}

export function yazJsonAtomik(dosya: string, veri: unknown, mod = 0o600): void {
  atomikYaz(dosya, (fd) => writeFileSync(fd, JSON.stringify(veri, null, 2)), mod);
}

/**
 * KULLANICININ BELGELERİNİ yazan yol (evrak indirme + `.md` türevi).
 *
 * P06c'ye kadar bu yazıcı JSON yazıcısından ZAYIFTI: `Date.now()` geçici ad,
 * düz `writeFileSync`, fsync YOK, hata hâlinde temizlik YOK, izin
 * belirtilmemiş (umask'e göre 0644). Artık ikisi de aynı gövdedir; izin de
 * manifestle aynı: 0600 — arşiv kullanıcının kendi evrakıdır.
 */
export function yazMetinAtomik(dosya: string, icerik: string | Buffer, mod = 0o600): void {
  atomikYaz(dosya, (fd) => writeFileSync(fd, icerik), mod);
}

/** Bir yolun kök içinde (veya kök ile aynı) olup olmadığını gerçek yolla denetler. */
/** Resolve the closest existing ancestor, including a target that is a symlink. */
function gercekYol(hedef: string): string {
  let mevcut = resolve(hedef);
  const eksik: string[] = [];
  for (;;) {
    try {
      lstatSync(mevcut);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      const ust = dirname(mevcut);
      if (ust === mevcut) throw e;
      eksik.unshift(basename(mevcut));
      mevcut = ust;
      continue;
    }
    // Resolve existing symlinks; dangling links fail instead of lexical fallback.
    return resolve(realpathSync(mevcut), ...eksik);
  }
}

export function kapsamIcindeMi(kok: string, hedef: string): boolean {
  try {
    const kokReal = gercekYol(kok);
    const hedefReal = gercekYol(hedef);
    return hedefReal === kokReal || hedefReal.startsWith(kokReal.endsWith(sep) ? kokReal : kokReal + sep);
  } catch {
    return false;
  }
}

export function kapsamKontrol(kok: string, hedef: string): void {
  if (!kapsamIcindeMi(kok, hedef)) {
    throw new Hata(KODLAR.PATH_FORBIDDEN, `yazma kök dışına engellendi: ${hedef}`);
  }
}

/**
 * Manifest'te KAYITLI bir yolun BUGÜN diskte ne durumda olduğu.
 *
 * Bu bir DENETİM DEĞİLDİR (o P06a'nın işi): hash doğrulanmaz, yetim dosya
 * aranmaz, manifest sınıflanmaz, hiçbir bayt yazılmaz. Tek soru şudur:
 * "kayıtlı yol diskte var mı?" Cevap dört daldan biridir ve "yok" ile
 * "erişemedim" BİLEREK ayrıdır (T03) — silinmiş bir evrakla, izin verilmediği
 * ya da diski bağlı olmadığı için okunamayan bir evrak kullanıcı için aynı şey
 * değildir; birine "yeniden eşitle", diğerine "diski bağla" denir.
 *
 *   var          yol kök içinde çözüldü ve orada bir şey duruyor (`tur` söyler)
 *   yok          yol kök içinde, orada hiçbir şey yok (ENOENT)
 *   erisilemiyor ÇÖZÜLEMEDİ: izin (EACCES/EPERM), bağlı olmayan disk, kırık
 *                symlink, döngü… "yok" DEĞİLDİR ve öyle gösterilmemelidir
 *   kapsamDisi   gerçek yol arşiv kökünün dışına çıkıyor (symlink kaçışı dahil)
 *
 * Kapsam denetimi HER ZAMAN okumadan öncedir ve symlink `gercekYol` ile
 * çözülür; kökün dışına bakan bir yol hiç stat edilmez.
 */
export type KaynakDurum = "var" | "yok" | "erisilemiyor" | "kapsamDisi";
export type KaynakOlcum = {
  durum: KaynakDurum;
  /** "erisilemiyor" dalında sebebin errno'su (EACCES, ENOENT, ELOOP…). */
  errno?: string;
  /** Yalnız "var" dalında. */
  tur?: "dosya" | "dizin" | "diger";
};

/**
 * Aynı kök altında ÇOK yol ölçülecekse (evrak listesi) bunu kullanın: kök bir
 * kez, her DİZİN bir kez çözülür; satır başına yalnız tek `lstat` kalır.
 *
 * ÖLÇÜLDÜ (11 Eyl 2026, bu makine, ısınmış, 20 tur ortalaması, DERLENMİŞ kodla;
 * sentetik dava klasörü, her 5. evrakın ayrı `_ekler` dizini var — gerçek
 * düzenden daha ÇOK dizin, yani ölçüm karamsar taraftan):
 *    6 evrak /   6 dizin → 0,24 ms
 *   31 evrak /  28 dizin → 0,69 ms
 *  200 evrak /  64 dizin → 1,79 ms
 *  600 evrak / 144 dizin → 4,05 ms (%25'i eksikken 4,03 ms)
 * 2000 evrak / 424 dizin → 12,76 ms
 * Satır başına `kaynakDurumu` çağrılsaydı (kök + dizin her satırda yeniden
 * çözülür) aynı işler 1,10 / 6,21 / 18,39 / 61,83 ms sürüyordu — önbelleğin
 * tek gerekçesi bu. Dizin başına `readdir` 600 evrakta 2,03 ms'de kalıyordu
 * ama ne izin hatasını ayırabiliyor ne de symlink kaçışını görebiliyordu, bu
 * yüzden elendi. Önbellek tek ölçüm turuna (tek RPC çağrısına) aittir; sonraki
 * çağrı diski yeniden okur, yani rozet bayatlamaz.
 */
export function kaynakOlcer(kok: string): (hedef: string) => KaynakOlcum {
  let kokReal: string | null = null;
  let kokErrno: string | undefined;
  try {
    kokReal = gercekYol(kok);
  } catch (e) {
    kokErrno = (e as NodeJS.ErrnoException).code ?? "EUNKNOWN";
  }
  // dizin → çözülmüş gerçek yol, ya da çözülemediyse errno. Kapsam KARARI
  // burada verilmez: hedefin kökün KENDİSİ olması da geçerli bir durumdur
  // (klasor-ac dava klasörünü ölçer) ve onun dizini kökün dışındadır.
  const dizinler = new Map<string, { real?: string; errno?: string }>();
  const icinde = (hedefReal: string) =>
    hedefReal === kokReal ||
    hedefReal.startsWith(kokReal!.endsWith(sep) ? kokReal! : kokReal! + sep);
  const tipi = (b: { isFile(): boolean; isDirectory(): boolean }) =>
    b.isFile() ? "dosya" : b.isDirectory() ? "dizin" : "diger";
  return (hedef: string): KaynakOlcum => {
    // Kökün kendisi çözülemiyorsa altındaki hiçbir yol hakkında konuşamayız.
    if (kokReal === null) return { durum: "erisilemiyor", errno: kokErrno };
    const mutlak = resolve(hedef);
    const dizin = dirname(mutlak);
    let dizinSonuc = dizinler.get(dizin);
    if (dizinSonuc === undefined) {
      try {
        dizinSonuc = { real: gercekYol(dizin) };
      } catch (e) {
        dizinSonuc = {
          errno: (e as NodeJS.ErrnoException).code ?? "EUNKNOWN",
        };
      }
      dizinler.set(dizin, dizinSonuc);
    }
    if (dizinSonuc.real === undefined)
      return { durum: "erisilemiyor", errno: dizinSonuc.errno };
    // Kapsam denetimi STAT'TAN ÖNCE: kök dışına çıkan yol hiç yoklanmaz.
    // Yaprak symlink ise bu yalnız ön elemedir; asıl karar aşağıda, tam
    // çözümle verilir.
    if (!icinde(join(dizinSonuc.real, basename(mutlak))))
      return { durum: "kapsamDisi" };
    let bilgi;
    try {
      bilgi = lstatSync(mutlak, { throwIfNoEntry: false });
    } catch (e) {
      return {
        durum: "erisilemiyor",
        errno: (e as NodeJS.ErrnoException).code ?? "EUNKNOWN",
      };
    }
    if (bilgi === undefined) return { durum: "yok" };
    if (!bilgi.isSymbolicLink()) return { durum: "var", tur: tipi(bilgi) };
    // Yaprağın kendisi symlink: kaçış kontrolü burada, tam çözümle yapılır.
    try {
      if (!icinde(gercekYol(mutlak))) return { durum: "kapsamDisi" };
      const hedefBilgi = statSync(mutlak, { throwIfNoEntry: false });
      if (hedefBilgi === undefined) return { durum: "yok" };
      return { durum: "var", tur: tipi(hedefBilgi) };
    } catch (e) {
      // Kırık symlink de buraya düşer: ENOENT ama "yok" DEMEYİZ — bağlantı
      // duruyor, çözülemiyor; bunu "silinmiş" saymak kullanıcıyı yanıltır.
      return {
        durum: "erisilemiyor",
        errno: (e as NodeJS.ErrnoException).code ?? "EUNKNOWN",
      };
    }
  };
}

/** Tek yolun ölçümü. Çok yol için `kaynakOlcer` (kök/dizin önbellekli). */
export function kaynakDurumu(kok: string, hedef: string): KaynakOlcum {
  return kaynakOlcer(kok)(hedef);
}

export function varMi(dosya: string): boolean {
  try {
    statSync(dosya);
    return true;
  } catch {
    return false;
  }
}

export function temizle(dosya: string): void {
  rmSync(dosya, { force: true });
}

export function randHex(byteSayisi = 8): string {
  const buf = new Uint8Array(byteSayisi);
  globalThis.crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

export { join, dirname, resolve };
