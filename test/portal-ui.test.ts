import { test } from "node:test";
import assert from "node:assert/strict";

// Kaynak web modülü derleme çıktısına kopyalanmaz; test çalışma dizininden yükler.
const { portalSonuclari, portalSayfa, portalDurum } = await import(
  new URL("../../web/portal.js", import.meta.url).href
);

test("P02 yerel sonuçları Türkçe arar, bilinmeyen durumu korur ve sıralar", () => {
  const cases = Array.from({ length: 2_000 }, (_, i) => ({
    dosyaId: `id-${i}`,
    birimAdi: i === 7 ? "İzmir ı Mahkemesi" : `Denizli ${i % 4}. İş Mahkemesi`,
    esasNo: `2026/${2000 - i}`,
    dosyaTur: i % 2 ? "İcra Takibi" : "Hukuk Dava Dosyası",
    dosyaDurum:
      i % 3 === 0
        ? "Açık (Durdurulmuş : Takibe İtiraz)"
        : i % 3 === 1
          ? "Kapalı"
          : "İstinafta",
  }));
  assert.equal(
    portalSonuclari(cases, { search: "İZMİR I", status: "tumu" }).length,
    1,
  );
  assert.equal(
    portalSonuclari(cases, { search: "iş mahkemesi", status: "acik" }).every(
      (c: any) => portalDurum(c.dosyaDurum) === "acik",
    ),
    true,
  );
  assert.equal(portalSonuclari(cases, { status: "bilinmeyen" }).length, 666);
  assert.equal(portalDurum("Açıklama bekleniyor"), "bilinmeyen");
  assert.equal(portalDurum("Kapalı değil"), "bilinmeyen");
  const sorted = portalSonuclari(cases, { sort: "esas", direction: "asc" });
  assert.equal(sorted[0].esasNo, "2026/1");
  assert.equal(sorted.at(-1)?.esasNo, "2026/2000");
  const page = portalSayfa(sorted, 40, 50);
  assert.equal(page.items.length, 50);
  assert.equal(page.totalPages, 40);
  assert.equal(page.items[0].esasNo, "2026/1951");
});
