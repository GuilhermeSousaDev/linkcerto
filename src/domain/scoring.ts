import { config } from '../infra/config.js';
import { historyFor, type Snapshot } from '../infra/db.js';
import type { Offer } from '../infra/shopee.js';
import { analisarProduto, precoIncompativel, PESO_TIPO, type Produto } from './produto.js';
import { ehInfantil } from './infantil.js';

/**
 * Two modes, chosen automatically per product:
 *
 *   instant  — no price history yet. Falls back to Shopee's declared discount.
 *              Works on the very first run, but vendors inflate "de/por"
 *              anchors, so some of these will not be real bargains.
 *
 *   history  — enough of our own readings to compute a baseline. The discount
 *              is measured against what WE observed, which no vendor can fake.
 *
 * Every run stores snapshots, so products silently graduate from instant to
 * history as the data accumulates. Nothing to switch on.
 */
type Mode = 'instant' | 'history';

export interface Scored {
  offer: Offer;
  score: number;
  mode: Mode;
  discount: number;
  baseline: number | null;
  isLowest: boolean;
  /**
   * Passou pela nota/vendas ou pelo menor preço, não pelo desconto. A mensagem
   * não mostra "de/por" nesse caso: anunciar 5% como promoção queima o grupo.
   */
  semDesconto: boolean;
  /** O que o título diz que o produto é. Ver `produto.ts`. */
  produto: Produto;
  /** null = eligible; otherwise why it was dropped. */
  rejected: string | null;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/** Median after trimming the extremes, so one flash spike can't set the bar. */
function trimmedMedian(values: number[], trim = 0.1): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const cut = Math.floor(s.length * trim);
  const kept = s.length - 2 * cut >= 1 ? s.slice(cut, s.length - cut) : s;
  const mid = Math.floor(kept.length / 2);
  return kept.length % 2 ? kept[mid]! : ((kept[mid - 1]! + kept[mid]!) / 2);
}

function spanDays(snaps: Snapshot[]): number {
  if (snaps.length < 2) return 0;
  const a = new Date(snaps[0]!.capturedAt).getTime();
  const b = new Date(snaps[snaps.length - 1]!.capturedAt).getTime();
  return Math.abs(b - a) / 86_400_000;
}

export function scoreOffer(offer: Offer, snaps: Snapshot[]): Scored {
  const produto = analisarProduto(offer.title, offer.price);
  const base = (rejected: string | null, extra: Partial<Scored> = {}): Scored => ({
    offer,
    score: 0,
    mode: 'instant',
    discount: 0,
    baseline: null,
    isLowest: false,
    semDesconto: false,
    produto,
    rejected,
    ...extra,
  });

  // ── Quality gates, same in both modes ──
  // Primeiro de todos: produto de criança não entra nem com nota perfeita.
  if (ehInfantil(offer.title)) return base('infantil');
  if (offer.rating !== null && offer.rating < config.MIN_RATING) return base('rating_baixo');
  if (offer.sold !== null && offer.sold < config.MIN_SALES) return base('poucas_vendas');
  // Preço real, produto diferente do que o título vende: é o que faz o grupo
  // parar de confiar. Vem antes do desconto porque nenhum desconto conserta.
  const incompativel = precoIncompativel(produto, offer.price);
  if (incompativel) return base(incompativel);

  // ── Pick a mode ──
  const prior = snaps.slice(0, -1).map((s) => s.price); // exclude the current reading
  const hasBaseline =
    snaps.length >= config.BASELINE_MIN_SNAPSHOTS && spanDays(snaps) >= config.BASELINE_MIN_DAYS;

  let mode: Mode;
  let discount: number;
  let baseline: number | null = null;
  let isLowest = false;

  if (hasBaseline) {
    baseline = trimmedMedian(prior);
    if (baseline === null || baseline <= 0) return base('sem_baseline');
    mode = 'history';
    discount = (baseline - offer.price) / baseline;
    isLowest = prior.every((p) => p >= offer.price);
  } else {
    mode = 'instant';
    discount = offer.vendorDiscount ?? 0;
  }

  if (discount > config.MAX_DISCOUNT) return base('desconto_implausivel', { mode, discount });

  // Desconto pequeno não é o fim: produto que todo mundo compra e aprova, ou
  // no menor preço que já medimos, é bom achado mesmo sem "de/por". Só não
  // passa quem está MAIS CARO que o normal — aí não é achado, é preço cheio.
  const consagrado =
    (offer.rating ?? 0) >= config.TOP_RATING && (offer.sold ?? 0) >= config.TOP_SALES;
  const semDesconto = discount < config.MIN_DISCOUNT;
  if (semDesconto && (discount < 0 || !(consagrado || isLowest))) {
    return base(
      mode === 'instant' && offer.vendorDiscount === null ? 'sem_desconto' : 'desconto_pequeno',
      { mode, discount, baseline },
    );
  }

  // ── Score 0-100 ──
  // Com baseline medido o desconto manda, porque é nosso e ninguém falsifica.
  //
  // Sem baseline, o desconto é o `de/por` do próprio vendedor — e ele escolhe
  // esse número. Dar 50 pontos pra isso fazia o ranking ordenar por quem mais
  // inflou a âncora: a lista vinha liderada por -62%, -60%, -58% em produto de
  // R$ 0,10/ml. No modo instant quem manda é a prova social, que depende de
  // gente comprando de verdade. Comissão segue capada de propósito: rankear por
  // pagamento vira spam.
  const w = hasBaseline
    ? { discount: 45, social: 25, commission: 20, lowest: 10 }
    : { discount: 20, social: 55, commission: 25, lowest: 0 };

  const nDiscount = clamp01(discount / 0.5); // 50% off = full marks
  // Rating alone is cheap to fake; weight it by how many people actually bought.
  const confidence = offer.sold ? clamp01(Math.log10(offer.sold + 1) / 4) : 0;
  const nSocial = clamp01(((offer.rating ?? 0) / 5) * confidence);
  const nCommission = clamp01(((offer.commissionRate ?? 0) * offer.price) / 50); // R$50 = full

  const bruto =
    w.discount * nDiscount +
    w.social * nSocial +
    w.commission * nCommission +
    w.lowest * (isLowest ? 1 : 0);

  // O que o produto É entra no ranking, não só no rótulo. Ver `PESO_TIPO`.
  const score = bruto * (produto.categoria ? PESO_TIPO[produto.tipo] : 1);

  return {
    offer,
    score: Number(score.toFixed(1)),
    mode,
    discount,
    baseline,
    isLowest,
    semDesconto,
    produto,
    rejected: null,
  };
}

/**
 * Pontua tudo, melhor primeiro. Os descartados voltam junto, pro `--all`.
 *
 * O histórico do lote inteiro vem numa query só. Antes cada `scoreOffer` ia ao
 * banco sozinho — barato com SQLite síncrono, mas seriam centenas de idas em
 * série agora que o driver é assíncrono.
 */
export async function rank(offers: Offer[]): Promise<Scored[]> {
  const historico = await historyFor(offers.map((o) => o.id));
  return offers
    .map((o) => scoreOffer(o, historico.get(o.id) ?? []))
    .sort((a, b) => b.score - a.score);
}
