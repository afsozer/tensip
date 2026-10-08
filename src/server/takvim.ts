// "Takvime aktar" (P07a) — ekrandaki duruşma satırlarından .ics dosyası
// yazar ve macOS'ta açar. Takvim KENDİ içe aktarma penceresini açar;
// uygulama takvime DOĞRUDAN YAZMAZ, EventKit izni İSTEMEZ, abonelik
// (webcal/CalDAV) ucu AÇMAZ.
//
// PORTALA SIFIR İSTEK: girdi zaten ekranda duran satırlardır, burada hiçbir
// portal çağrısı yoktur ve oturum aranmaz — oturum kapalıyken de çalışır.
//
// DOSYA KULLANICININ ARŞİVİNE KARIŞMAZ: çıktı ayrı bir dışa aktarma
// konumundadır (`<ayar>/disa-aktarma/`), dava klasörlerinin ve manifestin
// dışındadır; ne registry'ye ne manifeste tek bayt yazar. İzinler 0600
// (dizin 0700): duruşma listesi müvekkil bilgisidir, ortak makinede başka
// kullanıcıya açılmaz.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RpcIsleyici } from "./rpc.js";
import type { DosyaAc } from "./belgeler.js";
import { Hata, KODLAR } from "../core/errors.js";
import { yazJsonAtomik } from "../store/fsops.js";
import {
  takvimUret,
  VARSAYILAN_SURE_DK,
  type TakvimDurum,
  type TakvimKaydi,
  type TakvimTarafi,
} from "../store/takvim.js";

export const DISA_AKTARMA_DIZIN = "disa-aktarma";
export const TAKVIM_DOSYA = "ajanda.ics";
export const TAKVIM_DURUM_DOSYA = "takvim-durum.json";
/** Web gövdesi zaten 32 KiB ile sınırlı; bu tavan niyeti açık yazar. */
export const EN_COK_SATIR = 200;

const metin = (deger: unknown, tavan = 300): string =>
  String(deger ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .slice(0, tavan);

function taraflariAl(deger: unknown): TakvimTarafi[] {
  if (!Array.isArray(deger)) return [];
  return deger.slice(0, 20).map((t) => {
    const o = (t ?? {}) as Record<string, unknown>;
    return {
      isim: metin(o["isim"], 120),
      soyad: metin(o["soyad"], 120),
      sifat: metin(o["sifat"], 60),
      isVekil: o["isVekil"] === true,
    };
  });
}

/** İstemciden gelen ham satırı aktarmaya girecek alanlara indirger. */
export function kaydaCevir(ham: unknown): TakvimKaydi {
  const o = (ham ?? {}) as Record<string, unknown>;
  const turHam = Number(o["islemTuru"]);
  return {
    tarihSaat: metin(o["tarihSaat"], 40),
    dosyaNo: metin(o["dosyaNo"], 60),
    yerelBirimAd: metin(o["yerelBirimAd"], 200),
    birimId: metin(o["birimId"], 40),
    islemTuru: Number.isFinite(turHam) ? turHam : undefined,
    islemTuruAciklama: metin(o["islemTuruAciklama"], 120),
    islemSonucuAciklama: metin(o["islemSonucuAciklama"], 200),
    dosyaTurKodAciklama: metin(o["dosyaTurKodAciklama"], 120),
    dosyaTaraflari: taraflariAl(o["dosyaTaraflari"]),
  };
}

export function disaAktarmaDizini(ayarDir: string): string {
  return join(ayarDir, DISA_AKTARMA_DIZIN);
}

/** Bozuk/eksik durum dosyası aktarmayı DÜŞÜRMEZ: boş durumla devam edilir. */
export function durumOku(dosya: string): TakvimDurum {
  try {
    const ham = JSON.parse(readFileSync(dosya, "utf8")) as unknown;
    const o = (ham ?? {}) as Record<string, unknown>;
    if (o["surum"] !== 1 || !Array.isArray(o["etkinlikler"]))
      return { surum: 1, etkinlikler: [] };
    const etkinlikler = (o["etkinlikler"] as unknown[])
      .map((e) => (e ?? {}) as Record<string, unknown>)
      .filter(
        (e) =>
          typeof e["uid"] === "string" &&
          typeof e["taban"] === "string" &&
          typeof e["dtstart"] === "string",
      )
      .map((e) => ({
        uid: String(e["uid"]),
        taban: String(e["taban"]),
        dtstart: String(e["dtstart"]),
        sequence: Number.isFinite(Number(e["sequence"])) ? Number(e["sequence"]) : 0,
        at: String(e["at"] ?? ""),
      }));
    return { surum: 1, etkinlikler };
  } catch {
    return { surum: 1, etkinlikler: [] };
  }
}

/** Ev dizinini `~` ile kısaltır; arayüzde tam yol yerine bu gösterilir. */
export function kisaYol(yol: string, ev = homedir()): string {
  return ev && yol.startsWith(ev) ? `~${yol.slice(ev.length)}` : yol;
}

export function takvimIsleyicileri(
  ayarDir: string,
  dosyaAc: DosyaAc,
  simdiVer: () => Date = () => new Date(),
): Map<string, RpcIsleyici> {
  return new Map<string, RpcIsleyici>([
    [
      "takvime-aktar",
      async (g) => {
        const ham = g["durusmalar"];
        if (!Array.isArray(ham) || ham.length === 0)
          throw new Hata(
            KODLAR.INVALID_INPUT,
            "Aktarılacak duruşma satırı gönderilmedi.",
          );
        if (ham.length > EN_COK_SATIR)
          throw new Hata(
            KODLAR.INVALID_INPUT,
            `Tek seferde en çok ${EN_COK_SATIR} kayıt aktarılabilir.`,
          );
        // YOL İSTEMCİDEN GELMEZ: hedef her zaman dışa aktarma konumudur.
        // Gövdedeki "yol"/"hedef" gibi alanlar okunmaz bile.
        const dizin = disaAktarmaDizini(ayarDir);
        const durumDosyasi = join(dizin, TAKVIM_DURUM_DOSYA);
        const sonuc = takvimUret(ham.map(kaydaCevir), {
          simdi: simdiVer(),
          taraflariEkle: g["taraflariEkle"] === true,
          sureDk: VARSAYILAN_SURE_DK,
          durum: durumOku(durumDosyasi),
        });
        if (sonuc.etkinlikler.length === 0)
          throw new Hata(
            KODLAR.INVALID_INPUT,
            `Aktarılabilecek kayıt yok. ${sonuc.atlananlar[0]?.sebep ?? ""}`.trim(),
          );
        mkdirSync(dizin, { recursive: true, mode: 0o700 });
        try {
          chmodSync(dizin, 0o700);
        } catch {
          /* platform */
        }
        const yol = join(dizin, TAKVIM_DOSYA);
        // Var olan dosyanın izni writeFileSync'in `mode`una bakmaz; içerik
        // yazılmadan ÖNCE daraltılır ki eski gevşek izinli bir dosya yeni
        // içeriği bir an bile açıkta tutmasın.
        if (existsSync(yol)) {
          try {
            chmodSync(yol, 0o600);
          } catch {
            /* platform */
          }
        }
        writeFileSync(yol, sonuc.ics, { encoding: "utf8", mode: 0o600 });
        try {
          chmodSync(yol, 0o600);
        } catch {
          /* platform */
        }
        yazJsonAtomik(durumDosyasi, sonuc.durum, 0o600);
        // Dosya YAZILDI. Açma başarısız olursa bütün işlem düşmez: kullanıcı
        // dosyayı kendi de açabilir, yolu yanıtta duruyor.
        let acildi = true;
        let acmaHatasi: string | undefined;
        try {
          await dosyaAc(yol);
        } catch (e) {
          acildi = false;
          acmaHatasi =
            e instanceof Error ? e.message : "Dosya Takvim ile açılamadı.";
        }
        return {
          yol,
          kisaYol: kisaYol(yol),
          dosyaAdi: TAKVIM_DOSYA,
          adet: sonuc.etkinlikler.length,
          yinelenen: sonuc.yinelenen,
          sureDk: sonuc.sureDk,
          taraflariEkle: sonuc.taraflariEkle,
          etkinlikler: sonuc.etkinlikler.map((e) => ({
            uid: e.uid,
            dtstart: e.dtstart,
            sequence: e.sequence,
            baslik: e.baslik,
            yeni: e.yeni,
            ertelendi: e.ertelendi,
          })),
          guncellenen: sonuc.etkinlikler.filter((e) => e.ertelendi).length,
          atlananlar: sonuc.atlananlar,
          uyarilar: sonuc.uyarilar,
          acildi,
          acmaHatasi,
        };
      },
    ],
  ]);
}
