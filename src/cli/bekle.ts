import type { Istemci } from "./istemci.js";

const TERMINAL = new Set(["hazir", "eksikli", "kesildi", "hata", "iptal", "duraklatildi"]);

/** İlk durum ve abonelik sonrası nabızlar, kaçırılan bitiş olayını uzlaştırır. */
export async function isiBekle(
  istemci: Pick<Istemci, "cagir" | "akis">,
  isId: string,
  ilerle: (olay: unknown) => void = () => undefined,
): Promise<Record<string, unknown>> {
  const durumOku = async () => (await istemci.cagir("is", { isId })) as Record<string, unknown>;
  const ilk = await durumOku();
  if (TERMINAL.has(String(ilk.durum))) return ilk;
  try {
    for await (const olay of istemci.akis(`/is/${encodeURIComponent(isId)}/izle`)) {
      const o = olay as { tip?: string; veri?: { durum?: string } };
      if (o.tip !== "nabiz") ilerle(olay);
      if (o.tip === "nabiz" || TERMINAL.has(o.veri?.durum ?? "")) {
        const son = await durumOku();
        if (TERMINAL.has(String(son.durum))) return son;
      }
    }
  } catch {
    // Kopan akışın son durumunu RPC üzerinden uzlaştır.
  }
  return durumOku();
}
