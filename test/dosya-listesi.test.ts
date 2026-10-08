import { test } from "node:test";
import assert from "node:assert/strict";
import { daemonKur } from "../src/server/daemon.js";
import { MockUyap, opakToken } from "./mock-uyap/sunucu.js";
import { tmpKok } from "./yardimci.js";
import { dosyaListeSayfasi } from "../src/uyap/dosya-listesi.js";
import { UyapIstemci } from "../src/uyap/client.js";

test("filtresiz liste farklı türler ve 500 sınırını geçer; önbellek ve eski oturum korunur", async () => {
  const tmp = tmpKok();
  const mock = new MockUyap({
    birimler: [],
    davalar: Array.from({ length: 503 }, (_, i) => ({
      dosyaId: opakToken(`liste-${i}`),
      birimAdi: `Test ${i % 3}`,
      birimId: String(i % 3),
      esasNo: `2026/${i + 1}`,
      dosyaTur: "Test",
      dosyaDurum: i % 2 ? "Açık" : "Kapalı",
      yargiTuru: i < 501 ? "0" : "2",
      evraklar: [],
    })),
  });
  await mock.baslat();
  const d = daemonKur({
    ayarDir: tmp.kok,
    kok: tmp.kok,
    portalUrl: mock.adres(),
    istekAralikMs: 0,
    oturumYenileMs: 0,
  });
  const call = d.isleyiciler.get("dosyalar-listele")!;
  try {
    await assert.rejects(call({}), { code: "LOGIN_REQUIRED" });
    d.oturum.girisYap("JSESSIONID=test", "manuel");
    await assert.rejects(call({ sayfa: 0 }), { code: "INVALID_INPUT" });
    const first = (await call({})) as any;
    assert.equal(first.davalar.length, 500);
    const n = mock.istekler.length;
    await call({});
    assert.equal(mock.istekler.length, n);
    let next = first.sonraki,
      count = first.davalar.length;
    while (next) {
      const page = (await call(next)) as any;
      count += page.davalar.length;
      next = page.sonraki;
    }
    assert.equal(count, 503);
    assert.equal(d.registry.oku().davalar.length, 0);
    const searches = mock.istekler.filter((r) =>
      r.yol.includes("search_phrase"),
    );
    assert.ok(
      searches.every((r) => {
        const g = JSON.parse(r.govde);
        return (
          g.dosyaYil === "" &&
          g.dosyaSira === "" &&
          g.birimId === "" &&
          g.dosyaDurumKod === 0
        );
      }),
    );
    d.oturum.girisYap("JSESSIONID=other", "manuel");
    await assert.rejects(call(first.sonraki), { code: "LOGIN_REQUIRED" });
  } finally {
    await d.kapat();
    await mock.durdur();
    tmp.temizle();
  }
});
test("çözülemeyen dosya satırı boş veya tam liste sayılmaz", async () => {
  const c = new UyapIstemci({ baseUrl: "http://unused", cookie: () => "" });
  c.json = async () => ({
    durum: 200,
    basliklar: {},
    govde: JSON.stringify([[{ unknown: true }]]),
  });
  await assert.rejects(
    dosyaListeSayfasi(c, { tur: "0", tablo: "test", ad: "Test" }, 1),
    { code: "PORTAL_YANIT_BILINMIYOR" },
  );
});
