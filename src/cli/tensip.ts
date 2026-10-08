// `tensip` — Tensip CLI istemcisi.
//
// Çıktı sözleşmesi (ajan öncelikli):
//   • stdout: tek JSON. İSTİSNA: `izle` NDJSON akıtır.
//   • stderr: ilerleme/log NDJSON. stdout ASLA kirlenmez → `tensip … | jq`.
//   • çıkış kodu: errors.ts tablosu (ajan `if [ $? -eq 5 ]` ile dallanır).

import { cikisKodu } from "../core/errors.js";
import { argAyristir } from "./argumanlar.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { istemciYap, kontrolDizini, CliHata } from "./istemci.js";
import { isiBekle } from "./bekle.js";
import { davaRefCoz } from "./dava-cozucu.js";

const cik = (v: unknown) => process.stdout.write(`${JSON.stringify(v)}\n`);
const log = (v: unknown) => process.stderr.write(`${JSON.stringify(v)}\n`);

const KOMUT_YARDIM: Record<string, string> = {
  durum: "daemon/oturum/fren durumu",
  davalarim: "--birim \"X Mahkemesi\" --yil 2026 --sira 138 [--kapsam acik|kapali|hepsi]",
  davalar: "klonlanmış davalar (klonYolu dâhil); motor kapalıyken de çalışır",
  klonla: "--birim \"X Mahkemesi\" --esas 2026/928 [--kapsam ...] [--avukat \"Ad Soyad\"] [--arka-plan]",
  esitle: "--dava \"Birim Adı YYYY-SIRA\" | --caseKey ... [--arka-plan] (toplu eşitleme uygulama penceresinden yapılır)",
  evraklar: "--dava \"Birim Adı YYYY-SIRA\" [--kategori 02-Dilekceler]",
  detay: "--dava ...",
  yol: "--dava \"çamlık asliye hukuk\" | \"Birim Adı YYYY-SIRA\" — dava klasörünün disk yolu; motor kapalıyken de çalışır",
  safahat: "--dava \"Birim Adı YYYY-SIRA\" — dosya safahatı (UYAP: 60 dk'da 1 kez)",
  taraflar: "--dava \"Birim Adı YYYY-SIRA\" — dosya tarafları",
  hesap: "--dava \"Birim Adı YYYY-SIRA\" — hesap bilgileri",
  durusmalar: "[--gun 7] — yaklaşan duruşma/keşif takvimi",
  sorunlar: "[--islem yoksay|vazgec --sorunId srn-...]",
  sadelestir:
    "--dava \"Birim Adı YYYY-SIRA\" [--yol \"…\"] [--onayla] — aynı belgenin mükerrer manifest satırlarını düşürür; --yol VERİLİRSE yalnız o satırın grubu, verilmezse davanın tamamı sadeleşir. --onayla YOKSA yalnız plan yazar, hiçbir şey değişmez",
  onar:
    "--dava \"Birim Adı YYYY-SIRA\" --yol \"_kaynak/evraklar/...\" [--eylem metin|kaynak] [--onayla] [--arka-plan] — denetimin bulduğu TEK satırı onarır; metin ağsızdır, kaynak oturum ister. --onayla YOKSA yalnız plan yazar",
  isler: "tüm işler",
  is: "--isId is-...",
  iptal: "--isId is-...",
  duraklat: "--isId is-...",
  devam: "--isId is-... (duraklatılmış işi sürdürür)",
  giris: "--cdp | --cerez \"document.cookie çıktısı\" | --cerez-dosya dosya.txt",
  cikis: "oturumu kapat",
  izle: "olay akışı (NDJSON)",
  bekle: "--isId is-... (iş terminal duruma gelene kadar; ilerleme stderr'e)",
  semasi: "komut şeması",
  rpc: "<ad> '<json>' — doğrudan rpc çağrısı",
  tani: "sürüm, çalışan kaynak, bağımlılık ve arşiv tanılaması (sırsız)",
  surum: "paket sürümü + çalışan kaynağın dalı/commit'i (daemon gerekmez)",
};

type YerelDava = { caseKey: string; birimAdi: string; dosyaNo: string; klonYolu?: string };

/** Dava kaydı listesi. Motor YOKSA (yalnız APP_GONE) registry diskten SALT-OKUNUR
 *  okunur: "bu dosyanın klasörü nerede" sorusu motorun açık olmasına bağlı
 *  olmamalı. Başka hiçbir komut bu yoldan geçmez; yazma, portal, oturum yok. */
async function davalariOku(
  istemci: ReturnType<typeof istemciYap>,
  ayarDir: string | undefined,
): Promise<{ davalar: YerelDava[]; motor: boolean }> {
  try {
    const data = (await istemci.cagir("davalar", {})) as { davalar: YerelDava[] };
    return { davalar: data.davalar, motor: true };
  } catch (e) {
    if (!(e instanceof CliHata) || e.code !== "APP_GONE") throw e;
    let ham: unknown;
    try {
      ham = JSON.parse(readFileSync(join(kontrolDizini(ayarDir), "davalarim.json"), "utf8"));
    } catch {
      throw e; // registry de okunamıyorsa asıl haber "motor yok"tur
    }
    const o = ham as { surum?: unknown; davalar?: unknown } | null;
    if (o === null || o.surum !== 1 || !Array.isArray(o.davalar)) throw e;
    return { davalar: o.davalar as YerelDava[], motor: false };
  }
}

/** "--dava "Birim Adı 2026-928" → caseKey (registry'den).
 *  Çözüm kuralı src/cli/dava-cozucu.ts'tedir: belirsiz eşleşmede ilk aday
 *  SESSİZCE SEÇİLMEZ, adaylar sayılır ve kullanıcıya gösterilir (T05). */
async function davaRefToCaseKey(istemci: ReturnType<typeof istemciYap>, dava: string): Promise<string> {
  const data = (await istemci.cagir("davalar", {})) as { davalar: YerelDava[] };
  return davaRefCoz(data.davalar, dava);
}

async function main(): Promise<number> {
  const [komut, ...kalan] = process.argv.slice(2);
  if (komut === undefined || komut === "--yardim" || komut === "yardim" || komut === "--help") {
    cik({
      komutlar: Object.keys(KOMUT_YARDIM),
      kullanim: KOMUT_YARDIM,
      cikti: "stdout: tek JSON (izle: NDJSON); stderr: log NDJSON; çıkış kodu: 0 ok, 1 hata, 2 girdi, 3 daemon yok, 4 kota, 5 giriş, 6 meşgul, 7 port dolu",
    });
    return komut === undefined ? 2 : 0;
  }
  const arg = argAyristir(kalan);
  const ayarDir = typeof arg.bayrak["ayar"] === "string" ? arg.bayrak["ayar"] : undefined;
  const istemci = istemciYap(ayarDir);

  const arkaPlan = arg.bayrak["arka-plan"] === true;

  try {
    switch (komut) {
      case "izle": {
        for await (const olay of istemci.akis("/olaylar")) cik(olay);
        return 0;
      }
      case "semasi": {
        cik(await istemci.get("/semasi"));
        return 0;
      }
      case "bekle": {
        const isId = (arg.bayrak["isId"] as string) ?? arg.konum[0];
        if (typeof isId !== "string" || isId === "") {
          log({ hata: "kullanım: tensip bekle <isId>" });
          return 2;
        }
        const son = await isiBekle(istemci, isId, log);
        cik(son);
        return son.durum === "hazir" ? 0 : cikisKodu((son.hata as { code?: string } | undefined)?.code ?? "INTERNAL");
      }
      case "rpc": {
        const ad = arg.konum[0];
        if (ad === undefined) {
          log({ hata: "kullanım: tensip rpc <ad> [json]" });
          return 2;
        }
        const govde = arg.konum[1] === undefined ? {} : JSON.parse(arg.konum[1]);
        cik(await istemci.cagir(ad, govde));
        return 0;
      }
      case "giris": {
        const govde: Record<string, unknown> = {};
        if (arg.bayrak["cdp"] === true) {
          govde["cdp"] = true;
          if (typeof arg.bayrak["zaman-asimi"] === "string") {
            govde["cdpZamanAsimi"] = Number(arg.bayrak["zaman-asimi"]);
          }
        } else if (typeof arg.bayrak["cerez"] === "string") {
          govde["cerez"] = arg.bayrak["cerez"];
        } else if (typeof arg.bayrak["cerez-dosya"] === "string") {
          govde["cerezDosya"] = arg.bayrak["cerez-dosya"];
        } else {
          log({ hata: "kullanım: tensip giris --cdp | --cerez '...' | --cerez-dosya dosya.txt" });
          return 2;
        }
        const son = (await istemci.cagir("giris", govde)) as { yontem: string };
        cik({ ok: true, yontem: son.yontem });
        return 0;
      }
      case "cikis": {
        cik(await istemci.cagir("cikis", {}));
        return 0;
      }
      case "durusmalar": {
        const gun = typeof arg.bayrak["gun"] === "string" ? Number(arg.bayrak["gun"]) : 7;
        cik(await istemci.cagir("durusmalar", { gun: String(Number.isFinite(gun) ? gun : 7) }));
        return 0;
      }
      case "safahat":
      case "taraflar":
      case "hesap": {
        const dava = arg.bayrak["dava"];
        if (typeof dava !== "string") {
          log({ hata: `kullanım: tensip ${komut} --dava "Birim Adı YYYY-SIRA"` });
          return 2;
        }
        const caseKey = await davaRefToCaseKey(istemci, dava);
        cik(await istemci.cagir(komut, { caseKey }));
        return 0;
      }
      case "davalarim": {
        const birim = arg.bayrak["birim"];
        if (typeof birim !== "string") {
          log({ hata: "kullanım: tensip davalarim --birim \"X Mahkemesi\" --yil 2026 --sira 138" });
          return 2;
        }
        cik(
          await istemci.cagir("davalarim", {
            birim,
            yil: String(arg.bayrak["yil"] ?? ""),
            sira: String(arg.bayrak["sira"] ?? ""),
            kapsam: arg.bayrak["kapsam"] ?? "hepsi",
          })
        );
        return 0;
      }
      case "klonla": {
        const birim = arg.bayrak["birim"];
        const esas = arg.bayrak["esas"];
        if (typeof birim !== "string" || typeof esas !== "string") {
          log({ hata: "kullanım: tensip klonla --birim \"X Mahkemesi\" --esas 2026/928" });
          return 2;
        }
        const son = (await istemci.cagir("klonla", {
          birim,
          esas,
          kapsam: arg.bayrak["kapsam"] ?? "kapali",
          avukat: arg.bayrak["avukat"],
        })) as { isId: string };
        if (arkaPlan) {
          cik(son);
          return 0;
        }
        const d = await isiBekle(istemci, son.isId, log);
        cik(d);
        return d.durum === "hazir" ? 0 : cikisKodu((d.hata as { code?: string } | undefined)?.code ?? "INTERNAL");
      }
      case "esitle": {
        // T04 — `--hepsi` yardımda YILLARDIR vaat ediliyordu ama kodda hiç
        // okunmuyordu: `tensip esitle --hepsi` hedefi undefined bırakıp çıkış 2
        // veriyor, bastığı kullanım satırı yine `--hepsi` vaat ediyordu.
        // Vaat SESSİZCE DÜZELTİLMEDİ, AÇIKÇA REDDEDİLİYOR. Toplu eşitlemenin
        // bir CLI komutu YOKTUR ve bu pakette eklenmedi (kullanıcı kararı):
        // sıra kuralları, seçim ve duraklatma uygulama penceresindedir.
        if (arg.bayrak["hepsi"] !== undefined) {
          log({
            hata:
              "--hepsi uygulanmadı ve kaldırıldı. Toplu eşitleme uygulama penceresinden yapılır: İndirilenler ekranında dosyaları seçip toplu eşitlemeyi başlatın. Tek dosya için: tensip esitle --dava \"Birim Adı YYYY-SIRA\"",
          });
          return 2;
        }
        const dava = arg.bayrak["dava"];
        const caseKey = arg.bayrak["caseKey"];
        const hedef =
          typeof caseKey === "string"
            ? caseKey
            : typeof dava === "string"
              ? await davaRefToCaseKey(istemci, dava)
              : undefined;
        if (hedef === undefined) {
          log({ hata: "kullanım: tensip esitle --dava \"Birim Adı YYYY-SIRA\" | --caseKey ..." });
          return 2;
        }
        const son = (await istemci.cagir("esitle", { caseKey: hedef })) as { isId: string };
        if (arkaPlan) {
          cik(son);
          return 0;
        }
        const d = await isiBekle(istemci, son.isId, log);
        cik(d);
        return d.durum === "hazir" ? 0 : cikisKodu((d.hata as { code?: string } | undefined)?.code ?? "INTERNAL");
      }
      case "evraklar": {
        const dava = arg.bayrak["dava"];
        if (typeof dava !== "string") {
          log({ hata: "kullanım: tensip evraklar --dava \"Birim Adı YYYY-SIRA\" [--kategori 02-Dilekceler]" });
          return 2;
        }
        const caseKey = await davaRefToCaseKey(istemci, dava);
        cik(await istemci.cagir("evraklar", { caseKey, kategori: arg.bayrak["kategori"] }));
        return 0;
      }
      case "detay": {
        const dava = arg.bayrak["dava"];
        if (typeof dava !== "string") {
          log({ hata: "kullanım: tensip detay --dava \"Birim Adı YYYY-SIRA\"" });
          return 2;
        }
        const caseKey = await davaRefToCaseKey(istemci, dava);
        cik(await istemci.cagir("detay", { caseKey }));
        return 0;
      }
      case "yol": {
        const dava = arg.bayrak["dava"];
        if (typeof dava !== "string") {
          log({ hata: "kullanım: tensip yol --dava \"Birim Adı YYYY-SIRA\"" });
          return 2;
        }
        const { davalar, motor } = await davalariOku(istemci, ayarDir);
        const caseKey = davaRefCoz(davalar, dava);
        const kayit = davalar.find((d) => d.caseKey === caseKey);
        if (!kayit?.klonYolu) throw new CliHata("NOT_FOUND", "klonlanmamış dava");
        cik({ yol: kayit.klonYolu, caseKey, dava: `${kayit.birimAdi} ${kayit.dosyaNo}`, motor });
        return 0;
      }
      case "sorunlar": {
        const islem = arg.bayrak["islem"];
        const sorId = arg.bayrak["sorunId"];
        const govde: Record<string, unknown> = {};
        if (typeof islem === "string") govde["islem"] = islem;
        if (typeof sorId === "string") govde["sorunId"] = sorId;
        cik(await istemci.cagir("sorunlar", govde));
        return 0;
      }
      // P19b — SADELEŞTİRME. Varsayılan KURU ÇALIŞMADIR: `--onayla`
      // verilmedikçe manifeste tek bayt yazılmaz, yalnız plan döner.
      // Uygulandığında manifest önce yedeklenir ve BELGE DOSYASI SİLİNMEZ
      // (gerekçe: src/store/sadelestir.ts).
      case "sadelestir": {
        const dava = arg.bayrak["dava"];
        const yol = arg.bayrak["yol"];
        if (typeof dava !== "string" || (yol !== undefined && typeof yol !== "string")) {
          log({
            hata: 'kullanım: tensip sadelestir --dava "Birim Adı YYYY-SIRA" [--yol "…"] [--onayla]',
          });
          return 2;
        }
        const caseKey = await davaRefToCaseKey(istemci, dava);
        const onay = arg.bayrak["onayla"] === true || arg.bayrak["onayla"] === "true";
        // `--yol` YALNIZ o satırın grubunu sadeleştirir; verilmezse kapsam
        // davanın tamamıdır (denetim raporu bu farkı satırda yazar).
        cik(
          await istemci.cagir("sadelestir", {
            caseKey,
            onay,
            ...(typeof yol === "string" ? { yol } : {}),
          }),
        );
        return 0;
      }
      // P06b — SEÇİLİ ONARIM. Varsayılan KURU ÇALIŞMADIR: `--onayla`
      // verilmedikçe tek bayt değişmez, yalnız YENİDEN ÖLÇÜLMÜŞ plan döner.
      // `--eylem metin` ağsızdır (oturum istemez, portala istek atmaz);
      // `--eylem kaynak` bir İŞ başlatır ve bu komut işi bekler.
      case "onar": {
        const dava = arg.bayrak["dava"];
        const yol = arg.bayrak["yol"];
        const eylem = arg.bayrak["eylem"] ?? "metin";
        if (typeof dava !== "string" || typeof yol !== "string" || (eylem !== "metin" && eylem !== "kaynak")) {
          log({
            hata:
              'kullanım: tensip onar --dava "Birim Adı YYYY-SIRA" --yol "_kaynak/evraklar/..." [--eylem metin|kaynak] [--onayla]',
          });
          return 2;
        }
        const caseKey = await davaRefToCaseKey(istemci, dava);
        const onay = arg.bayrak["onayla"] === true || arg.bayrak["onayla"] === "true";
        const son = (await istemci.cagir("onar", { caseKey, yol, eylem, onay })) as {
          isId?: string;
        };
        if (typeof son.isId !== "string" || arkaPlan) {
          cik(son);
          return 0;
        }
        const d = await isiBekle(istemci, son.isId, log);
        cik({ ...son, is: d });
        return d.durum === "hazir" ? 0 : cikisKodu((d.hata as { code?: string } | undefined)?.code ?? "INTERNAL");
      }
      case "isler": {
        cik(await istemci.cagir("isler", {}));
        return 0;
      }
      case "is":
      case "iptal":
      case "duraklat":
      case "devam": {
        const isId = arg.bayrak["isId"] ?? arg.konum[0];
        if (typeof isId !== "string") {
          log({ hata: `kullanım: tensip ${komut} --isId is-...` });
          return 2;
        }
        cik(await istemci.cagir(komut, { isId }));
        return 0;
      }
      case "davalar": {
        cik(await davalariOku(istemci, ayarDir));
        return 0;
      }
      case "durum": {
        cik(await istemci.cagir("durum", {}));
        return 0;
      }
      case "tani": {
        cik(await istemci.cagir("tani", {}));
        return 0;
      }
      case "surum": {
        // Daemon GEREKMEZ: "hangi kod duruyor" sorusu motor kapalıyken de
        // sorulur. Yalnız dosya okunur; git binary'si çalıştırılmaz.
        const { paketSurumu, surumBilgisi, gitKimligi, kaynakKoku, derlemeDurumu } =
          await import("../core/surum.js");
        const git = gitKimligi();
        cik({
          surum: paketSurumu(),
          surumKaynagi: surumBilgisi().kaynak,
          calisanKok: kaynakKoku().replace(/\/$/, ""),
          dal: git?.dal ?? null,
          commit: git?.commit ?? null,
          derleme: derlemeDurumu(),
        });
        return 0;
      }
      default:
        log({ hata: `bilinmeyen komut: ${komut}`, yardim: "tensip --yardim" });
        return 2;
    }
  } catch (e) {
    const kod = e instanceof CliHata ? e.code : "INTERNAL";
    const mesaj = e instanceof Error ? e.message : String(e);
    const detay = e instanceof CliHata ? e.details : undefined;
    log({ hata: { code: kod, message: mesaj, ...(detay !== undefined ? { sebep: detay } : {}) } });
    return cikisKodu(kod);
  }
}

const kod = await main();
process.exitCode = kod;
