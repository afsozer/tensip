import test from "node:test";
import assert from "node:assert/strict";
import { OturumDepo, OturumYoneticisi, type ProbeYanit } from "../src/uyap/session.js";
import { tmpKok } from "./yardimci.js";
import { Fren } from "../src/core/fren.js";

for (const [ad, yanit] of Object.entries({
  yonlendirme: { durum: 302, rc: "SUCCESS", govde: "{}" },
  html: { durum: 200, rc: "SUCCESS", govde: "<html>login</html>", contentType: "text/html" },
  ag: new Error("ECONNRESET"),
  bozukJson: { durum: 200, rc: "SUCCESS", govde: "not-json", contentType: "application/json" },
})) {
  test(`giriş ${ad} yanıtını doğrulanmış oturum saymaz`, async () => {
    const t = tmpKok();
    try {
      const depo = new OturumDepo(t.kok);
      let dogrulamaSirasindaKayit = false;
      const yonetici = new OturumYoneticisi(depo, { json: async () => {
        dogrulamaSirasindaKayit = depo.oku() !== null;
        if (yanit instanceof Error) throw yanit;
        return yanit;
      }});
      await assert.rejects(yonetici.girisiDogrula("JSESSIONID=aday", "manuel"), { code: "LOGIN_REQUIRED" });
      assert.equal(depo.oku(), null);
      assert.equal(dogrulamaSirasindaKayit, false, "aday çerez doğrulanmadan diske yazılmamalı");
    } finally { t.temizle(); }
  });
}

test("eşzamanlı probe tek portal isteği ve tek başarısızlık sayılır", async () => {
  const t = tmpKok();
  try {
    const depo = new OturumDepo(t.kok);
    let bitir!: (y: ProbeYanit) => void;
    let sayac = 0;
    const yonetici = new OturumYoneticisi(depo, { json: async () => {
      sayac++; return new Promise<ProbeYanit>(r => { bitir = r; });
    }});
    yonetici.girisYap("JSESSIONID=bir", "manuel");
    const a = yonetici.probeTaze();
    const b = yonetici.probeTaze();
    assert.equal(sayac, 1);
    bitir({ durum: 200, rc: "PRTL_GNL_10000-2", govde: "{}" });
    assert.deepEqual(await Promise.all([a, b]), ["bitti", "bitti"]);
    assert.equal(yonetici.bittiSayaci(), 1);
    assert.ok(depo.oku());
  } finally { t.temizle(); }
});

test("eski probe yeni girişi veya çıkışı geri alamaz", async () => {
  const t = tmpKok();
  try {
    let bitir!: (y: ProbeYanit) => void;
    const depo = new OturumDepo(t.kok);
    const yonetici = new OturumYoneticisi(depo, { json: async () => new Promise<ProbeYanit>(r => { bitir = r; }) });
    yonetici.girisYap("JSESSIONID=eski", "manuel");
    const bekleyen = yonetici.probe();
    yonetici.girisYap("JSESSIONID=yeni", "manuel");
    bitir({ durum: 401, rc: "SUCCESS", govde: "{}" });
    await bekleyen;
    assert.equal(yonetici.durum, "aktif");
    assert.equal(yonetici.bittiSayaci(), 0);
    const ikinci = yonetici.probe();
    yonetici.cikis();
    bitir({ durum: 200, rc: "SUCCESS", govde: "{}" });
    await ikinci;
    assert.equal(yonetici.durum, "giris_gerekiyor");
    assert.equal(depo.oku(), null);
  } finally { t.temizle(); }
});

test("eşzamanlı isteklerin başlangıçları da asgari aralığı korur", async () => {
  const f = new Fren({ istekAralikMs: 45 });
  const anlar: number[] = [];
  await Promise.all(Array.from({ length: 3 }, () => f.istek(async () => { anlar.push(Date.now()); })));
  assert.ok(anlar[1]! - anlar[0]! >= 40);
  assert.ok(anlar[2]! - anlar[1]! >= 40);
});
