// Taraf gösterim sözlüğü (P18). DOM'a, fetch'e veya uygulama durumuna bağlı
// değil: girdi taraf kaydı dizisi ({adi, rol, vekil}), çıktı {rol, metin}
// çiftleri. Üretilen metin HTML DEĞİLDİR; kaçırma çağıran satır şablonunda
// yapılır (web/evrak-durum.js ile aynı kural).
//
// SABİT ROL EŞLEME TABLOSU YOKTUR. Gerekçe src/uyap/taraf.ts başındadır ve
// burada tekrarlanmaz: rol adı portaldan gelir; "icra → alacaklı/borçlu,
// hukuk → davacı/davalı" biçiminde bir tablo ceza ve çocuk dosyalarında
// yanlış olur (ölçüldü: "Katılan", "Suça Sürüklenen Çocuk").
//
// VEKİL LİSTE SATIRINDA GÖSTERİLMEZ: kayıtta durur, satırı şişirmez; tam
// liste zaten "Taraflar" sekmesindedir.

/** Rolü aynı olan tarafları ilk görülme sırasıyla gruplar; adları tekilleştirir. */
export function taraflariGrupla(taraflar) {
  const sira = [];
  const gruplar = new Map();
  // DİZİ DEĞİLSE BOŞ SAY. `davalarim.json` elle düzenlenip `taraflar` bir
  // nesneye ya da sayıya dönerse `for...of` fırlatır; bu işlev arşiv
  // listesinin map'i içinden çağrıldığı için tek bozuk kayıt LİSTENİN
  // TAMAMINI çizilmez yapardı. Bir dosyanın taraf satırını kaybetmek,
  // İndirilenler ekranını komple kaybetmekten iyidir.
  for (const t of Array.isArray(taraflar) ? taraflar : []) {
    const adi = String(t?.adi ?? "").trim();
    if (!adi) continue;
    const rol = String(t?.rol ?? "").trim();
    if (!gruplar.has(rol)) {
      gruplar.set(rol, []);
      sira.push(rol);
    }
    const adlar = gruplar.get(rol);
    if (!adlar.includes(adi)) adlar.push(adi);
  }
  return sira.map((rol) => ({ rol, adlar: gruplar.get(rol) }));
}

/**
 * Satıra sığacak özet. Aynı rolden çok taraf varsa ilk `adTavani` ad + "+k";
 * çok rol varsa ilk `rolTavani` grup + `fazlaRol`. Tam liste "Taraflar"
 * sekmesinde durduğu için burada kısaltmak bilgi kaybı sayılmaz.
 */
export function tarafOzeti(taraflar, { adTavani = 2, rolTavani = 3 } = {}) {
  const tumu = taraflariGrupla(taraflar);
  const kesilmis = tumu.slice(0, Math.max(1, rolTavani));
  return {
    gruplar: kesilmis.map(({ rol, adlar }) => ({
      rol,
      metin:
        adlar.slice(0, Math.max(1, adTavani)).join(", ") +
        (adlar.length > adTavani ? ` +${adlar.length - adTavani}` : ""),
      fazla: Math.max(0, adlar.length - adTavani),
    })),
    fazlaRol: Math.max(0, tumu.length - kesilmis.length),
    rolSayisi: tumu.length,
  };
}

/** Düz metin özeti: "Alacaklı: X · Borçlu: Y, Z +1". Taraf yoksa boş dize. */
export function tarafOzetMetni(taraflar, sec) {
  const ozet = tarafOzeti(taraflar, sec);
  if (!ozet.gruplar.length) return "";
  const parcalar = ozet.gruplar.map((g) => (g.rol ? `${g.rol}: ${g.metin}` : g.metin));
  if (ozet.fazlaRol) parcalar.push(`+${ozet.fazlaRol} rol`);
  return parcalar.join(" · ");
}

/**
 * Özetin HTML'i. `esc` çağırandan gelir (bu modül ortak.js'i import etmez,
 * saf kalır). Rol etiketi ile adlar ayrı sarmalanır ki uzun adlar satırı
 * bozmasın; kaçırma her parçaya ayrı ayrı uygulanır.
 */
export function tarafOzetiHTML(taraflar, esc, sec) {
  const ozet = tarafOzeti(taraflar, sec);
  if (!ozet.gruplar.length) return "";
  const parcalar = ozet.gruplar.map((g) =>
    g.rol
      ? `<span class="taraf-grup"><span class="taraf-rol">${esc(g.rol)}:</span> ${esc(g.metin)}</span>`
      : `<span class="taraf-grup">${esc(g.metin)}</span>`,
  );
  if (ozet.fazlaRol)
    parcalar.push(`<span class="taraf-grup">+${esc(String(ozet.fazlaRol))} rol</span>`);
  return parcalar.join('<span class="taraf-ayrac"> · </span>');
}

// ── P18a — portal liste satırının taraf belleği ──────────────────────────────
// Bellek istemcide, `state.portal.taraflar` içinde yaşar: Map<dosyaId, kayit>.
// Kayıt {durum, taraflar?, mesaj?} biçimindedir ve DİSKE YAZILMAZ — portal
// liste sonuçları zaten kalıcı değildir (geliştirme rehberi §8).
// Bellek liste yenilenince ve oturum sürümü değişince düşer.
export const TARAF_DURUMLARI = ["bosta", "yukleniyor", "geldi", "hata"];

export function tarafKaydiDurumu(kayit) {
  const d = kayit?.durum;
  return TARAF_DURUMLARI.includes(d) ? d : "bosta";
}

/**
 * Tıklama portala istek DOĞURMALI MI?
 *
 * "geldi" → HAYIR: aynı satıra ikinci tıklama yeni sorgu atmaz (kabul ölçütü).
 * "yukleniyor" → HAYIR: çift tıklama iki istek doğurmaz.
 * "hata" → EVET, ama bu bilinçli bir ikinci tıklamadır: düğmenin yazısı
 *   "Yeniden dene" olur. Tek geçici hatadan sonra kullanıcıyı 29 dosyalık
 *   listeyi baştan çekmeye (29+ portal isteği) zorlamak daha kötü olurdu.
 */
export function tarafSorgusuGerekli(kayit) {
  const d = tarafKaydiDurumu(kayit);
  return d === "bosta" || d === "hata";
}

// ── P18a — oturum kapısı ─────────────────────────────────────────────────────
// ELLE UI KONTROLÜNDE YAKALANAN KUSUR (P18 incelemesi, 12 Eylül): kapı yalnız
// ÇİZİM ANINDA hesaplanıyordu ve tek yönlüydü. Sayfa açılır açılmaz listelenen
// dosyaların düğmeleri, ilk `durum` yanıtı henüz dönmediği için "oturum ister"
// diye KAPALI doğuyor ve oturum aktif olduğu hâlde bir daha AÇILMIYORDU
// (ölçüldü: 12 sn sonra bile kapalı, başlıkta "UYAP oturumu açık" yazarken).
// Aynı mandal, oturum SÜRÜMÜ hiç değişmeden geçici bir `kontrol_ediliyor`
// turunda da kapanmaya yol açıyordu.
//
// Çözüm: kapı artık SÜRÜM ÖLÇER, durum tahmin etmez. Üç sonucu vardır:
//   ""        → açık; listedeki kimlikler CANLI oturuma ait.
//   geçici    → oturum durumu henüz bilinmiyor ya da doğrulanıyor. Sürüm
//               değişmediği için kimlikler geçerli; durum netleşince AÇILIR.
//   kalıcı    → sürüm değişti (çıkış/yeniden giriş) ya da liste damgasız.
//               Yeniden giriş yapılsa bile AÇILMAZ: eski kimlikler başka bir
//               dosyayı gösterebilir. Sunucu da aynı kapıyı uygular
//               (daemon.ts `liste-taraflar`), bu yalnız onun ekrandaki yüzü.
export const TARAF_ENGEL = {
  bilinmiyor: "UYAP oturum durumu henüz alınmadı; birazdan açılır.",
  dogrulaniyor: "UYAP oturumu doğrulanıyor; birazdan açılır.",
  kapali: "UYAP oturumu kapalı; giriş yapıp dosya listesini yenileyin.",
  damgasiz: "Bu liste oturum sürümü olmadan alındı; listeyi yenileyin.",
  degisti: "Oturum değişti; dosya listesini yenileyin.",
};

/**
 * Saf kapı. `oturum` = `durum` RPC'sinin `oturum` alanı ({durum, surum}) ya da
 * henüz yoklanmadıysa null/undefined. `listeSurumu` = listeyi getiren yanıtın
 * taşıdığı oturum sürümü (yoksa null). Dönen dize boşsa düğme AÇIK.
 */
export function tarafOturumEngeli(oturum, listeSurumu) {
  if (!oturum) return TARAF_ENGEL.bilinmiyor;
  if (oturum.durum === "kontrol_ediliyor") return TARAF_ENGEL.dogrulaniyor;
  if (oturum.durum !== "aktif") return TARAF_ENGEL.kapali;
  if (!Number.isInteger(listeSurumu)) return TARAF_ENGEL.damgasiz;
  // Sürüm karşılaştırması kapının ÇEKİRDEĞİDİR: oturum yeniden açılmış olsa
  // bile eski listeyle taraf sorulamaz.
  if (listeSurumu !== oturum.surum) return TARAF_ENGEL.degisti;
  return "";
}

/** Düğmenin dört durumu: boşta / yükleniyor / geldi / hata. `engel` doluysa kapalı. */
export function tarafDugmesi(kayit, { engel = "" } = {}) {
  const durum = tarafKaydiDurumu(kayit);
  if (durum === "yukleniyor")
    return { durum, etiket: "Getiriliyor…", kapali: true, baslik: "Taraf bilgisi UYAP’tan alınıyor." };
  if (durum === "geldi")
    return {
      durum,
      etiket: "Taraflar geldi",
      kapali: true,
      baslik: "Bu dosyanın tarafları bu oturumda alındı; yeniden sorulmaz.",
    };
  if (durum === "hata")
    return {
      durum,
      etiket: "Yeniden dene",
      kapali: Boolean(engel),
      baslik: engel || kayit?.mesaj || "Taraf bilgisi alınamadı.",
    };
  return {
    durum,
    etiket: "Tarafları getir",
    kapali: Boolean(engel),
    baslik: engel || "Yalnız bu dosya için UYAP’a tek sorgu gönderir.",
  };
}
