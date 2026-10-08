// Mock UYAP Avukat Portalı — test sunucusu.
// Doğrulanmış portal sözleşmesini birebir uygular:
//  • uçlar HTTP 200 döner; gerçek durum `uyapfc_rc` başlığındadır
//  • oturum çerezi yoksa/bitti ise rc=PRTL_GNL_10000-2
//  • search_phrase_detayli iç içe dizi döner [[{...}]]
//  • list_dosya_evraklar {tumEvraklar, son20Evrak, pageTotal}
//  • view_document_brd: opak evrakId/dosyaId; yüklenmemiş evrak
//    text/plain + "Evrak UYAP sistemine yüklenmemiş."
//  • dosyaId/evrakId opak token (tırnak işaretleri değerin İÇİNDE)

import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { createHash } from "node:crypto";

export interface MockDava {
  dosyaId: string; // opak token
  birimAdi: string;
  birimId: string;
  esasNo: string; // "2026/928"
  dosyaTur: string;
  dosyaDurum: string;
  yargiTuru: string;
  evraklar: MockEvrak[];
  /** P18 — bu dosyanın taraf satırları (ham portal biçimi). Verilmezse
   *  varsayılan iki satır döner. Adlar SENTETİKTİR. */
  taraflar?: Record<string, unknown>[];
  /**
   * P19 — PORTAL KİMLİĞİ KALICI DEĞİLDİR. Gerçek portalda ölçüldü (12 Eylül,
   * aynı oturumda arka arkaya iki `list_dosya_evraklar.ajx`): `evrakId`
   * 0/113, `ggEvrakId` 0/113 aynı kaldı — ikisi de YANIT BAŞINA üretiliyor.
   * Açıkken mock her liste isteğinde satırın kimliğine yeni bir sonek
   * ekler; indirme ucu soneki atarak belgeyi bulur (gerçek portalda da
   * o turda dönen kimlik indirmede geçerlidir).
   *
   * Bu bayrak olmadan MockUyap P19 kusurunu ÜRETEMEZ: sabit kimlikle
   * orkestratör her satırı `evrakId` üzerinden bulur ve manifest şişmez.
   */
  kimlikDoner?: boolean;
}

export interface MockEvrak {
  evrakId: string; // opak token
  tur: string;
  gonderen: string;
  tip: "GLN" | "GDN";
  tarih: string; // "04/09/2026"
  birimEvrakNo: string;
  /** "yuklu" | "yuklenmemis" | "hata" | "giris-sayfasi" */
  durum: "yuklu" | "yuklenmemis" | "hata" | "giris-sayfasi";
  icerik: Buffer;
  contentTipi: string;
  /** ek evrak ise ana evrakId */
  anaEvrakId?: string;
  ekSira?: number;
  /**
   * P19 — UYAP BAZI BELGELERİ HER İNDİRİŞTE YENİDEN ÜRETİR. Gerçek arşivde
   * ölçüldü: aynı grubun beş kaydının baytları (34090/34092/34093/34083/
   * 34087) ve sha256'ları farklı, çıkarılan METİN beşinde de birebir aynı
   * (üretim damgası belgenin içinde değişiyor).
   *
   * Açıkken her indirişte içeriğin sonuna görünmez bir HTML yorumu eklenir:
   * baytlar ve sha256 DEĞİŞİR, `htmlToMd` yorumu attığı için çıkarılan metin
   * AYNI kalır. Bu yüzden yalnız `text/html` içerikte anlamlıdır.
   */
  uretimDamgasi?: boolean;
}

export interface MockBirım {
  birimId: string;
  birimAdi: string;
  yargiTuru: string;
}

export interface MockKurulum {
  birimler: MockBirım[];
  davalar: MockDava[];
  /** geçerli çerez değeri (JSESSIONID=...); boşsa kimlik denetimi yalnız varlık */
  gecerliCerezRegex?: RegExp;
  /** Duruşma ucu satırları (ham portal biçimi); verilmezse sabit iki satır döner. */
  durusmalar?: Record<string, unknown>[];
}

const RC_OK = "SUCCESS";
const RC_OTURUM = "PRTL_GNL_10000-2";
/** P07b — `detayGecikmeMs` yalnız bu üç uca uygulanır. */
const DETAY_YOLLARI = new Set([
  "/dosya_safahat_bilgileri_brd.ajx",
  "/dosya_taraf_bilgileri_brd.ajx",
  "/dosya_hesap_bilgileri.ajx",
]);

export class MockUyap {
  private sunucu?: Server;
  port = 0;
  /** sunucuya gelen istek günlüğü (test denetimi için) */
  istekler: { yol: string; cookie: string; govde: string }[] = [];
  /** P18 — açıkken taraf ucu hata rc'si döner (iş düşmemeli). */
  tarafHatasi = false;
  /** P07b — açıkken safahat ucu UYAP'ın KENDİ saatlik limitini döndürür. */
  safahatLimiti = false;
  /** P07b — verilirse safahat/taraf/hesap uçları bu satırları döndürür
   *  (boş dizi de geçerli bir senaryodur: "kayıt yok" ≠ "hata"). */
  detaySatirlari: Partial<Record<"safahat" | "taraf" | "hesap", Record<string, unknown>[]>> = {};
  /** P07b — detay uçlarının yanıtını geciktirir. DİKKAT: bu bir UYKUDUR,
   *  yarışı kaldırmaz — kimlik araması (`/search_phrase_detayli.ajx`)
   *  geciktirilmez, yük altında o arama gecikmeyi yiyip senaryoyu bozar
   *  (P07b incelemesinde ölçüldü: `--test-concurrency=24` ile 4/4 düşüş).
   *  "Sorgu uçarken oturum değişti" senaryosu için `detayTutulsun` +
   *  `detayIstegiUlasti()` + `detaySerbestBirak()` üçlüsünü kullanın. */
  detayGecikmeMs = 0;
  /** P07b incelemesi — açıkken detay uçlarının YANITI beklemeye alınır ve
   *  yalnız `detaySerbestBirak()` ile döner. Testte zamanlama kalmaz. */
  detayTutulsun = false;
  /** beklemeye alınmış detay yanıtları (serbest bırakılınca çalışır) */
  private tutulanlar: (() => void)[] = [];
  /** `detayIstegiUlasti()` bekleyicileri */
  private detayBekleyenler: (() => void)[] = [];
  /** P19 — `kimlikDoner` için liste turu sayacı; her liste isteğinde artar. */
  private listeTuru = 0;
  /** P19 — `uretimDamgasi` için indirme sayacı; her indirişte artar. */
  private uretimTuru = 0;
  /** oturum sonrası bu regex ile çerez doğrulanır */
  private k: MockKurulum;

  constructor(k: MockKurulum) {
    this.k = k;
  }

  async baslat(): Promise<number> {
    return new Promise((coz) => {
      this.sunucu = createServer((req, res) => {
        const parcalar: Buffer[] = [];
        req.on("data", (c: Buffer) => parcalar.push(c));
        req.on("end", () => {
          const govde = Buffer.concat(parcalar).toString("utf8");
          const cookie = (req.headers["cookie"] as string) ?? "";
          const yol = (req.url ?? "").split("?")[0]!;
          const query = new URL(req.url ?? "/", "http://x").searchParams;
          this.istekler.push({ yol, cookie, govde });
          const detay = DETAY_YOLLARI.has(yol);
          // P07b incelemesi — "asıl detay isteği ULAŞTI" sinyali: kimlik
          // araması bu noktada BİTMİŞTİR. Test oturumu tam burada değiştirir,
          // uykuyla tahmin etmez.
          if (detay) for (const f of this.detayBekleyenler.splice(0)) f();
          const cevir = (): void => this.cevapla(yol, cookie, govde, query, res);
          if (detay && this.detayTutulsun) {
            this.tutulanlar.push(cevir);
            return;
          }
          const gecikme = detay ? this.detayGecikmeMs : 0;
          if (gecikme > 0) setTimeout(cevir, gecikme);
          else cevir();
        });
      });
      this.sunucu.listen(0, "127.0.0.1", () => {
        const a = this.sunucu!.address() as AddressInfo;
        this.port = a.port;
        coz(a.port);
      });
    });
  }

  /** Bir sonraki detay isteği sunucuya ULAŞTIĞINDA çözülür. */
  detayIstegiUlasti(): Promise<void> {
    return new Promise<void>((c) => this.detayBekleyenler.push(c));
  }

  /** Beklemeye alınmış detay yanıtlarını gönderir. */
  detaySerbestBirak(): void {
    for (const f of this.tutulanlar.splice(0)) f();
  }

  async durdur(): Promise<void> {
    return new Promise((c) => {
      this.sunucu?.closeAllConnections();
      this.sunucu?.close(() => c());
      this.sunucu = undefined;
    });
  }

  /** Testler için dava bulma/esitleme yardımcıları */
  davalarBul(esasNo: string, birimId: string): MockDava | undefined {
    return this.k.davalar.find((d) => d.esasNo === esasNo && d.birimId === birimId);
  }

  gecerliCerezRegexAyarla(r: RegExp | undefined): void {
    this.k.gecerliCerezRegex = r;
  }

  adres(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  private oturumGecerliMi(cookie: string): boolean {
    if (!cookie || !/JSESSIONID/i.test(cookie)) return false;
    const r = this.k.gecerliCerezRegex;
    if (r) return r.test(cookie);
    return true;
  }

  private cevapla(
    yol: string,
    cookie: string,
    govde: string,
    query: URLSearchParams,
    res: import("node:http").ServerResponse
  ): void {
    const oturum = this.oturumGecerliMi(cookie);
    const json = (veri: unknown, rc: string = RC_OK): void => {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "uyapfc_rc": rc });
      res.end(JSON.stringify(veri));
    };
    if (!oturum) {
      // portal oturum bitti: HTTP 200 + rc
      json({}, RC_OTURUM);
      return;
    }
    if (yol === "/yargiBirimleriSorgula_brd.ajx") {
      const g = JSON.parse(govde || "{}") as { yargiTuru?: string };
      const tur = g.yargiTuru ?? "0";
      const adlar: Record<string, string> = { "0": "Hukuk", "1": "Ceza", "2": "İdare" };
      // Doğrulanmış biçim: her öğede tablo alanı
      json([{ tablo: `TABLO-${tur}`, aciklama: adlar[tur] ?? "Hukuk" }]);
      return;
    }
    if (yol === "/avukat_mahkemeleri_sorgula.ajx") {
      const g = JSON.parse(govde || "{}") as { yargiBirimi?: string };
      const tablo = (g.yargiBirimi ?? "").replace("TABLO-", "");
      const liste = this.k.birimler
        .filter((b) => b.yargiTuru === tablo)
        .map((b) => ({ birimId: b.birimId, birimAdi: b.birimAdi }));
      json(liste);
      return;
    }
    if (yol === "/dosya_safahat_bilgileri_brd.ajx" || yol === "/dosya_taraf_bilgileri_brd.ajx" || yol === "/dosya_hesap_bilgileri.ajx") {
      // PAKET-ÇIKARIMI (canlı doğrulama bekliyor): {dosyaId} → satırlar.
      // Safahat kolonları SPA paketinden birebir; veriler SENTETİK.
      const g = JSON.parse(govde || "{}") as { dosyaId?: string };
      if (!g.dosyaId) {
        json({ hata: "dosyaId gerekli" }, "PRTL_GNL_HATA");
        return;
      }
      if (yol === "/dosya_safahat_bilgileri_brd.ajx") {
        // P07b — UYAP'ın KENDİ hız sınırı: "Bu işlem 60 dakikada 1 defa".
        if (this.safahatLimiti) {
          json({ hata: "Bu işlem 60 dakikada 1 defa yapılabilir" }, "PRTL_GNL_1-1");
          return;
        }
        if (this.detaySatirlari.safahat !== undefined) {
          json(this.detaySatirlari.safahat);
          return;
        }
        json([
          {
            safahatTarihiSTR: "08.09.2026",
            safahatTuruAciklama: "Tebligat",
            aciklama: "Davetiye tebliğ edildi",
            safahatStatuKodAciklama: "Tamamlandı",
          },
          {
            safahatTarihiSTR: "09.09.2026",
            safahatTuruAciklama: "Duruşma",
            aciklama: "İlk celse",
            safahatStatuKodAciklama: "Bekliyor",
          },
        ]);
        return;
      }
      if (yol === "/dosya_taraf_bilgileri_brd.ajx") {
        // P18 — taraf ucu bilerek düşürülebilir: eşitleme yine tamamlanmalı.
        if (this.tarafHatasi) {
          json({ errorCode: "TARAF_SERVISI", error: "taraf servisi kapalı" }, "PRTL_GNL_HATA");
          return;
        }
        if (this.detaySatirlari.taraf !== undefined) {
          json(this.detaySatirlari.taraf);
          return;
        }
        const secili = this.k.davalar.find((d) => d.dosyaId === g.dosyaId);
        if (secili?.taraflar !== undefined) {
          json(secili.taraflar);
          return;
        }
        json([
          {
            isim: "AYŞE",
            soyad: "YILMAZ",
            sifat: "DAVACI",
            adres: "Denizli",
            vekil: "AV. TEST VEKİL",
          },
          {
            isim: "MEHMET",
            soyad: "KAYA",
            sifat: "DAVALI",
            adres: "Denizli",
            vekil: "",
          },
        ]);
        return;
      }
      if (this.detaySatirlari.hesap !== undefined) {
        json(this.detaySatirlari.hesap);
        return;
      }
      json([
        { tarih: "05.09.2026", aciklama: "Hesap ekstresi", alacak: "10.000,00", odendi: "2.500,00" },
      ]);
      return;
    }
    if (yol === "/avukat_durusma_sorgula_brd.ajx") {
      if (this.k.durusmalar !== undefined) {
        json(this.k.durusmalar);
        return;
      }
      // Doğrulanmış sözleşme (5 Eyl): {baslangicTarihi,bitisTarihi} → DÜZ
      // DİZİ (sarmalayıcı yok). Satırlar bilinçli karışık sırada — parser
      // kronolojik sıralamalı. Veriler SENTETİK (gerçek müvekkil verisi yok).
      json([
        {
          kayitId: 1001,
          dosyaId: opakToken("durusma-1"),
          dosyaNo: "2026/900",
          dosyaTurKod: 0,
          dosyaTurKodAciklama: "Hukuk Dava Dosyası",
          birimId: "3000",
          birimOrgKodu: "1.01.001",
          birimTuru1: "0",
          birimTuru2: "0101",
          birimTuru3: "01011",
          yerelBirimAd: "CLI Test Sulh Hukuk Mahkemesi",
          tarihSaat: "2026-09-09 09:30:00.0",
          islemTuru: 0,
          islemSonucu: 0,
          hakimHeyet: 0,
          islemTuruAciklama: "Duruşma",
          islemSonucuAciklama: "Günü Verildi",
          dosyaTaraflari: [
            { isim: "AYŞE", soyad: "YILMAZ", sifat: "DAVACI", ilkKisiKurumID: "11111111111", isVekil: true },
            { isim: "MEHMET", soyad: "KAYA", sifat: "DAVACI", ilkKisiKurumID: "22222222222", isVekil: false },
          ],
          izinliHakimList: [],
          talepDurumu: "Diğer",
          katilButonAktifMi: false,
          token: "",
          isEDurusmaBirimTalepValid: false,
          isEDurusmaSaatTalepValid: true,
          isEDurusmaGuncellenecek: false,
        },
        {
          kayitId: 1002,
          dosyaId: opakToken("durusma-2"),
          dosyaNo: "2026/901",
          dosyaTurKod: 0,
          dosyaTurKodAciklama: "Hukuk Dava Dosyası",
          birimId: "3000",
          birimOrgKodu: "1.01.001",
          birimTuru1: "0",
          birimTuru2: "0101",
          birimTuru3: "01011",
          yerelBirimAd: "CLI Test Sulh Hukuk Mahkemesi",
          tarihSaat: "2026-09-08 10:00:00.0",
          islemTuru: 1,
          islemSonucu: 0,
          hakimHeyet: 0,
          islemTuruAciklama: "Keşif",
          islemSonucuAciklama: "Günü Verildi",
          dosyaTaraflari: [],
          izinliHakimList: [],
          talepDurumu: "Diğer",
          katilButonAktifMi: false,
          token: "",
          isEDurusmaBirimTalepValid: false,
          isEDurusmaSaatTalepValid: false,
          isEDurusmaGuncellenecek: false,
        },
      ]);
      return;
    }
    if (yol === "/search_phrase_detayli.ajx") {
      const g = JSON.parse(govde || "{}") as {
        birimTuru2?: string;
        birimTuru3?: string;
        dosyaYil?: string;
        dosyaSira?: string;
        birimId?: string;
        pageNumber?: number;
        pageSize?: number;
      };
      const esas = `${g.dosyaYil}/${g.dosyaSira}`;
      const eslesen = this.k.davalar.filter(
        (d) => (!g.dosyaYil || d.esasNo === esas) && (!g.birimId || d.birimId === g.birimId)
          && (g.birimTuru3 === undefined || d.yargiTuru === g.birimTuru3)
      );
      // İÇ İÇE dizi sözleşmesi: [[{dosyaId,...}]]; sayfa dışı → boş
      const sayfa = g.pageNumber ?? 1;
      const boyut = g.pageSize ?? 20;
      const dilim = eslesen.slice((sayfa - 1) * boyut, sayfa * boyut);
      const satirlar = dilim.map((d) => ({
        dosyaId: d.dosyaId,
        birimAdi: d.birimAdi,
        birimId: d.birimId,
        esasNo: d.esasNo,
        dosyaTur: d.dosyaTur,
        dosyaDurumu: d.dosyaDurum,
      }));
      json([[satirlar]]);
      return;
    }
    if (yol === "/list_dosya_evraklar.ajx") {
      const g = JSON.parse(govde || "{}") as { dosyaId?: string; pageNumber?: number };
      const dava = this.k.davalar.find((d) => d.dosyaId === g.dosyaId);
      if (!dava) {
        json({ tumEvraklar: [], son20Evrak: [], pageTotal: 0 });
        return;
      }
      const sayfa = g.pageNumber ?? 1;
      const boyut = 20; // portal sayfa boyutu
      const toplam = Math.max(1, Math.ceil(dava.evraklar.length / boyut));
      if (sayfa > toplam) {
        // sayfa dışı: portal boş döner
        json({ tumEvraklar: [], son20Evrak: [], pageTotal: toplam });
        return;
      }
      // P19 — kimlik dönmesi SAYFA BAŞINA değil TUR BAŞINA sayılır: aynı
      // turun ikinci sayfası da aynı soneki taşır, yoksa tek bir listeleme
      // içinde iki farklı "tur" varmış gibi görünürdü.
      if (dava.kimlikDoner === true && sayfa === 1) this.listeTuru++;
      const sonek = dava.kimlikDoner === true ? `#t${this.listeTuru}` : "";
      const dilim = dava.evraklar.slice((sayfa - 1) * boyut, sayfa * boyut);
      const satirlar = dilim.map((e) => {
        const satir: Record<string, unknown> = {
          evrakId: e.evrakId + sonek,
          tur: e.tur,
          gonderen: e.gonderen,
          tip: e.tip,
          onaylandigiTarih: e.tarih,
          birimEvrakNo: e.birimEvrakNo,
          dosyaAdi: `${e.tur}.${turUzanti(e.contentTipi)}`,
        };
        if (e.anaEvrakId !== undefined) {
          satir["anaEvrakId"] = e.anaEvrakId + sonek;
          satir["ekSira"] = e.ekSira ?? 0;
        }
        return satir;
      });
      // Doğrulanmış biçim: tumEvraklar GRUP OBJESİ (ana / ekler grupları)
      const anaSatirlar = satirlar.filter((s) => (s as { anaEvrakId?: unknown }).anaEvrakId === undefined);
      const ekSatirlar = satirlar.filter((s) => (s as { anaEvrakId?: unknown }).anaEvrakId !== undefined);
      json({
        tumEvraklar: { ana: anaSatirlar, ekler: ekSatirlar },
        son20Evrak: { ana: anaSatirlar.slice(0, 20), ekler: ekSatirlar.slice(0, 20) },
        pageTotal: toplam,
      });
      return;
    }
    if (yol === "/view_document_brd.uyap") {
      const evrakId = query.get("evrakId") ?? "";
      const dosyaId = query.get("dosyaId") ?? "";
      const dava = this.k.davalar.find((d) => d.dosyaId === dosyaId);
      if (!dava) {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "uyapfc_rc": RC_OK });
        res.end("Evrak bulunamadı.");
        return;
      }
      // P19 — dönen kimliğin soneki atılır: gerçek portalda da o turda
      // dönen kimlik indirmede geçerlidir, belge aynı belgedir.
      const cikarilmis = evrakId.replace(/#t\d+$/, "");
      const evrak = dava.evraklar.find((e) => e.evrakId === evrakId || e.evrakId === cikarilmis);
      if (!evrak) {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "uyapfc_rc": RC_OK });
        res.end("Evrak bulunamadı.");
        return;
      }
      if (evrak.durum === "yuklenmemis") {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "uyapfc_rc": RC_OK });
        res.end("Evrak UYAP sistemine yüklenmemiş.");
        return;
      }
      if (evrak.durum === "giris-sayfasi") {
        // oturum ölümü: belge yerine HTML giriş sayfası döner (doğrulanmış)
        res.writeHead(200, { "content-type": "text/html; charset=UTF-8", "uyapfc_rc": RC_OK });
        res.end("<html><body><h1>Giriş Sayfası</h1><p>OTURUMUNUZ SONLANMISTIR. Yeniden giriş yapın.</p></body></html>");
        return;
      }
      if (evrak.durum === "hata") {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end("sunucu hatası");
        return;
      }
      // P19 — "her indirişte yeniden üretilen belge": baytlar değişir,
      // çıkarılan metin AYNI kalır (HTML yorumu dönüşümde atılır).
      const govdeBaytlar =
        evrak.uretimDamgasi === true
          ? Buffer.concat([
              evrak.icerik,
              Buffer.from(`<!-- uretim damgasi ${++this.uretimTuru} -->\n`, "utf8"),
            ])
          : evrak.icerik;
      res.writeHead(200, {
        "content-type": evrak.contentTipi,
        "uyapfc_rc": RC_OK,
        "content-length": String(govdeBaytlar.length),
      });
      res.end(govdeBaytlar);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("bilinmeyen uç");
  }
}

function turUzanti(contentTipi: string): string {
  if (contentTipi.includes("html")) return "html";
  if (contentTipi.includes("pdf")) return "pdf";
  if (contentTipi.includes("jpeg")) return "jpg";
  if (contentTipi.includes("png")) return "png";
  return "udf";
}

/** Opak UYAP token üreticisi — gerçek portaldaki gibi tırnaklı base64 benzeri.
 *  Kararlı (aynı tohum → aynı token) ama çakışmasız. */
export function opakToken(tohum: string): string {
  const ozet = createHash("sha256").update(`uyap-mock:${tohum}`).digest();
  const harf = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789@+";
  let out = '"';
  for (let i = 0; i < 64; i++) {
    out += harf[ozet[i % 32]! * (i + 7) % harf.length]!;
  }
  return out + '"';
}
