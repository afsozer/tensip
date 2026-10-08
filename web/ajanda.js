// Ajanda ekranı — P07a. İki iş yapar:
//   1. Duruşmaları GÜNE GÖRE gruplar (Bugün / Yarın / tarih başlıkları), her
//      grup saat sırasıyla. Tarih okunamıyorsa UYDURULMAZ: satır "Tarihi
//      belirsiz" grubunda kalır ve takvime aktarılmaz.
//   2. "Takvime aktar" — .ics dosyası yazdırır ve macOS'ta açtırır; Takvim
//      kendi içe aktarma penceresini açar, hangi takvime ekleneceğini
//      KULLANICI seçer. Uygulama takvime doğrudan yazmaz, EventKit izni
//      istemez. Dosyayı üreten motor src/store/takvim.ts'tedir.
//
// SORGU YALNIZ KULLANICI EYLEMİYLE OLUR. Sekmeye girmek yeni bir portal
// sorgusu başlatmaz; eldeki sonuç `state.ajanda`da durur ve sorgu zamanıyla
// birlikte gösterilir. 5 sn'lik `poll` turuna hiçbir şey eklenmedi (P18a
// düğme disiplini). Aktarma da portala GİTMEZ: ekrandaki satırlardan üretilir.
//
// ARŞİV BAĞLANTISI BELİRSİZSE ÇIKMAZ. Eşleme mahkeme (birimId ya da ad) +
// esas numarası iledir; iki aday varsa düğme çizilmez, sebebi yazılır. Yanlış
// davayı açmak bu üründeki en kötü hatadır (ROADMAP §5 madde 3).
import {
  $,
  escape,
  state,
  api,
  empty,
  errorHTML,
  isOnline,
  action,
} from "./ortak.js";
import { refreshArchive, selectCase } from "./arsiv.js";

const AYLAR = [
  "Ocak",
  "Şubat",
  "Mart",
  "Nisan",
  "Mayıs",
  "Haziran",
  "Temmuz",
  "Ağustos",
  "Eylül",
  "Ekim",
  "Kasım",
  "Aralık",
];
const HAFTA = [
  "Pazar",
  "Pazartesi",
  "Salı",
  "Çarşamba",
  "Perşembe",
  "Cuma",
  "Cumartesi",
];
const iki = (n) => String(n).padStart(2, "0");

/**
 * "2026-09-09 11:40:00.0" → {gun:"2026-09-09", saat:"11:40"}. Okunamayan ya da
 * geçersiz değer `null` döner — tarih UYDURULMAZ. Kural motordaki
 * `tarihSaatCoz` ile birebir aynıdır (test/p07a.test.ts ikisini aynı tabloyla
 * karşılaştırır): ekranda tarihli görünüp aktarmada atlanan satır olmasın.
 */
export function tarihCoz(tarihSaat) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(
    String(tarihSaat ?? "").trim(),
  );
  if (!m) return null;
  const yil = Number(m[1]),
    ay = Number(m[2]),
    gun = Number(m[3]),
    saat = Number(m[4]),
    dakika = Number(m[5]);
  if (yil < 1970 || yil > 2999) return null;
  if (ay < 1 || ay > 12) return null;
  if (gun < 1 || gun > new Date(Date.UTC(yil, ay, 0)).getUTCDate()) return null;
  if (saat > 23 || dakika > 59) return null;
  return { gun: `${yil}-${iki(ay)}-${iki(gun)}`, saat: `${iki(saat)}:${iki(dakika)}` };
}

/** Yerel gün damgası; "Bugün/Yarın" kararının tek kaynağı. */
export function bugunISO(simdi = new Date()) {
  return `${simdi.getFullYear()}-${iki(simdi.getMonth() + 1)}-${iki(simdi.getDate())}`;
}

export function gunEkle(gunISO, adet) {
  const [y, a, g] = String(gunISO).split("-").map(Number);
  const d = new Date(Date.UTC(y, a - 1, g) + adet * 86_400_000);
  return `${d.getUTCFullYear()}-${iki(d.getUTCMonth() + 1)}-${iki(d.getUTCDate())}`;
}

/** "Bugün" · "Yarın" · "9 Eylül 2026 Çarşamba" (Intl'e bağlı değil). */
export function gunEtiketi(gunISO, bugun) {
  if (gunISO === bugun) return "Bugün";
  if (gunISO === gunEkle(bugun, 1)) return "Yarın";
  const [y, a, g] = String(gunISO).split("-").map(Number);
  const d = new Date(Date.UTC(y, a - 1, g));
  return `${g} ${AYLAR[a - 1]} ${y} ${HAFTA[d.getUTCDay()]}`;
}

/**
 * Güne göre gruplar; her grup saat sırasıyla. Tarihi çözülemeyen satırlar
 * SONDA ayrı grupta toplanır. `indeks` ham listedeki sırayı taşır: aktarma
 * düğmeleri satırı bununla bulur.
 */
export function gunGruplari(durusmalar, bugun) {
  const gunler = new Map();
  const tarihsiz = [];
  (durusmalar || []).forEach((d, indeks) => {
    const an = tarihCoz(d?.tarihSaat);
    if (!an) {
      tarihsiz.push({ indeks, kayit: d, an: null });
      return;
    }
    if (!gunler.has(an.gun)) gunler.set(an.gun, []);
    gunler.get(an.gun).push({ indeks, kayit: d, an });
  });
  const gruplar = [...gunler.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([gun, satirlar]) => ({
      gun,
      baslik: gunEtiketi(gun, bugun),
      satirlar: satirlar.sort(
        (x, y) => x.an.saat.localeCompare(y.an.saat) || x.indeks - y.indeks,
      ),
    }));
  if (tarihsiz.length)
    gruplar.push({ gun: null, baslik: "Tarihi belirsiz", satirlar: tarihsiz });
  return gruplar;
}

/**
 * Ekranın üstündeki zaman satırı. TIKLAMA ANINI DEĞİL, VERİNİN ÖLÇÜLDÜĞÜ ANI
 * yazar: `durusmalar` ucu daemon'da 10 dk'lık önbelleğin arkasındadır
 * (src/server/daemon.ts), yani düğmeye basmak portala gidildiği anlamına
 * gelmez. Yanıttaki `olcumAt`/`onbellekten` bunu söyler; eski bir daemon bu
 * alanları göndermezse tıklama anına düşülür ve önbellek iddiası KURULMAZ.
 */
export function sorguZamaniMetni(a, simdi = new Date()) {
  const damga = a?.olcumAt || a?.sorguAt;
  if (!damga) return "Henüz sorgulanmadı.";
  const t = Date.parse(damga);
  if (!Number.isFinite(t)) return "Henüz sorgulanmadı.";
  const saat = new Date(t).toLocaleString("tr-TR", {
    dateStyle: "short",
    timeStyle: "short",
  });
  const dk = Math.max(0, Math.floor((simdi.getTime() - t) / 60_000));
  const yas = dk < 1 ? "az önce" : `${dk} dk önce`;
  const kaynak = !a?.olcumAt
    ? ""
    : a?.onbellekten
      ? ` · önbellekten, ${yas} ölçüldü`
      : ` · portaldan ${yas} alındı`;
  return `Veri ${saat} ölçümü${kaynak} · ${a?.gun} günlük aralık`;
}

export function esasNormal(deger) {
  return String(deger ?? "").replace(/\s+/g, "");
}

export function birimNormal(ad) {
  return String(ad ?? "")
    .toLocaleLowerCase("tr")
    .replace(/[^0-9a-zçğıöşü]+/g, " ")
    .trim();
}

/**
 * Ajanda satırının arşivdeki karşılığı. BELİRSİZSE BAĞLANTI ÇIKMAZ:
 *   {durum:"tek", kayit} · {durum:"belirsiz", adet} · {durum:"yok"}
 * Eşleşme esas numarası + (birimId ya da mahkeme adı) iledir; yalnız
 * indirilmiş (klonYolu olan) davalar adaydır.
 */
export function davaEsle(durusma, davalar) {
  const esas = esasNormal(durusma?.dosyaNo);
  if (!esas) return { durum: "yok" };
  const birimId = String(durusma?.birimId ?? "").trim();
  const ad = birimNormal(durusma?.yerelBirimAd);
  const adaylar = (davalar || []).filter((k) => {
    if (!k?.klonYolu) return false;
    if (esasNormal(k.dosyaNo) !== esas) return false;
    const kimlikTutar = !!birimId && String(k.birimId ?? "").trim() === birimId;
    const adTutar = !!ad && birimNormal(k.birimAdi) === ad;
    return kimlikTutar || adTutar;
  });
  if (adaylar.length === 1) return { durum: "tek", kayit: adaylar[0] };
  if (adaylar.length > 1) return { durum: "belirsiz", adet: adaylar.length };
  return { durum: "yok" };
}

function satirHTML(satir, davalar) {
  const d = satir.kayit || {};
  const eslesme = davaEsle(d, davalar);
  const saat = satir.an
    ? `<span class="ajanda-saat">${escape(satir.an.saat)}</span>`
    : `<span class="ajanda-saat subtle">saat yok</span>`;
  const tur = d.islemTuruAciklama
    ? `<span class="tag">${escape(d.islemTuruAciklama)}</span>`
    : "";
  const altSatir = [d.dosyaNo, d.dosyaTurKodAciklama]
    .filter((x) => String(x ?? "").trim())
    .map((x) => escape(x))
    .join(" · ");
  const sonuc = d.islemSonucuAciklama
    ? `<p class="subtle">${escape(d.islemSonucuAciklama)}</p>`
    : "";
  const arsiv =
    eslesme.durum === "tek"
      // caseKey AYIRACI GERÇEK NUL'dur (README §6). HTML ayrıştırıcısı
      // öznitelikteki U+0000'ı U+FFFD'ye çevirir; ham geçirilirse düğme
      // "klonlanmamış dava" der (ELLE UI KONTROLÜNDE ölçüldü). Arşiv
      // ekranıyla aynı taşıma: encodeURIComponent → decodeURIComponent.
      ? `<button class="quiet" id="ajanda-dava-${satir.indeks}" data-ajanda-dava="${encodeURIComponent(eslesme.kayit.caseKey)}">Arşivde aç</button>`
      : eslesme.durum === "belirsiz"
        ? `<span class="subtle ajanda-belirsiz">Arşivde ${escape(String(eslesme.adet))} eşleşme var; hangisi olduğu belirsiz olduğu için bağlantı verilmedi.</span>`
        : "";
  const aktar = satir.an
    ? `<button id="ajanda-ics-${satir.indeks}" data-ajanda-ics="${satir.indeks}">Takvime aktar</button>`
    : `<span class="subtle">Tarihi okunamadığı için takvime aktarılamaz.</span>`;
  return `<article class="job ajanda-satir"><div class="row spread wrap">${saat}<div class="ajanda-govde"><strong class="job-title">${escape(d.yerelBirimAd || "Mahkeme bilinmiyor")}</strong> ${tur}<p class="subtle">${altSatir || "—"}</p>${sonuc}</div><span class="row wrap ajanda-eylem">${arsiv}${aktar}</span></div></article>`;
}

/** Sorgu sonucunun tamamı: gün grupları + satırlar. Saf üretici. */
export function ajandaHTML(durusmalar, sec = {}) {
  const bugun = sec.bugun || bugunISO();
  const davalar = sec.davalar || [];
  const gruplar = gunGruplari(durusmalar, bugun);
  if (!gruplar.length)
    return empty(
      "Bu aralıkta kayıt bulunamadı",
      "Seçtiğiniz tarih aralığında duruşma ya da keşif görünmüyor.",
    );
  return gruplar
    .map(
      (g) =>
        `<section class="ajanda-grup"><h3>${escape(g.baslik)} <span class="subtle">${g.satirlar.length}</span></h3>${g.satirlar.map((s) => satirHTML(s, davalar)).join("")}</section>`,
    )
    .join("");
}

/** Aktarma sonucunun kullanıcıya söylediği şey. Saf üretici. */
export function aktarmaOzetiHTML(sonuc) {
  if (!sonuc) return "";
  const adet = Number(sonuc.adet || 0);
  const guncellenen = Number(sonuc.guncellenen || 0);
  // "yenisi eklenmedi" ancak GERÇEKTEN yeni etkinlik yokken yazılabilir:
  // karışık aktarmada (bir erteleme + iki yeni celse) o cümle olanın tersini
  // söylüyordu.
  const yeni = Math.max(0, adet - guncellenen);
  const kirilim = guncellenen
    ? ` (${guncellenen} etkinlik ertelendi sayılıp güncellendi${yeni ? `, ${yeni} yeni etkinlik eklendi` : ", yeni etkinlik eklenmedi"})`
    : "";
  const parcalar = [
    `${adet} duruşma Takvim’e gönderildi${kirilim}.`,
    sonuc.acildi
      ? "Takvim’in içe aktarma penceresinde hangi takvime ekleyeceğinizi siz seçersiniz."
      : `Dosya yazıldı ama açılamadı${sonuc.acmaHatasi ? `: ${sonuc.acmaHatasi}` : ""}. Dosyayı kendiniz açabilirsiniz.`,
    `Dosya: ${sonuc.kisaYol || sonuc.dosyaAdi || "—"}`,
  ];
  const atlanan = (sonuc.atlananlar || []).length
    ? `<ul class="batch-results">${sonuc.atlananlar.map((a) => `<li>${escape(a.etiket)} — ${escape(a.sebep)}</li>`).join("")}</ul>`
    : "";
  const uyari = (sonuc.uyarilar || []).length
    ? `<ul class="batch-results">${sonuc.uyarilar.map((u) => `<li>${escape(u)}</li>`).join("")}</ul>`
    : "";
  return `<div class="notice" role="status">${parcalar.map((p) => `<p>${escape(p)}</p>`).join("")}${uyari}${atlanan}</div>`;
}

/** Sunucuya giden satır. Taraf adları YALNIZ kullanıcı açıkça istediyse. */
export function aktarmaKaydi(d, taraflariEkle) {
  const kayit = {
    tarihSaat: d?.tarihSaat,
    dosyaNo: d?.dosyaNo,
    yerelBirimAd: d?.yerelBirimAd,
    birimId: d?.birimId,
    islemTuru: d?.islemTuru,
    islemTuruAciklama: d?.islemTuruAciklama,
    islemSonucuAciklama: d?.islemSonucuAciklama,
    dosyaTurKodAciklama: d?.dosyaTurKodAciklama,
  };
  // GİZLİLİK: seçenek kapalıyken taraf adı isteğe HİÇ konmaz. Motor da ayrıca
  // yazmaz (çift kapı); burası veriyi yola bile çıkarmaz.
  if (taraflariEkle && Array.isArray(d?.dosyaTaraflari))
    kayit.dosyaTaraflari = d.dosyaTaraflari;
  return kayit;
}

async function davalariYukle() {
  // Yalnız YEREL registry okur (portala sıfır istek). Arşiv ekranı açılmadan
  // Ajanda'ya girildiğinde de satırdan davaya gidebilmek için gerekir.
  if (state.cases.length) return;
  try {
    const veri = await api("davalar");
    state.cases = veri.davalar || [];
  } catch {
    /* bağlantı yoksa yalnız arşiv bağlantısı çıkmaz; ajanda çalışmaya devam */
  }
}

export function renderCalendar() {
  const pageId = state.nesil;
  // Ekranın hafızası ortak durumdadır (web/ortak.js `state.ajanda`): sekme
  // değişince sonuç kaybolmaz ve yeni sorgu doğmaz.
  const a = state.ajanda;
  const gecerli = () => state.page === "ajanda" && pageId === state.nesil;
  $("#page").innerHTML =
    `<div class="notice" data-online ${isOnline() ? "hidden" : ""}>Ajandayı sorgulamak için UYAP’a giriş yapın. Son sorgunun sonucu oturum kapalıyken de ekranda kalır.</div>` +
    `<section class="panel"><div class="panel-title"><h2>Duruşma takvimi</h2><p class="subtle">Seçtiğiniz tarih aralığındaki kayıtlar sorgulanır; sorgu yalnız bu düğmeyle yapılır.</p></div>` +
    `<form id="calendar-form" class="row wrap"><label style="min-width:220px">Tarih aralığı<select name="gun"><option value="1">Bugün</option><option value="7">Önümüzdeki 7 gün</option><option value="14">Önümüzdeki 14 gün</option><option value="31">Önümüzdeki 31 gün</option></select></label><button type="submit" class="primary" style="align-self:end">Ajandayı sorgula</button></form>` +
    `<div class="row spread wrap ajanda-araclar"><span class="row wrap"><button id="ajanda-ics-tumu" class="primary">Görünenleri takvime aktar</button><label class="row ajanda-taraf"><input type="checkbox" id="ajanda-taraflar" style="width:auto;margin:0" ${a.taraflariEkle ? "checked" : ""}> Taraf adlarını da yaz</label></span><span class="subtle" id="ajanda-sorgu-at"></span></div>` +
    `<p class="subtle">Etkinlikler <strong>30 dakika</strong> yazılır: UYAP bitiş saati vermiyor. Takvim dosyası arşivinize karışmaz, ayrı bir dışa aktarma konumuna yazılır.</p>` +
    `<p class="subtle">Taraf adları <strong>varsayılan olarak yazılmaz</strong>: Mac Takvim iCloud’a eşitlenir ve müvekkil adı cihazın dışına çıkar. Başlık “Mahkeme · Esas · İşlem türü” ile zaten tanınır.</p>` +
    `<div id="ajanda-aktarma"></div></section>` +
    `<section class="panel" id="calendar-results"></section>`;

  const ciz = () => {
    if (!gecerli()) return;
    const sorgu = $("#ajanda-sorgu-at");
    if (sorgu) sorgu.textContent = sorguZamaniMetni(a);
    const aktarmaKutu = $("#ajanda-aktarma");
    if (aktarmaKutu)
      aktarmaKutu.innerHTML = a.aktarmaHata
        ? errorHTML({ message: a.aktarmaHata })
        : aktarmaOzetiHTML(a.aktarma);
    const kutu = $("#calendar-results");
    if (!kutu) return;
    if (a.hata) kutu.innerHTML = errorHTML({ message: a.hata });
    else if (a.durusmalar === null)
      kutu.innerHTML = empty(
        "Takviminizi görüntüleyin",
        "Duruşmalarınızı görmek için bir tarih aralığı seçip sorgulayın.",
      );
    else
      kutu.innerHTML = ajandaHTML(a.durusmalar, {
        bugun: bugunISO(),
        davalar: state.cases,
      });
    const aktarilabilir = (a.durusmalar || []).some((d) => tarihCoz(d?.tarihSaat));
    $("#ajanda-ics-tumu").disabled = !aktarilabilir;
    $("#ajanda-ics-tumu").title = aktarilabilir
      ? ""
      : "Aktarılacak, tarihi okunabilen kayıt yok.";
    baglantilariKur();
  };

  const aktar = (dugme, kayitlar) =>
    action(dugme, async () => {
      try {
        const sonuc = await api("takvime-aktar", {
          durusmalar: kayitlar.map((d) => aktarmaKaydi(d, a.taraflariEkle)),
          taraflariEkle: a.taraflariEkle,
        });
        a.aktarma = sonuc;
        a.aktarmaHata = null;
      } catch (error) {
        a.aktarma = null;
        a.aktarmaHata = error.message;
      }
      ciz();
    });

  function baglantilariKur() {
    document.querySelectorAll("[data-ajanda-ics]").forEach((b) => {
      b.onclick = () => {
        const kayit = (a.durusmalar || [])[Number(b.dataset.ajandaIcs)];
        if (kayit) aktar(b, [kayit]);
      };
    });
    document.querySelectorAll("[data-ajanda-dava]").forEach((b) => {
      b.onclick = () =>
        action(b, async () => {
          const key = decodeURIComponent(b.dataset.ajandaDava);
          // Gezinme uygulamanın kendi menü düğmesiyle yapılır: modüller arası
          // döngüsel içe aktarma kurulmaz.
          $('[data-page="indirilenler"]')?.click();
          await refreshArchive();
          if (state.page !== "indirilenler") return;
          await selectCase(key);
        });
    });
  }

  $("#ajanda-taraflar").onchange = (event) => {
    a.taraflariEkle = event.currentTarget.checked;
  };
  $("#ajanda-ics-tumu").onclick = (event) => {
    const kayitlar = (a.durusmalar || []).filter((d) => tarihCoz(d?.tarihSaat));
    if (kayitlar.length) aktar(event.currentTarget, kayitlar);
  };
  $("#calendar-form select[name=gun]").value = String(a.gun);
  $("#calendar-form").onsubmit = (event) => {
    event.preventDefault();
    const form = event.currentTarget,
      gun = Number(new FormData(form).get("gun"));
    action($("button", form), async () => {
      a.gun = gun;
      $("#calendar-results").innerHTML = empty("Ajanda sorgulanıyor…", "", true);
      try {
        const veri = await api("durusmalar", { gun });
        if (!gecerli()) return;
        a.durusmalar = veri.durusmalar || [];
        a.sorguAt = new Date().toISOString();
        // Veri kaç dakikalık? Tıklama anı bunu SÖYLEMEZ (10 dk önbellek).
        a.olcumAt = typeof veri.olcumAt === "string" ? veri.olcumAt : null;
        a.onbellekten = veri.onbellekten === true;
        a.hata = null;
      } catch (error) {
        if (!gecerli()) return;
        a.hata = error.message;
        a.durusmalar = null;
      }
      ciz();
    });
  };
  ciz();
  void davalariYukle().then(() => {
    if (gecerli() && a.durusmalar) ciz();
  });
}
