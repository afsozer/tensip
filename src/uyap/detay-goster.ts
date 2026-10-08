// Portal detay satırlarının OKUNUR görünümü (P07b) — safahat / taraf / hesap.
//
// NEDEN MOTORDA: eşleme TEK YERDE durur. Arayüz ikinci bir başlık tablosu
// yazmaz; `gorunum` alanını olduğu gibi çizer (P16 `sayilir`, P15c
// `kaynakDurum`, P06b `ONARIM_TABLOSU` kalıbı). İki tablo olsaydı biri
// güncellenip diğeri unutulur ve ekranda başka, CLI'da başka ad görünürdü.
//
// SABİT ŞEMA YOKTUR. `DetaySatiri = Record<string, unknown>`; alanlar dosya
// TÜRÜNE GÖRE değişir (P18'in dersi: icra dosyasında "Alacaklı/Borçlu", ceza
// çocuk dosyasında "Katılan/Suça Sürüklenen Çocuk"). Aşağıdaki tablo bir
// ŞEMA DEĞİL, yalnız GÖRÜLMÜŞ alan adlarının Türkçe karşılığıdır: tabloda
// olmayan alan da satırda kalır.
//
// HİÇBİR ALAN SESSİZCE ATILMAZ. Tanınmayan alanı gizlemek ham göstermekten
// KÖTÜDÜR — avukat eksik veriye baktığını anlamaz. Tanınmayanlar `digerleri`
// bölümünde toplanır ama GÖRÜNÜR kalır (iki ayrı test).
//
// UYDURMA YOK. Tarih yalnız TANINAN bir kalıba uyuyorsa yeniden biçimlenir;
// uymayan değer OLDUĞU GİBİ gösterilir. Para yalnız sayı geldiğinde ayraçlanır;
// para birimi EKLENMEZ (portal hangi birimi verdiğini söylemiyor).

import type { DetaySatiri } from "./dosyadetay.js";

/** Bir alanın ekrandaki karşılığı. `tur` yalnız BİÇİMLEME ipucudur. */
export interface AlanBilgisi {
  baslik: string;
  tur?: "tarih" | "para";
}

/** İç içe değerin okunur karşılığı — JSON metni DEĞİL. */
export type DetayDeger =
  | { tur: "metin"; metin: string }
  | { tur: "liste"; ogeler: DetayDeger[] }
  | { tur: "alanlar"; alanlar: DetayAlani[] };

export interface DetayAlani {
  /** Türkçe başlık; portalın HAM alan adı burada asla görünmez. */
  baslik: string;
  deger: DetayDeger;
}

/** Bir portal satırının ekran karşılığı. */
export interface DetayKaydi {
  /** Tabloda karşılığı bulunan alanlar (satırdaki sırayla). */
  alanlar: DetayAlani[];
  /** Tabloda OLMAYAN alanlar — gizlenmez, ayrı bölümde GÖRÜNÜR. */
  digerleri: DetayAlani[];
}

export const BOS_DEGER = "—";

/** Anahtar karşılaştırması: küçük harf + ayraçlar atılır (`safahat_no` = `safahatNo`). */
export function anahtarNormal(anahtar: string): string {
  return anahtar.toLowerCase().replace(/[\s_\-.]/g, "");
}

/**
 * GÖRÜLMÜŞ alan adlarının Türkçe karşılığı. Tek eşleme noktası burasıdır.
 * Kaynaklar: sahte portal fixture'ları, `src/uyap/schema.ts` ve `taraf.ts`
 * içindeki alan adı listeleri, 5–12 Eylül canlı gözlem notları.
 * BU BİR ŞEMA DEĞİLDİR: eksik olan alan düşmez, `digerleri`ne gider.
 */
export const ALAN_TABLOSU: Record<string, AlanBilgisi> = {
  // ── safahat ──────────────────────────────────────────────────────
  safahattarihistr: { baslik: "Tarih", tur: "tarih" },
  safahattarihi: { baslik: "Tarih", tur: "tarih" },
  safahatturuaciklama: { baslik: "İşlem" },
  safahatturu: { baslik: "İşlem kodu" },
  safahatstatukodaciklama: { baslik: "Durum" },
  safahatstatukod: { baslik: "Durum kodu" },
  safahatno: { baslik: "Safahat no" },
  safahatid: { baslik: "Safahat kimliği" },
  islemturuaciklama: { baslik: "İşlem türü" },
  islemsonucuaciklama: { baslik: "İşlem sonucu" },
  islemtarihi: { baslik: "İşlem tarihi", tur: "tarih" },
  islemyapanbirim: { baslik: "İşlemi yapan birim" },
  aciklama: { baslik: "Açıklama" },
  ekaciklama: { baslik: "Ek açıklama" },
  // ── ortak ────────────────────────────────────────────────────────
  tarih: { baslik: "Tarih", tur: "tarih" },
  tarihstr: { baslik: "Tarih", tur: "tarih" },
  tarihsaat: { baslik: "Tarih ve saat", tur: "tarih" },
  kayittarihi: { baslik: "Kayıt tarihi", tur: "tarih" },
  guncellemetarihi: { baslik: "Güncelleme tarihi", tur: "tarih" },
  birimadi: { baslik: "Birim" },
  birimid: { baslik: "Birim kimliği" },
  yerelbirimad: { baslik: "Birim" },
  dosyano: { baslik: "Dosya no" },
  esasno: { baslik: "Esas no" },
  dosyaid: { baslik: "Dosya kimliği" },
  dosyaturkodaciklama: { baslik: "Dosya türü" },
  dosyaturkod: { baslik: "Dosya türü kodu" },
  dosyaturu: { baslik: "Dosya türü" },
  dosyadurum: { baslik: "Dosya durumu" },
  durum: { baslik: "Durum" },
  durumaciklama: { baslik: "Durum" },
  gonderen: { baslik: "Gönderen" },
  sirano: { baslik: "Sıra no" },
  kayitid: { baslik: "Kayıt kimliği" },
  // ── taraf ────────────────────────────────────────────────────────
  adi: { baslik: "Adı" },
  ad: { baslik: "Adı" },
  isim: { baslik: "Adı" },
  adsoyad: { baslik: "Adı soyadı" },
  adisoyadi: { baslik: "Adı soyadı" },
  kisikurumadi: { baslik: "Kişi/kurum adı" },
  tarafadi: { baslik: "Taraf adı" },
  unvan: { baslik: "Unvan" },
  soyad: { baslik: "Soyadı" },
  soyadi: { baslik: "Soyadı" },
  rol: { baslik: "Rolü" },
  roladi: { baslik: "Rolü" },
  rolaciklama: { baslik: "Rolü" },
  sifat: { baslik: "Sıfatı" },
  sifataciklama: { baslik: "Sıfatı" },
  tarafrolu: { baslik: "Taraf rolü" },
  tarafsifati: { baslik: "Taraf sıfatı" },
  vekil: { baslik: "Vekili" },
  vekiladi: { baslik: "Vekili" },
  vekiladsoyad: { baslik: "Vekili" },
  isvekil: { baslik: "Vekil mi" },
  adres: { baslik: "Adres" },
  babaadi: { baslik: "Baba adı" },
  anaadi: { baslik: "Ana adı" },
  dogumtarihi: { baslik: "Doğum tarihi", tur: "tarih" },
  // ── hesap ────────────────────────────────────────────────────────
  alacak: { baslik: "Alacak", tur: "para" },
  borc: { baslik: "Borç", tur: "para" },
  odendi: { baslik: "Ödenen", tur: "para" },
  odenen: { baslik: "Ödenen", tur: "para" },
  bakiye: { baslik: "Bakiye", tur: "para" },
  tutar: { baslik: "Tutar", tur: "para" },
  anapara: { baslik: "Ana para", tur: "para" },
  faiz: { baslik: "Faiz", tur: "para" },
  faizorani: { baslik: "Faiz oranı" },
  masraf: { baslik: "Masraf", tur: "para" },
  harc: { baslik: "Harç", tur: "para" },
  vekaletucreti: { baslik: "Vekâlet ücreti", tur: "para" },
  toplam: { baslik: "Toplam", tur: "para" },
  parabirimi: { baslik: "Para birimi" },
};

/**
 * Tabloda olmayan anahtarın OKUNUR adı: `islemSonucuAciklama` → "Islem Sonucu
 * Aciklama". Türkçe imlâ UYDURULMAZ (portal ASCII yazıyorsa ASCII kalır); amaç
 * yalnız ham anahtarın ekrana düşmemesidir. Bu ad hiçbir zaman ham anahtarın
 * kendisi olmaz: her kelimenin ilk harfi büyütülür, kalanı küçültülür.
 *
 * BÜYÜK/KÜÇÜK HARF DÖNÜŞÜMÜ LOCALE'SİZDİR. `tr-TR` kuralı ASCII "I"yı "ı"ya,
 * "i"yi "İ"ye çevirir; portalın ASCII yazdığı `MUHASEBE_FIS_NO` böylece
 * "Muhasebe Fıs No" olurdu — olmayan bir imlâ uydurmak. Locale'siz dönüşüm
 * "Muhasebe Fis No" verir: eksik ama uydurma değil.
 */
export function insanaOkunur(anahtar: string): string {
  const kelimeler = String(anahtar)
    .replace(/[_\-.]+/g, " ")
    // camelCase / PascalCase / ardışık büyük harf (STRTarih) sınırları
    .replace(/([a-zçğıöşü0-9])([A-ZÇĞİÖŞÜ])/g, "$1 $2")
    .replace(/([A-ZÇĞİÖŞÜ]+)([A-ZÇĞİÖŞÜ][a-zçğıöşü])/g, "$1 $2")
    .split(/\s+/)
    .filter((k) => k !== "");
  if (kelimeler.length === 0) return "(adsız alan)";
  return kelimeler
    .map((k) => k.slice(0, 1).toUpperCase() + k.slice(1).toLowerCase())
    .join(" ");
}

/**
 * Bir alanın başlığı ve biçim ipucu. Tabloda yoksa `taninan: false`.
 *
 * ARAMA PROTOTİP ZİNCİRİNE İNMEZ. Düz `ALAN_TABLOSU[k]` yazımı, portal
 * `constructor` / `toString` / `hasOwnProperty` adlı bir alan gönderdiğinde
 * `Object.prototype` üyesini bulup DOĞRU sanıyordu: alan "tanınan" sayılıyor,
 * `baslik` taşımadığı için ekrana BOŞ ETİKETLE, değeriyle birlikte düşüyordu.
 * Ölçüldü (bağımsız kontrol, test/w-detay.test.ts D2). Veri kaybı değil ama
 * avukat etiketsiz bir değere bakıyor — ve "tanınmayan alan" bölümüne de
 * girmediği için tanınmadığını bilmiyor.
 */
export function alanBilgisi(anahtar: string): AlanBilgisi & { taninan: boolean } {
  const k = anahtarNormal(anahtar);
  if (Object.hasOwn(ALAN_TABLOSU, k)) {
    const bilinen = ALAN_TABLOSU[k];
    if (bilinen) return { ...bilinen, taninan: true };
  }
  return { baslik: insanaOkunur(anahtar), taninan: false };
}

interface Zaman {
  yil: number;
  ay: number;
  gun: number;
  saat: number | null;
  dakika: number | null;
}

const iki = (n: number) => String(n).padStart(2, "0");

/**
 * TANINAN tarih kalıpları → bileşenler; tanınmayan değer için `null`.
 * Kabul edilenler: `dd.MM.yyyy`, `dd/MM/yyyy`, `yyyy-MM-dd`; her biri isteğe
 * bağlı `HH:mm(:ss)` ile. Ay/gün aralığı DOĞRULANIR — "32.13.2026" tarih
 * sayılmaz ve olduğu gibi gösterilir.
 */
export function zamanCoz(deger: string): Zaman | null {
  const s = deger.trim();
  const m =
    /^(\d{2})[./](\d{2})[./](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?$/.exec(s) ??
    null;
  const iso =
    m === null
      ? /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?$/.exec(s)
      : null;
  let yil: number, ay: number, gun: number, saat: string | undefined, dakika: string | undefined;
  if (m) {
    gun = Number(m[1]);
    ay = Number(m[2]);
    yil = Number(m[3]);
    saat = m[4];
    dakika = m[5];
  } else if (iso) {
    yil = Number(iso[1]);
    ay = Number(iso[2]);
    gun = Number(iso[3]);
    saat = iso[4];
    dakika = iso[5];
  } else {
    return null;
  }
  if (yil < 1900 || yil > 2999) return null;
  if (ay < 1 || ay > 12) return null;
  if (gun < 1 || gun > new Date(Date.UTC(yil, ay, 0)).getUTCDate()) return null;
  const s2 = saat === undefined ? null : Number(saat);
  const d2 = dakika === undefined ? null : Number(dakika);
  if (s2 !== null && (s2 > 23 || d2 === null || d2 > 59)) return null;
  return { yil, ay, gun, saat: s2, dakika: d2 };
}

/** `zamanCoz` çıktısı → "08.09.2026" ya da "08.09.2026 11:40". */
export function zamanYaz(z: Zaman): string {
  const gun = `${iki(z.gun)}.${iki(z.ay)}.${z.yil}`;
  return z.saat === null || z.dakika === null
    ? gun
    : `${gun} ${iki(z.saat)}:${iki(z.dakika)}`;
}

/** Sıralanabilir damga: "20260908 1140". Karşılaştırma dize üzerinden yapılır. */
export function zamanAnahtari(z: Zaman): string {
  return `${z.yil}${iki(z.ay)}${iki(z.gun)}${iki(z.saat ?? 0)}${iki(z.dakika ?? 0)}`;
}

/**
 * Para: yalnız SAYI geldiğinde binlik ayraçla yazılır ("10000.5" → "10.000,50").
 * Portal zaten "10.000,00" gibi biçimli DİZE gönderiyorsa dokunulmaz.
 * PARA BİRİMİ EKLENMEZ: portal hangi birim olduğunu söylemiyor.
 */
export function paraYaz(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const eksi = n < 0 ? "-" : "";
  const [tam = "0", kesir = "00"] = Math.abs(n).toFixed(2).split(".");
  const ayrac = tam.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${eksi}${ayrac},${kesir}`;
}

/** İç içe yapıda en fazla bu kadar aşağı inilir; portal verisi bu kadar derin değil. */
const DERINLIK_TAVANI = 8;

/**
 * Değeri okunur bir yapıya çevirir. JSON.stringify KULLANILMAZ: nesne alan
 * listesine, dizi öge listesine açılır.
 */
export function degerCevir(
  deger: unknown,
  tur?: AlanBilgisi["tur"],
  derinlik = 0,
): DetayDeger {
  if (deger === null || deger === undefined) return { tur: "metin", metin: BOS_DEGER };
  if (typeof deger === "boolean")
    return { tur: "metin", metin: deger ? "Evet" : "Hayır" };
  if (typeof deger === "number")
    return { tur: "metin", metin: tur === "para" ? paraYaz(deger) : String(deger) };
  if (typeof deger === "string") {
    const s = deger.trim();
    if (s === "") return { tur: "metin", metin: BOS_DEGER };
    const z = tur === "tarih" ? zamanCoz(s) : null;
    return { tur: "metin", metin: z ? zamanYaz(z) : s };
  }
  if (Array.isArray(deger)) {
    if (deger.length === 0) return { tur: "metin", metin: BOS_DEGER };
    if (derinlik >= DERINLIK_TAVANI)
      return { tur: "metin", metin: `${deger.length} kayıt (gösterilemeyecek kadar iç içe)` };
    return { tur: "liste", ogeler: deger.map((o) => degerCevir(o, tur, derinlik + 1)) };
  }
  if (typeof deger === "object") {
    const kayit = deger as Record<string, unknown>;
    const anahtarlar = Object.keys(kayit);
    if (anahtarlar.length === 0) return { tur: "metin", metin: BOS_DEGER };
    if (derinlik >= DERINLIK_TAVANI)
      return { tur: "metin", metin: `${anahtarlar.length} alan (gösterilemeyecek kadar iç içe)` };
    return {
      tur: "alanlar",
      alanlar: anahtarlar.map((a) => {
        const bilgi = alanBilgisi(a);
        return { baslik: bilgi.baslik, deger: degerCevir(kayit[a], bilgi.tur, derinlik + 1) };
      }),
    };
  }
  // bigint / symbol / function — portalden gelmez ama sessizce düşmesin
  return { tur: "metin", metin: String(deger) };
}

/** Tek portal satırı → ekran kaydı. Hiçbir alan atılmaz. */
export function kaydaCevir(satir: DetaySatiri): DetayKaydi {
  const alanlar: DetayAlani[] = [];
  const digerleri: DetayAlani[] = [];
  for (const anahtar of Object.keys(satir)) {
    const bilgi = alanBilgisi(anahtar);
    const alan: DetayAlani = {
      baslik: bilgi.baslik,
      deger: degerCevir(satir[anahtar], bilgi.tur),
    };
    (bilgi.taninan ? alanlar : digerleri).push(alan);
  }
  return { alanlar, digerleri };
}

/** Portal satırları → ekran kayıtları. */
export function gorunumUret(satirlar: readonly DetaySatiri[]): DetayKaydi[] {
  return satirlar.map((s) => kaydaCevir(s));
}

/** Satırdaki İLK çözülebilir tarih alanının sıralama damgası; yoksa null. */
export function satirZamani(satir: DetaySatiri): string | null {
  for (const anahtar of Object.keys(satir)) {
    const bilgi = alanBilgisi(anahtar);
    if (bilgi.tur !== "tarih") continue;
    const ham = satir[anahtar];
    if (typeof ham !== "string") continue;
    const z = zamanCoz(ham);
    if (z) return zamanAnahtari(z);
  }
  return null;
}

/**
 * Safahat KRONOLOJİK sıraya (eskiden yeniye) alınır. Satırların HEPSİNDE
 * çözülebilir bir tarih yoksa PORTAL SIRASI KORUNUR ve bu ekranda yazılır —
 * yarısı tarihli bir listeyi sıralamak, portalın kendi sırasını sessizce
 * bozar ve avukat neye baktığını bilemez.
 */
export function safahatSirala(satirlar: readonly DetaySatiri[]): {
  satirlar: DetaySatiri[];
  sira: "tarih" | "portal";
} {
  const damgali = satirlar.map((s, i) => ({ s, i, z: satirZamani(s) }));
  if (damgali.length === 0 || damgali.some((d) => d.z === null))
    return { satirlar: [...satirlar], sira: "portal" };
  damgali.sort((a, b) => (a.z! < b.z! ? -1 : a.z! > b.z! ? 1 : a.i - b.i));
  return { satirlar: damgali.map((d) => d.s), sira: "tarih" };
}
