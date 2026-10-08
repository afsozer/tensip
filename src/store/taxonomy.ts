// Evrak taksonomisi: UYAP evraklarını Gelen/Giden/Dosya × kategori klasörlerine
// ayırır. Sınıflandırma kuralları gerçek UYAP evrak türlerinden çıkarıldı;
// yeni türler için genişletilebilir.
//
// YÖN MODELİ — UYAP'ın mahkeme perspektifi:
//   • GLN (gelen): mahkemeye gelen evrak (taraf/avukat dilekçeleri) → Gelen
//   • GDN (giden): mahkeme tarafından çıkarılan evrak (tebligat, müzekkere,
//     makbuz) → Giden
//   • Mahkemenin kendi dosya belgeleri (karar, tutanak, zapt, sorgu, sayman)
//     → Dosya
//   • Bilinmiyorsa: gönderen ipucu; o da yoksa Dosya (nötr).

export type Yon = "Gelen" | "Giden" | "Dosya";

export interface Kategori {
  yon: Yon;
  klasor: string;
}

export interface KlasifiKasyonGirdi {
  tur: string;
  gonderen: string;
  /** UYAP tip kodu: GLN (gelen) / GDN (giden) — bilinmiyorsa boş */
  tip?: string;
  isEkEvrak?: boolean;
}

// Türkçe karakterleri sadeleştirip karşılaştırma için normalleştirme
function norm(metin: string): string {
  return metin
    .toLocaleLowerCase("tr-TR")
    .replace(/[ıİ]/g, "i")
    .replace(/[ğĞ]/g, "g")
    .replace(/[şŞ]/g, "s")
    .replace(/[çÇ]/g, "c")
    .replace(/[öÖ]/g, "o")
    .replace(/[üÜ]/g, "u")
    .replace(/\s+/g, " ")
    .trim();
}

// Sıra 01..11 taksonomisi
const KURALLAR: { desenler: string[]; klasor: string }[] = [
  // 01 — kararlar, tutanaklar, kıyarlar
  { desenler: ["karar", "hükm", "hukm", "tutanak", "kıyar", "kiyar"], klasor: "01-Kararlar-Tutanaklar" },
  // 02 — dilekçeler (dava, cevap, itiraz, delil...)
  { desenler: ["dilekçe", "dilekce", "başvuru", "basvuru", "şikayet", "sikayet"], klasor: "02-Dilekceler" },
  // 03 — tebligatlar
  { desenler: ["tebligat", "teblig"], klasor: "03-Tebligatlar" },
  // 04 — müzekkereler, yazışmalar
  {
    desenler: ["müzekkere", "muzekkere", "muhafaza ve sevk", "dosya isteme", "yazışma", "yazisma", "savcılığından", "savciligindan", "istinaf"],
    klasor: "04-Muzekkereler-Yazismalar",
  },
  // 09 — duruşma zapt/çizelgesi
  { desenler: ["duruşma", "durusma", "zapt", "çizelge", "cizelge", "ciro"], klasor: "09-Durusma-Zabitlari" },
  // 11 — sorgu / ifade / arama
  { desenler: ["sorgu", "ifade", "arama tutanağı", "el koyma", "elkoyma", "tahdidi", "tutuklama"], klasor: "11-Sorgu-Belgeleri" },
  // 06 — mali
  {
    desenler: ["vekalet pulu", "vekalet pul", "harç", "harc", "sayman", "masraf", "mutemet", "alındı", "alindi", "aidat", "avans", "yevmiye"],
    klasor: "06-Mali",
  },
  // 07 — vekaletname ve idari evrak
  { desenler: ["vekaletname", "vekalet"], klasor: "07-Vekalet-Idari" },
  // 08 — ekler, diğer
  {
    desenler: ["ek", "delil", "belge", "rapor", "sened", "fatura", "fotoğraf", "fotograf", "bilirkişi", "bilirki"],
    klasor: "08-Ekler-Diger",
  },
];

const MAHKEME_GOSTERGESI = [
  "mahkeme", "hâkim", "hakim", "savcılık", "savcilik", "savcı", "savci",
  "bakanlık", "bakanlik", "sayman", "memur", "portal", "idari İşlem", "uzlaşma bürosu",
];

/** Mahkeme kendi belgesi mi (Dosya yönü)? */
function mahkemeBelgesiMi(nTur: string): boolean {
  const dosyaTurleri = [
    "karar", "hüküm", "hukm", "tutanak", "kıyar", "kiyar", "zapt", "çizelge", "cizelge",
    "sorgu", "ifade", "sayman", "alındı", "alindi", "mutemet", "yevmiye", "teblig",
  ];
  return dosyaTurleri.some((d) => nTur.includes(d));
}

function yonTespit(g: KlasifiKasyonGirdi): Yon {
  const nTur = norm(g.tur ?? "");
  const nGonderen = norm(g.gonderen ?? "");
  if (g.tip === "GLN") return "Gelen";
  if (g.tip === "GDN") return "Giden";
  // gönderen ipuçları (tip yokken)
  if (nGonderen.includes("avukat portal") || nGonderen.includes("sayman")) return "Giden";
  if (nGonderen.startsWith("av. ") || nGonderen.includes("avukat")) return "Gelen";
  const mahkemeGonderen = MAHKEME_GOSTERGESI.some((m) => nGonderen.includes(m));
  if (mahkemeGonderen) {
    return mahkemeBelgesiMi(nTur) ? "Dosya" : "Giden";
  }
  // gönderen bilinmiyor: mahkeme belgesi olan türler Dosya, öbürü Gelen
  if (nGonderen.length === 0) return mahkemeBelgesiMi(nTur) ? "Dosya" : "Gelen";
  return "Dosya";
}

/** Mahkemenin KENDİ dosya belgeleri — yön ne derse desin Dosya'ya gider
 *  (01/09/11 yalnız Dosya altında görülür). */
const DOSYA_YON_KATEGORILERI = new Set([
  "01-Kararlar-Tutanaklar",
  "09-Durusma-Zabitlari",
  "11-Sorgu-Belgeleri",
]);

/** Evrakı taksonomiye sınıflandırır. */
export function siniflandir(g: KlasifiKasyonGirdi): Kategori {
  const nTur = norm(g.tur ?? "");
  let yon = yonTespit(g);
  let klasor = "08-Ekler-Diger";
  for (const kural of KURALLAR) {
    for (const desen of kural.desenler) {
      if (nTur.includes(desen)) {
        klasor = kural.klasor;
        break;
      }
    }
    if (klasor !== "08-Ekler-Diger") break;
  }
  if (DOSYA_YON_KATEGORILERI.has(klasor)) yon = "Dosya";
  return { yon, klasor };
}
