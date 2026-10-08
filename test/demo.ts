// Tanıtım ortamı: sahte UYAP portalına SENTETİK bir büroyu yükler, Tensip'i
// ona bağlar ve yerel panoyu açar. README ekran görüntüleri bununla alınır.
// Gerçek portala hiç bağlanmaz; bütün mahkeme dosyaları, taraflar ve evraklar
// uydurmadır. Çalıştırma: `npm run build && node bin/demo.mjs [port]`
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonKur, webPanosuBaslat } from "../src/server/daemon.js";
import { MockUyap, opakToken, type MockDava, type MockEvrak } from "./mock-uyap/sunucu.js";
import { makeHtml, makeUdf } from "./yardimci.js";

const CEREZ = "JSESSIONID=demo0000000000000000; NSC_demo=0";

function evrak(tohum: string, tur: string, gonderen: string, tip: "GLN" | "GDN", tarih: string, no: number, paragraflar: string[], ana?: string): MockEvrak {
  return {
    evrakId: opakToken(tohum),
    tur, gonderen, tip, tarih,
    birimEvrakNo: String(no),
    durum: "yuklu",
    contentTipi: "application/octet-stream",
    icerik: makeUdf(paragraflar),
    ...(ana ? { anaEvrakId: opakToken(ana), ekSira: 1 } : {}),
  };
}

function dava(kod: string, birimId: string, birimAdi: string, esasNo: string, dosyaTur: string, yargiTuru: string, evraklar: MockEvrak[], taraflar: [string, string, string][]): MockDava {
  return {
    dosyaId: opakToken(`demo-${kod}`),
    birimId, birimAdi, esasNo, dosyaTur, yargiTuru,
    dosyaDurum: "Açık",
    evraklar,
    taraflar: taraflar.map(([isim, soyad, sifat]) => ({ isim, soyad, sifat, adres: "", vekil: sifat === "DAVACI" ? "AV. DEMO AVUKAT" : "" })),
  };
}

const ISCI = dava("is", "9100001", "İstanbul Anadolu 4. İş Mahkemesi", "2026/412", "Hukuk Dava Dosyası", "1", [
  evrak("is-1", "Dava Dilekçesi", "Av. Demo Avukat", "GDN", "02/03/2026", 1104, [
    "İSTANBUL ANADOLU NÖBETÇİ İŞ MAHKEMESİ'NE",
    "DAVACI : Elif DEMİR",
    "DAVALI : Örnek Lojistik A.Ş.",
    "KONU : Kıdem ve ihbar tazminatı, fazla mesai ve yıllık izin ücreti alacaklarının tahsili istemidir.",
    "AÇIKLAMALAR : Müvekkil davalı işyerinde 12.04.2019 - 15.01.2026 tarihleri arasında depo sorumlusu olarak çalışmış, iş akdi haklı bir neden olmaksızın işveren tarafından feshedilmiştir.",
    "Müvekkil haftanın altı günü 08.00 - 20.00 saatleri arasında çalıştırılmış, fazla mesai ücretleri ödenmemiştir.",
    "HUKUKİ NEDENLER : 4857 sayılı İş Kanunu, 1475 sayılı Kanun md. 14, HMK ve ilgili mevzuat.",
    "SONUÇ VE İSTEM : Fazlaya ilişkin haklarımız saklı kalmak kaydıyla şimdilik 10.000,00 TL kıdem tazminatının davanın kabulüyle tahsiline karar verilmesini saygıyla arz ve talep ederiz.",
  ]),
  evrak("is-2", "Tensip Zaptı", "Mahkeme", "GLN", "09/03/2026", 1178, [
    "T.C. İSTANBUL ANADOLU 4. İŞ MAHKEMESİ",
    "TENSİP ZAPTI",
    "Dava dilekçesi ve ekleri incelendi. Davalıya dava dilekçesinin tebliğine, cevap için iki haftalık süre verilmesine,",
    "Davacının SGK hizmet dökümünün ve işyeri özlük dosyasının celbine,",
    "Ön inceleme duruşmasının 14/10/2026 günü saat 10:30'a bırakılmasına karar verildi.",
  ]),
  evrak("is-3", "Cevap Dilekçesi", "Av. Karşı Taraf Vekili", "GLN", "27/03/2026", 1302, [
    "CEVAP DİLEKÇESİ",
    "Davacının iş akdi devamsızlık nedeniyle haklı olarak feshedilmiştir. Fazla mesai iddiası gerçeği yansıtmamaktadır.",
    "Davanın reddine karar verilmesini talep ederiz.",
  ]),
  evrak("is-4", "Cevaba Cevap Dilekçesi", "Av. Demo Avukat", "GDN", "08/04/2026", 1366, [
    "CEVABA CEVAP DİLEKÇESİ",
    "Davalının devamsızlık iddiası hiçbir tutanakla desteklenmemiştir; fesih bildiriminde de devamsızlıktan söz edilmemektedir.",
  ]),
  evrak("is-5", "Tanık Listesi", "Av. Demo Avukat", "GDN", "08/04/2026", 1367, ["TANIK LİSTESİ", "1. Murat Aksoy", "2. Zeynep Kılıç"], "is-4"),
  evrak("is-6", "Bilirkişi Raporu", "Bilirkişi", "GLN", "22/09/2026", 2011, [
    "BİLİRKİŞİ RAPORU",
    "Dosya kapsamı ve tanık beyanları birlikte değerlendirildiğinde davacının haftada ortalama 14 saat fazla çalışma yaptığı kanaatine varılmıştır.",
    "Hesaplanan brüt kıdem tazminatı: 186.420,00 TL",
  ]),
], [["ELİF", "DEMİR", "DAVACI"], ["ÖRNEK LOJİSTİK A.Ş.", "", "DAVALI"]]);

const AILE = dava("aile", "9100002", "Ankara 12. Aile Mahkemesi", "2026/287", "Hukuk Dava Dosyası", "1", [
  evrak("aile-1", "Dava Dilekçesi", "Av. Demo Avukat", "GDN", "15/01/2026", 311, [
    "ANKARA NÖBETÇİ AİLE MAHKEMESİ'NE",
    "KONU : Anlaşmalı boşanma istemidir.",
    "Taraflar arasında düzenlenen protokol ekte sunulmuştur.",
  ]),
  evrak("aile-2", "Protokol", "Av. Demo Avukat", "GDN", "15/01/2026", 312, ["ANLAŞMALI BOŞANMA PROTOKOLÜ", "Velayet, nafaka ve mal paylaşımına ilişkin hükümler."], "aile-1"),
  evrak("aile-3", "Duruşma Zaptı", "Mahkeme", "GLN", "26/02/2026", 498, ["DURUŞMA ZAPTI", "Tarafların protokolü özgür iradeleriyle kabul ettikleri anlaşıldı."]),
], [["CAN", "ÖZTÜRK", "DAVACI"], ["SEDA", "ÖZTÜRK", "DAVALI"]]);

const ICRA = dava("icra", "9100003", "İzmir 3. İcra Dairesi", "2026/1540", "İcra Dosyası", "2", [
  evrak("icra-1", "Takip Talebi", "Av. Demo Avukat", "GDN", "05/05/2026", 7720, ["TAKİP TALEBİ", "Alacaklı: Demo Gıda Ltd. Şti.", "Alacak: 48.750,00 TL fatura alacağı"]),
  evrak("icra-2", "Ödeme Emri", "İcra Dairesi", "GLN", "07/05/2026", 7731, ["ÖDEME EMRİ", "Borçlunun tebliğden itibaren 7 gün içinde borcu ödemesi gerekir."]),
  evrak("icra-3", "İtiraz Dilekçesi", "Borçlu", "GLN", "16/05/2026", 7802, ["İTİRAZ", "Borca ve tüm ferilerine itiraz ediyorum."]),
], [["DEMO GIDA LTD. ŞTİ.", "", "ALACAKLI"], ["HAKAN", "ŞAHİN", "BORÇLU"]]);

const TICARET = dava("ticaret", "9100004", "Bursa 2. Asliye Ticaret Mahkemesi", "2025/856", "Hukuk Dava Dosyası", "1", [
  evrak("tic-1", "Dava Dilekçesi", "Av. Demo Avukat", "GDN", "11/11/2025", 5120, ["DAVA DİLEKÇESİ", "Konu: Haksız rekabetin tespiti ve men'i."]),
], [["DEMO TEKSTİL A.Ş.", "", "DAVACI"], ["BENZER KUMAŞ LTD. ŞTİ.", "", "DAVALI"]]);

const CEZA = dava("ceza", "9100005", "Antalya 7. Asliye Ceza Mahkemesi", "2026/633", "Ceza Dava Dosyası", "0", [
  evrak("ceza-1", "İddianame", "Cumhuriyet Başsavcılığı", "GLN", "03/06/2026", 2240, ["İDDİANAME", "Suç: Güveni kötüye kullanma (TCK 155)"]),
], [["KAMU", "", "KATILAN"], ["SERKAN", "AYDIN", "SANIK"]]);

function durusma(kayitId: number, d: MockDava, gunSonra: number, saat: string, tur: string): Record<string, unknown> {
  const t = new Date(Date.now() + gunSonra * 86_400_000);
  const g = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
  return {
    kayitId, dosyaId: d.dosyaId, dosyaNo: d.esasNo, dosyaTurKod: 0, dosyaTurKodAciklama: d.dosyaTur,
    birimId: d.birimId, yerelBirimAd: d.birimAdi, tarihSaat: `${g} ${saat}:00.0`,
    islemTuru: tur === "Keşif" ? 1 : 0, islemSonucu: 0, hakimHeyet: 0,
    islemTuruAciklama: tur, islemSonucuAciklama: "Günü Verildi",
    dosyaTaraflari: (d.taraflar ?? []).map((t) => ({ ...t, isVekil: t["sifat"] === "DAVACI" })),
    izinliHakimList: [], talepDurumu: "Diğer", katilButonAktifMi: false, token: "",
    isEDurusmaBirimTalepValid: false, isEDurusmaSaatTalepValid: false, isEDurusmaGuncellenecek: false,
  };
}

const davalar = [ISCI, AILE, ICRA, TICARET, CEZA];
const mock = new MockUyap({
  birimler: davalar.map((d) => ({ birimId: d.birimId, birimAdi: d.birimAdi, yargiTuru: d.yargiTuru })),
  davalar,
  durusmalar: [
    durusma(1, ISCI, 0, "10:30", "Duruşma"),
    durusma(2, CEZA, 1, "09:40", "Duruşma"),
    durusma(3, TICARET, 1, "14:00", "Duruşma"),
    durusma(4, AILE, 3, "11:15", "Duruşma"),
    durusma(5, ICRA, 6, "13:30", "Keşif"),
  ],
});
mock.detaySatirlari.safahat = [
  { safahatTarihiSTR: "02.03.2026", safahatTuruAciklama: "Dava Açılış", aciklama: "Dava açıldı", safahatStatuKodAciklama: "Tamamlandı" },
  { safahatTarihiSTR: "09.03.2026", safahatTuruAciklama: "Tensip", aciklama: "Tensip zaptı düzenlendi", safahatStatuKodAciklama: "Tamamlandı" },
  { safahatTarihiSTR: "27.03.2026", safahatTuruAciklama: "Cevap", aciklama: "Cevap dilekçesi verildi", safahatStatuKodAciklama: "Tamamlandı" },
  { safahatTarihiSTR: "22.09.2026", safahatTuruAciklama: "Bilirkişi", aciklama: "Bilirkişi raporu dosyaya sunuldu", safahatStatuKodAciklama: "Tamamlandı" },
  { safahatTarihiSTR: "14.10.2026", safahatTuruAciklama: "Duruşma", aciklama: "Ön inceleme duruşması", safahatStatuKodAciklama: "Bekliyor" },
];

const port = Number(process.argv[2] ?? 4848);
const kok = mkdtempSync(join(tmpdir(), "tensip-demo-"));
await mock.baslat();
const daemon = daemonKur({
  ayarDir: join(kok, "ayar"),
  kok: join(kok, "arsiv"),
  portalUrl: mock.adres(),
  appVersion: "demo",
  // Yalnız sahte portala karşı: gerçek portalda bu değerler KULLANILMAZ.
  istekAralikMs: 5,
  oturumYenileMs: 0,
});
await daemon.rpc.baslat();
const h = (ad: string) => daemon.isleyiciler.get(ad)!;
await h("giris")({ cerez: CEREZ });
for (const d of [ISCI, AILE, ICRA]) {
  const { isId } = (await h("klonla")({ birim: d.birimAdi, esas: d.esasNo, kapsam: "hepsi", avukat: "DEMO AVUKAT" })) as { isId: string };
  for (let i = 0; i < 400; i++) {
    const is = (await h("is")({ isId })) as { durum: string };
    if (!["calisiyor", "bekliyor"].includes(is.durum)) break;
    await new Promise((c) => setTimeout(c, 25));
  }
}
const adres = await webPanosuBaslat(daemon, port, "demo", mock.adres(), join(kok, "arsiv"));
process.stderr.write(`Tensip demo hazır: ${adres}  (durdurmak için Ctrl+C)\n`);

const kapat = async () => {
  await daemon.kapat().catch(() => undefined);
  await mock.durdur();
  rmSync(kok, { recursive: true, force: true });
  process.exit(0);
};
process.on("SIGINT", () => void kapat());
process.on("SIGTERM", () => void kapat());
