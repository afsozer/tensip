import type { ManifestEvrak } from "./manifest.js";

/** Yalnız evrakId ve indirmeDamgasi dışında tamamen aynı kayıtları birleştirir. Aynı yol/isim
 * tek başına yeterli değildir; içerik özeti ve bütün meta alanlar eşleşmelidir.
 * Portal iki kimliği de halen ayrı döndürüyorsa kaydı daraltmayız. */
export function ayniKaynakTekillestir(
  kayitlar: ManifestEvrak[],
  guncel: Set<string>,
): ManifestEvrak[] {
  const gruplar = new Map<string, ManifestEvrak[]>();
  for (const e of kayitlar) {
    const anahtar = JSON.stringify(
      Object.entries(e)
        // `indirmeDamgasi` (P15b) anahtara GİRMEZ: yalnız hangi eşitlemede
        // indiğini söyler, kaydın kimliği ya da içeriği hakkında bir şey
        // söylemez. Anahtara girseydi aynı kaynağın iki kopyası farklı
        // denemelerde indiği için ARTIK BİRLEŞMEZ ve manifest'te mükerrer
        // kayıt birikirdi (bekçi: test/manifest-tekrar.test.ts).
        .filter(([k]) => k !== "evrakId" && k !== "indirmeDamgasi")
        .sort(([a], [b]) => a.localeCompare(b)),
    );
    const grup = gruplar.get(anahtar) ?? [];
    grup.push(e);
    gruplar.set(anahtar, grup);
  }
  return [...gruplar.values()].flatMap((grup) => {
    const canli = grup.filter((e) => guncel.has(e.evrakId));
    if (new Set(canli.map((e) => e.evrakId)).size > 1) return grup;
    return [canli[0] ?? grup[grup.length - 1]!];
  });
}
