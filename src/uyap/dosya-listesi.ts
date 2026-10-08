import { Hata, KODLAR } from "../core/errors.js";
import { UyapIstemci } from "./client.js";
import { UCLAR } from "./endpoints.js";
import { dosyaSatiriAyristir, satirlariDuzlestir } from "./schema.js";

export interface ListeKapsami {
  tur: string;
  tablo: string;
  ad: string;
}
// Canlı portal: 0 ceza, 1 hukuk, 2 icra. Eski YARGI_TURLERI etiketlerine dayanmaz.
export async function listeKapsamlariniGetir(
  c: UyapIstemci,
): Promise<ListeKapsami[]> {
  const sonuc: ListeKapsami[] = [];
  for (const tur of ["0", "1", "2"]) {
    const r = await c.json(UCLAR.yargiTurleri.yol, { yargiTuru: tur });
    const rows = satirlariDuzlestir(JSON.parse(r.govde));
    for (const row of rows) {
      const s = row as Record<string, unknown>;
      if (typeof s.tablo !== "string" || !s.tablo)
        throw new Hata(
          KODLAR.PORTAL_YANIT_BILINMIYOR,
          "Listeleme kapsamı çözülemedi",
        );
      if (!sonuc.some((k) => k.tur === tur && k.tablo === s.tablo))
        sonuc.push({
          tur,
          tablo: s.tablo,
          ad: typeof s.kod === "string" ? s.kod : s.tablo,
        });
    }
  }
  if (!sonuc.length)
    throw new Hata(
      KODLAR.PORTAL_YANIT_BILINMIYOR,
      "Portal listeleme kapsamı boş döndü",
    );
  return sonuc;
}
export async function dosyaListeSayfasi(
  c: UyapIstemci,
  kapsam: ListeKapsami,
  sayfa: number,
) {
  const r = await c.json(UCLAR.dosyaAra.yol, {
    dosyaDurumKod: 0,
    pageSize: 500,
    pageNumber: sayfa,
    dosyaYil: "",
    dosyaSira: "",
    birimId: "",
    birimTuru2: kapsam.tablo,
    birimTuru3: kapsam.tur,
  });
  const rows = satirlariDuzlestir(JSON.parse(r.govde));
  const davalar = rows.map((row) =>
    dosyaSatiriAyristir(row as Record<string, unknown>),
  );
  if (davalar.some((d) => !d || d.birimAdi === "—"))
    throw new Hata(
      KODLAR.PORTAL_YANIT_BILINMIYOR,
      "Bazı dosya satırları çözülemedi; liste tamamlanmadı",
    );
  return {
    davalar: davalar.map((d) => ({
      dosyaId: d!.dosyaId,
      birimAdi: d!.birimAdi,
      birimId: d!.birimId,
      esasNo: d!.esasNo,
      dosyaTur: d!.dosyaTur,
      dosyaDurum: d!.dosyaDurum,
    })),
    devam: rows.length >= 500,
  };
}
