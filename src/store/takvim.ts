// Ajanda satırlarını iCalendar (.ics) metnine çevirir — P07a.
//
// ÇALIŞMA ZAMANI NPM BAĞIMLILIĞI YOKTUR ve eklenmeyecek: .ics düz metindir
// (RFC 5545). Bu modül DOSYA SİSTEMİNE DOKUNMAZ ve PORTALA GİTMEZ; yazma,
// açma ve kalıcı durum dosyası `src/server/takvim.ts`tedir. Girdi, ekranda
// zaten duran duruşma satırlarıdır: aktarma tek bir portal isteği doğurmaz.
//
// ── SAAT DİLİMİ (ölçülmüş karar) ───────────────────────────────────────
// Portalın `tarihSaat`i "2026-09-09 11:40:00.0" biçimindedir ve SAAT DİLİMİ
// İŞARETİ TAŞIMAZ; duruşma Türkiye yerel saatiyledir. Bu modül tarihi hiçbir
// yerde `new Date(metin)` ile ayrıştırmaz ve UTC'ye ÇEVİRMEZ: duvar saati
// olduğu gibi `DTSTART;TZID=Europe/Istanbul:20260909T114000` yazılır. Bu
// yüzden kullanıcı yurt dışında bir makinede de, sistem saat dilimi ne
// olursa olsun, duruşmayı 11:40'ta görür.
//
// VTIMEZONE bu makinede ÖLÇÜLDÜ (13 Eyl 2026, Node/tzdata ile 2015–2028
// arası saat saat tarandı): Europe/Istanbul'un SON geçişi 2016-03-27 01:00
// UTC'dir (+0200 → +0300, yerel 03:00); o andan itibaren taranan her saatte
// ofset sabit +03:00'tür. Dosyadaki VTIMEZONE bu yüzden tek bir STANDARD
// gözlemi taşır ve yaz saati kuralı İÇERMEZ. Ölçüm eskirse (Türkiye yaz
// saatine dönerse) burası da güncellenmeli — ama etkinlik saatleri yine
// kaymaz, çünkü yazılan şey duvar saatidir.
//
// ── UID (en kritik karar) ──────────────────────────────────────────────
// `dosyaId` OTURUMA BAĞLIDIR (README §8, P18/P19/P20'de ölçüldü: portalın
// hiçbir kimliği istekler arasında yaşamıyor) — takvim kimliğinde
// KULLANILAMAZ. `kayitId`in oturumlar arası kalıcılığı ÖLÇÜLMEDİ (canlı
// oturum gerektiriyor, bu turda oturum kapalıydı) ve ölçülmemiş bir alan
// kalıcı kimliğe temel yapılamaz. Bu yüzden UID KALICI ALANLARDAN türetilir:
//   uyap-<birimId ya da mahkeme adı>-<esas>-t<islemTuru>-<YYYYMMDD>
// Opak token ve müvekkil adı GEÇMEZ.
//
// Tarih neden UID'nin İÇİNDE? Çünkü tarihsiz taban tek başına aynı dosyanın
// aynı türdeki İKİ ayrı duruşmasını (pencerede ikisi de olabilir) tek UID'ye
// indirger ve takvimde biri sessizce diğerinin üzerine yazar — bu üründe en
// kötü sonuç budur. Tarihli UID'nin bedeli, ertelemenin tek başına yeni bir
// kimlik doğurmasıdır; onu `TakvimDurum` çözer: aktarılan her etkinliğin
// (uid, taban, dtstart, sequence) kaydı tutulur, saati değişen duruşma ESKİ
// UID'yi devralır ve SEQUENCE artar → takvimdeki etkinlik GÜNCELLENİR.
// Durum dosyası kaybolursa yalnız erteleme takibi kaybolur; aynı duruşmayı
// iki kez aktarmak yine TEK etkinlik verir, çünkü UID kayıttan türetilmiştir.
//
// ── ERTELEME YALNIZ GELECEK KAYIT İÇİN ─────────────────────────────────
// UID devralması ancak defterdeki eski kayıt HÂLÂ İLERİDEYSE yapılır. Sebebi
// ölçülmüştür: duruşma sorgusu her zaman BUGÜNDEN ileri bakar
// (`src/uyap/durusma.ts`), yani bir dosyanın BİR SONRAKİ celsesi ekranda
// göründüğünde defterdeki önceki celse ÇOKTAN GEÇMİŞTEDİR. Koşulsuz devralma,
// normal celse akışının neredeyse tamamını "erteleme" sanıp duruşmanın
// YAPILDIĞI günün kaydını avukatın takviminden siler. Geçmiş kayıt yerinde
// bırakılır, yeni celse YENİ etkinlik olur ve kullanıcı bilgilendirilir.

export const TZID = "Europe/Istanbul";
export const VARSAYILAN_SURE_DK = 30;
export const URUN_KIMLIGI = "-//Tensip//Ajanda//TR";
// Önceki adın (UYAP Asistan) alanı bilerek korunur: UID değişirse takvime
// önceden aktarılmış duruşmalar ikinci kez eklenir.
export const UID_ALANI = "@uyap-asistan.local";
/** Kalıcı durumda tutulacak en fazla etkinlik ve geçmiş penceresi. */
export const DURUM_TAVANI = 2000;
export const DURUM_GUN_PENCERESI = 180;

export interface TakvimTarafi {
  isim?: string;
  soyad?: string;
  sifat?: string;
  isVekil?: boolean;
}

/** Ekrandaki duruşma satırının aktarmaya giren alanları. */
export interface TakvimKaydi {
  tarihSaat?: string;
  dosyaNo?: string;
  yerelBirimAd?: string;
  birimId?: string;
  islemTuru?: number;
  islemTuruAciklama?: string;
  islemSonucuAciklama?: string;
  dosyaTurKodAciklama?: string;
  dosyaTaraflari?: TakvimTarafi[];
}

/** Saat dilimi taşımayan duvar saati; UTC'ye çevrilmez. */
export interface DuvarSaati {
  yil: number;
  ay: number;
  gun: number;
  saat: number;
  dakika: number;
}

export interface TakvimDurumKaydi {
  uid: string;
  taban: string;
  /** "20260909T114000" — duvar saati; karşılaştırma metin üzerinden. */
  dtstart: string;
  sequence: number;
  at: string;
}

export interface TakvimDurum {
  surum: 1;
  etkinlikler: TakvimDurumKaydi[];
}

export interface UretilenEtkinlik {
  uid: string;
  taban: string;
  dtstart: string;
  sequence: number;
  baslik: string;
  yeni: boolean;
  ertelendi: boolean;
  oncekiDtstart?: string;
}

export interface AtlananSatir {
  indeks: number;
  etiket: string;
  sebep: string;
}

export interface TakvimSecenek {
  simdi: Date;
  /** GİZLİLİK: varsayılan KAPALI. Bkz. `tarafNotu`. */
  taraflariEkle?: boolean;
  sureDk?: number;
  durum?: TakvimDurum | null;
  takvimAdi?: string;
}

export interface TakvimSonuc {
  ics: string;
  durum: TakvimDurum;
  etkinlikler: UretilenEtkinlik[];
  atlananlar: AtlananSatir[];
  uyarilar: string[];
  /** Aynı duruşmanın (aynı taban + aynı saat) tekrar eden satır sayısı. */
  yinelenen: number;
  sureDk: number;
  taraflariEkle: boolean;
}

/* ── tarih/saat ────────────────────────────────────────────────────────── */

function ayGunSayisi(yil: number, ay: number): number {
  return new Date(Date.UTC(yil, ay, 0)).getUTCDate();
}

/**
 * "2026-09-09 11:40:00.0" → duvar saati. TARİH UYDURULMAZ: okunamayan,
 * eksik ya da geçersiz bir değer `null` döner ve satır aktarılmaz.
 */
export function tarihSaatCoz(deger: string | undefined | null): DuvarSaati | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(
    String(deger ?? "").trim(),
  );
  if (!m) return null;
  const yil = Number(m[1]),
    ay = Number(m[2]),
    gun = Number(m[3]),
    saat = Number(m[4]),
    dakika = Number(m[5]);
  if (yil < 1970 || yil > 2999) return null;
  if (ay < 1 || ay > 12) return null;
  if (gun < 1 || gun > ayGunSayisi(yil, ay)) return null;
  if (saat > 23 || dakika > 59) return null;
  return { yil, ay, gun, saat, dakika };
}

/**
 * Duvar saatine dakika ekler. Aritmetik UTC bileşenleriyle yapılır ki
 * çalıştıran makinenin saat dilimi (ve onun yaz saati kuralları) hesaba
 * KARIŞMASIN; sonuç yine duvar saatidir.
 */
export function duvarEkle(an: DuvarSaati, dakika: number): DuvarSaati {
  const d = new Date(
    Date.UTC(an.yil, an.ay - 1, an.gun, an.saat, an.dakika) + dakika * 60_000,
  );
  return {
    yil: d.getUTCFullYear(),
    ay: d.getUTCMonth() + 1,
    gun: d.getUTCDate(),
    saat: d.getUTCHours(),
    dakika: d.getUTCMinutes(),
  };
}

const iki = (n: number) => String(n).padStart(2, "0");

/** "20260909T114000" — saat dilimi işareti YOK (TZID parametresi taşır). */
export function duvarMetni(an: DuvarSaati): string {
  return `${an.yil}${iki(an.ay)}${iki(an.gun)}T${iki(an.saat)}${iki(an.dakika)}00`;
}

export function gunMetni(an: DuvarSaati): string {
  return `${an.yil}${iki(an.ay)}${iki(an.gun)}`;
}

/**
 * `simdi` mutlak anını TÜRKİYE DUVAR saatine çevirir. Erteleme eşiği budur:
 * defterdeki kayıt bu damganın İLERİSİNDEyse duruşma henüz yapılmamıştır ve
 * saati değişmiş olabilir; GERİSİNDEyse duruşma OLMUŞTUR ve o günün kaydı
 * takvimde kalmalıdır.
 *
 * Dönüşüm tzdata'ya sorulur (bu modüldeki tek yer; etkinlik saatleri hâlâ
 * hiçbir yerde çevrilmez). ICU'suz bir çalıştırmada modülün ÖLÇÜLMÜŞ sabitine
 * (+03, bkz. VTIMEZONE notu) düşülür. Sapmanın YÖNÜ önemlidir: eşik geriye
 * kayarsa geçmiş kayıt "ileride" sanılır ve etkinlik taşınır — yedek ofset bu
 * yüzden ileri yöndedir.
 */
export function simdiDuvar(simdi: Date): DuvarSaati {
  try {
    const parcalar = new Intl.DateTimeFormat("en-US", {
      timeZone: TZID,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(simdi);
    const al = (tur: string) =>
      Number(parcalar.find((p) => p.type === tur)?.value);
    const an: DuvarSaati = {
      yil: al("year"),
      ay: al("month"),
      gun: al("day"),
      saat: al("hour") % 24,
      dakika: al("minute"),
    };
    if (Object.values(an).every((v) => Number.isFinite(v))) return an;
  } catch {
    /* ICU yok — aşağıdaki ölçülmüş sabite düşülür */
  }
  return duvarEkle(
    {
      yil: simdi.getUTCFullYear(),
      ay: simdi.getUTCMonth() + 1,
      gun: simdi.getUTCDate(),
      saat: simdi.getUTCHours(),
      dakika: simdi.getUTCMinutes(),
    },
    180,
  );
}

/** DTSTAMP mutlak bir andır; tek UTC kullanan alan burasıdır. */
export function utcDamga(d: Date): string {
  return (
    `${d.getUTCFullYear()}${iki(d.getUTCMonth() + 1)}${iki(d.getUTCDate())}` +
    `T${iki(d.getUTCHours())}${iki(d.getUTCMinutes())}${iki(d.getUTCSeconds())}Z`
  );
}

/* ── metin kaçırma ve satır katlama ────────────────────────────────────── */

/** RFC 5545 TEXT kaçırması: `\` `;` `,` ve yeni satır. Sıra önemlidir. */
export function icsKacir(deger: unknown): string {
  return String(deger ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n")
    // Kalan kontrol baytları (NUL dâhil) dosyayı bozar; düşürülür.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

/**
 * 75 OKTETTE katlama. Sınır karakter değil BAYT'tır; Türkçe harfler iki bayt
 * olduğu için bölme UTF-8 sürek baytının ortasına düşmemelidir — düşerse
 * takvimde "ĠstanbulÂ" gibi bozuk metin çıkar. Devam satırları tek boşlukla
 * başlar ve boşluk da 75'e dâhildir.
 */
export function icsKatla(satir: string): string[] {
  const bayt = Buffer.from(satir, "utf8");
  if (bayt.length <= 75) return [satir];
  const parcalar: string[] = [];
  let bas = 0;
  let sinir = 75;
  while (bas < bayt.length) {
    let son = Math.min(bas + sinir, bayt.length);
    while (son > bas + 1 && son < bayt.length && (bayt[son]! & 0xc0) === 0x80)
      son--;
    parcalar.push(bayt.subarray(bas, son).toString("utf8"));
    bas = son;
    sinir = 74; // devam satırının ilk okteti boşluk
  }
  return parcalar;
}

function katlanmisSatirlar(satirlar: string[]): string[] {
  const cikti: string[] = [];
  for (const s of satirlar) {
    const p = icsKatla(s);
    cikti.push(p[0]!);
    for (const devam of p.slice(1)) cikti.push(` ${devam}`);
  }
  return cikti;
}

/* ── kimlik ────────────────────────────────────────────────────────────── */

const TR_HARF: Record<string, string> = {
  ı: "i",
  İ: "i",
  ş: "s",
  Ş: "s",
  ğ: "g",
  Ğ: "g",
  ü: "u",
  Ü: "u",
  ö: "o",
  Ö: "o",
  ç: "c",
  Ç: "c",
  I: "i",
};

/** UID parçası: ASCII'ye indirger, `[a-z0-9-]` dışını tireye çevirir. */
export function kimlikSadelestir(deger: string, uzunluk = 48): string {
  const ascii = String(deger ?? "").replace(/[ıİşŞğĞüÜöÖçÇI]/g, (c) => TR_HARF[c] ?? c);
  return ascii
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, uzunluk)
    .replace(/-+$/g, "");
}

/**
 * UID tabanı: KALICI alanlardan (birimId + esas + işlem türü). Ne opak
 * portal tokenı ne müvekkil adı taşır. Kimlik kurulamıyorsa `null`.
 */
export function uidTabani(k: TakvimKaydi): string | null {
  const birimId = kimlikSadelestir(String(k.birimId ?? ""), 24);
  const birim = birimId || kimlikSadelestir(String(k.yerelBirimAd ?? ""), 40);
  const esas = kimlikSadelestir(String(k.dosyaNo ?? ""), 24);
  if (!birim && !esas) return null;
  const tur = Number.isFinite(Number(k.islemTuru)) ? String(Number(k.islemTuru)) : "x";
  return `uyap-${birim || "birimsiz"}-${esas || "esassiz"}-t${tur}`;
}

/* ── görünen metinler ──────────────────────────────────────────────────── */

/** "Mahkeme · Esas · İşlem türü" — taraf adı YOK, başlık zaten tanıtıyor. */
export function etkinlikBasligi(k: TakvimKaydi): string {
  const parcalar = [k.yerelBirimAd, k.dosyaNo, k.islemTuruAciklama]
    .map((p) => String(p ?? "").trim())
    .filter((p) => p.length > 0);
  return parcalar.length ? parcalar.join(" · ") : "UYAP duruşması";
}

/** Uyarı/atlama satırlarında kullanılan kısa etiket; taraf adı taşımaz. */
export function satirEtiketi(k: TakvimKaydi): string {
  const p = [k.yerelBirimAd, k.dosyaNo]
    .map((x) => String(x ?? "").trim())
    .filter((x) => x.length > 0);
  return p.length ? p.join(" ") : "(mahkeme/esas bilinmiyor)";
}

export const TARAF_NOTU =
  "Taraf adları gizlilik gereği yazılmadı: Takvim iCloud'a eşitlenebilir.";

function taraflarMetni(k: TakvimKaydi): string {
  const hepsi = Array.isArray(k.dosyaTaraflari) ? k.dosyaTaraflari : [];
  const gosterilen = hepsi.slice(0, 10).map((t) => {
    const ad = [t.isim, t.soyad]
      .map((x) => String(x ?? "").trim())
      .filter((x) => x.length > 0)
      .join(" ");
    const sifat = String(t.sifat ?? "").trim();
    return `${sifat ? `${sifat} ` : ""}${ad}${t.isVekil ? " (vekil)" : ""}`.trim();
  });
  const kalan = hepsi.length - gosterilen.length;
  const metin = gosterilen.filter((x) => x.length > 0).join(", ");
  if (!metin) return "";
  return kalan > 0 ? `${metin} ve ${kalan} kişi daha` : metin;
}

function aciklamaMetni(
  k: TakvimKaydi,
  sec: { taraflariEkle: boolean; sureDk: number },
): string {
  const satir: string[] = [];
  const ekle = (etiket: string, deger: unknown) => {
    const v = String(deger ?? "").trim();
    if (v) satir.push(`${etiket}: ${v}`);
  };
  ekle("Dosya", k.dosyaNo);
  ekle("Mahkeme", k.yerelBirimAd);
  ekle("İşlem", k.islemTuruAciklama);
  ekle("Portal durumu", k.islemSonucuAciklama);
  ekle("Dosya türü", k.dosyaTurKodAciklama);
  satir.push(
    `Bitiş saatini UYAP vermiyor; süre ${sec.sureDk} dakika varsayıldı.`,
  );
  if (sec.taraflariEkle) {
    const t = taraflarMetni(k);
    if (t) satir.push(`Taraflar: ${t}`);
  } else {
    satir.push(TARAF_NOTU);
  }
  satir.push("Tensip tarafından oluşturuldu.");
  return satir.join("\n");
}

/* ── VTIMEZONE ─────────────────────────────────────────────────────────── */

export const VTIMEZONE_SATIRLARI = [
  "BEGIN:VTIMEZONE",
  `TZID:${TZID}`,
  "X-LIC-LOCATION:Europe/Istanbul",
  "BEGIN:STANDARD",
  // Ölçülen son geçiş: 2016-03-27 01:00 UTC (yerel 03:00), +0200 → +0300.
  // O tarihten bu yana tek gözlem geçerlidir; yaz saati kuralı yoktur.
  "DTSTART:20160327T030000",
  "TZOFFSETFROM:+0200",
  "TZOFFSETTO:+0300",
  "TZNAME:+03",
  "END:STANDARD",
  "END:VTIMEZONE",
];

/* ── üretim ────────────────────────────────────────────────────────────── */

interface Aday {
  indeks: number;
  kayit: TakvimKaydi;
  an: DuvarSaati;
  taban: string;
  dtstart: string;
}

function yeniUidUret(
  aday: Aday,
  alinan: Set<string>,
): string {
  const taban = `${aday.taban}-${gunMetni(aday.an)}`;
  let uid = `${taban}${UID_ALANI}`;
  let sira = 2;
  while (alinan.has(uid)) uid = `${taban}-${sira++}${UID_ALANI}`;
  return uid;
}

/** Eski kayıtları budar: geçmiş penceresi ve tavan. */
export function durumBuda(
  kayitlar: TakvimDurumKaydi[],
  simdi: Date,
): TakvimDurumKaydi[] {
  const sinir = duvarMetni({
    yil: simdi.getUTCFullYear(),
    ay: simdi.getUTCMonth() + 1,
    gun: simdi.getUTCDate(),
    saat: 0,
    dakika: 0,
  });
  const esik = duvarMetni(
    duvarEkle(
      {
        yil: Number(sinir.slice(0, 4)),
        ay: Number(sinir.slice(4, 6)),
        gun: Number(sinir.slice(6, 8)),
        saat: 0,
        dakika: 0,
      },
      -DURUM_GUN_PENCERESI * 24 * 60,
    ),
  );
  const kalan = kayitlar.filter((e) => e.dtstart >= esik);
  if (kalan.length <= DURUM_TAVANI) return kalan;
  return [...kalan]
    .sort((a, b) => b.dtstart.localeCompare(a.dtstart))
    .slice(0, DURUM_TAVANI);
}

/**
 * Ekrandaki satırlardan .ics üretir ve etkinlik kimliği durumunu günceller.
 * PORTALA GİTMEZ, DİSKE DOKUNMAZ.
 */
export function takvimUret(
  kayitlar: TakvimKaydi[],
  sec: TakvimSecenek,
): TakvimSonuc {
  const sureDk = Math.min(600, Math.max(5, Math.round(sec.sureDk ?? VARSAYILAN_SURE_DK)));
  const taraflariEkle = sec.taraflariEkle === true;
  const uyarilar: string[] = [];
  const atlananlar: AtlananSatir[] = [];
  const adaylar: Aday[] = [];

  kayitlar.forEach((kayit, indeks) => {
    const etiket = satirEtiketi(kayit);
    const an = tarihSaatCoz(kayit.tarihSaat);
    if (!an) {
      atlananlar.push({
        indeks,
        etiket,
        sebep:
          "Tarih/saat okunamadı. Takvime uydurma tarih yazılmaz; bu kayıt aktarılmadı.",
      });
      return;
    }
    const taban = uidTabani(kayit);
    if (!taban) {
      atlananlar.push({
        indeks,
        etiket,
        sebep:
          "Mahkeme ve esas numarası boş; kalıcı etkinlik kimliği üretilemedi.",
      });
      return;
    }
    adaylar.push({ indeks, kayit, an, taban, dtstart: duvarMetni(an) });
  });

  adaylar.sort(
    (a, b) => a.dtstart.localeCompare(b.dtstart) || a.indeks - b.indeks,
  );

  // Aynı duruşma iki kez geldiyse (aynı taban + aynı saat) tek etkinlik olur.
  const gorulen = new Set<string>();
  let yinelenen = 0;
  const tekil = adaylar.filter((a) => {
    const anahtar = `${a.taban}|${a.dtstart}`;
    if (gorulen.has(anahtar)) {
      yinelenen++;
      return false;
    }
    gorulen.add(anahtar);
    return true;
  });

  const durum: TakvimDurum = {
    surum: 1,
    etkinlikler: (sec.durum?.etkinlikler ?? []).map((e) => ({ ...e })),
  };
  const alinanUid = new Set(durum.etkinlikler.map((e) => e.uid));
  const kullanilan = new Set<string>();
  const karar = new Map<
    number,
    { uid: string; sequence: number; yeni: boolean; ertelendi: boolean; oncekiDtstart?: string }
  >();

  // 1. geçiş — BİREBİR: taban ve saat aynıysa aynı etkinliktir. Aynı duruşmayı
  // ikinci kez aktarmak SEQUENCE'ı bile artırmaz; takvimde ikinci kopya olmaz.
  for (const a of tekil) {
    const eslesen = durum.etkinlikler.find(
      (e) => !kullanilan.has(e.uid) && e.taban === a.taban && e.dtstart === a.dtstart,
    );
    if (!eslesen) continue;
    kullanilan.add(eslesen.uid);
    karar.set(a.indeks, {
      uid: eslesen.uid,
      sequence: eslesen.sequence,
      yeni: false,
      ertelendi: false,
    });
  }

  // 2. geçiş — ERTELEME. Devralma İKİ koşulu birden ister:
  //
  //  (a) Eski kayıt HÂLÂ İLERİDE olmalı. Geçmişte kalan kayıt ertelenmiş
  //      değil, YAPILMIŞ duruşmadır; onu yeni celsenin tarihine taşımak
  //      duruşmanın olduğu günü takvimden siler (bkz. dosya başındaki not).
  //  (b) İlerideki kayıt TEK olmalı. Birden çoksa hangisinin ertelendiği
  //      ÖLÇÜLEMEZ: tahmin edip mevcut bir etkinliği başka saate taşımak
  //      yerine yeni etkinlik yazılır ve kullanıcı uyarılır (yanlış kaydı
  //      oynatmak, fazladan kayıt göstermekten kötüdür).
  //
  // Aynı gün içinde ertelenen duruşmanın (sabah açıldı, öğleden sonraya
  // bırakıldı, aktarma arada yapıldı) bu kuralla FAZLADAN bir etkinlik
  // doğurması bilinçli tercihtir: fazladan kayıt görünür ve düzeltilebilir,
  // silinen kayıt görünmez.
  const simdiDamga = duvarMetni(simdiDuvar(sec.simdi));
  const gecmisUyarisi = new Set<string>();
  for (const a of tekil) {
    if (karar.has(a.indeks)) continue;
    const ayniTaban = durum.etkinlikler.filter(
      (e) => !kullanilan.has(e.uid) && e.taban === a.taban,
    );
    const eskiler = ayniTaban.filter((e) => e.dtstart >= simdiDamga);
    const gecmisAdet = ayniTaban.length - eskiler.length;
    if (eskiler.length === 1) {
      const e = eskiler[0]!;
      kullanilan.add(e.uid);
      karar.set(a.indeks, {
        uid: e.uid,
        sequence: e.sequence + 1,
        yeni: false,
        ertelendi: true,
        oncekiDtstart: e.dtstart,
      });
      continue;
    }
    if (eskiler.length > 1) {
      uyarilar.push(
        `${satirEtiketi(a.kayit)}: bu dosyada aynı türde birden çok kayıt aktarılmış; hangisinin ertelendiği ölçülemiyor. Yeni bir etkinlik yazıldı, eskisi takviminizde duruyor — kontrol edin.`,
      );
    } else if (gecmisAdet > 0 && !gecmisUyarisi.has(a.taban)) {
      gecmisUyarisi.add(a.taban);
      uyarilar.push(
        `${satirEtiketi(a.kayit)}: bu dosyada daha önce aktarılmış, tarihi geçmiş bir duruşma var; o etkinlik takviminizde olduğu gibi duruyor. Bu celse YENİ bir etkinlik olarak yazıldı.`,
      );
    }
    const uid = yeniUidUret(a, new Set([...alinanUid, ...kullanilan]));
    alinanUid.add(uid);
    kullanilan.add(uid);
    karar.set(a.indeks, { uid, sequence: 0, yeni: true, ertelendi: false });
  }

  // Aynı dosyanın aynı türdeki iki AYRI duruşması aynı pencerede olabilir;
  // ikisi de ayrı etkinlik olur (birleşmezler) ama kullanıcı bilsin.
  const tabanSayaci = new Map<string, number>();
  for (const a of tekil)
    tabanSayaci.set(a.taban, (tabanSayaci.get(a.taban) ?? 0) + 1);
  for (const [taban, adet] of tabanSayaci) {
    if (adet < 2) continue;
    const ornek = tekil.find((a) => a.taban === taban)!;
    uyarilar.push(
      `${satirEtiketi(ornek.kayit)}: aynı dosyada aynı türde ${adet} kayıt var; ayrı etkinlikler olarak yazıldı.`,
    );
  }

  const dtstamp = utcDamga(sec.simdi);
  const at = sec.simdi.toISOString();
  const etkinlikler: UretilenEtkinlik[] = [];
  const govde: string[] = [];

  for (const a of tekil) {
    const k = karar.get(a.indeks)!;
    const baslik = etkinlikBasligi(a.kayit);
    const bitis = duvarEkle(a.an, sureDk);
    govde.push(
      "BEGIN:VEVENT",
      `UID:${icsKacir(k.uid)}`,
      `DTSTAMP:${dtstamp}`,
      `SEQUENCE:${k.sequence}`,
      `DTSTART;TZID=${TZID}:${a.dtstart}`,
      `DTEND;TZID=${TZID}:${duvarMetni(bitis)}`,
      `SUMMARY:${icsKacir(baslik)}`,
    );
    const yer = String(a.kayit.yerelBirimAd ?? "").trim();
    if (yer) govde.push(`LOCATION:${icsKacir(yer)}`);
    govde.push(
      `DESCRIPTION:${icsKacir(aciklamaMetni(a.kayit, { taraflariEkle, sureDk }))}`,
      "CATEGORIES:UYAP",
      "TRANSP:OPAQUE",
      "END:VEVENT",
    );
    etkinlikler.push({
      uid: k.uid,
      taban: a.taban,
      dtstart: a.dtstart,
      sequence: k.sequence,
      baslik,
      yeni: k.yeni,
      ertelendi: k.ertelendi,
      oncekiDtstart: k.oncekiDtstart,
    });
    const mevcut = durum.etkinlikler.find((e) => e.uid === k.uid);
    if (mevcut) {
      mevcut.taban = a.taban;
      mevcut.dtstart = a.dtstart;
      mevcut.sequence = k.sequence;
      mevcut.at = at;
    } else {
      durum.etkinlikler.push({
        uid: k.uid,
        taban: a.taban,
        dtstart: a.dtstart,
        sequence: k.sequence,
        at,
      });
    }
  }

  durum.etkinlikler = durumBuda(durum.etkinlikler, sec.simdi);

  // METHOD BİLEREK YOK: `METHOD:PUBLISH` RFC 5546'ya göre ORGANIZER ister,
  // ORGANIZER da dosyaya bir e-posta adresi koymak demektir. İçe aktarma
  // penceresi METHOD olmadan da açılır.
  const satirlar = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${icsKacir(URUN_KIMLIGI)}`,
    "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${icsKacir(sec.takvimAdi ?? "UYAP Ajanda")}`,
    ...VTIMEZONE_SATIRLARI,
    ...govde,
    "END:VCALENDAR",
  ];

  return {
    ics: `${katlanmisSatirlar(satirlar).join("\r\n")}\r\n`,
    durum,
    etkinlikler,
    atlananlar,
    uyarilar,
    yinelenen,
    sureDk,
    taraflariEkle,
  };
}
