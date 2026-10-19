import { config } from '../infra/config.js';
import { historyFor, type Snapshot } from '../infra/db.js';
import type { LinkAfiliado, Offer } from '../infra/shopee.js';
import { analisarProduto, precoIncompativel, PESO_TIPO, type Produto } from './produto.js';
import { ehInfantil } from './infantil.js';

/**
 * Curadoria: "esse produto merece aparecer no grupo?"
 *
 * Não é um caçador de maior desconto. Cada produto que passa pelos filtros sai
 * com um TIPO, que é o que a mensagem pode afirmar sobre ele:
 *
 *   oferta       queda real, medida contra o NOSSO histórico de preço.
 *   menor_preco  o menor preço que já registramos, mesmo com queda pequena.
 *   achado       sem queda verificada, mas com prova social forte e sem estar
 *                mais caro que o normal. Nunca é vendido como promoção.
 *
 * Dois modos de leitura de preço, escolhidos sozinhos por produto:
 *
 *   history  — leituras suficientes pra um baseline. O desconto é o que NÓS
 *              medimos, que nenhum vendedor falsifica.
 *   instant  — sem baseline ainda. O "de/por" da loja é só dado auxiliar: o
 *              produto só entra como ACHADO, pela prova social.
 *
 * Toda rodada grava leituras, então os produtos passam de instant pra history
 * conforme os dados acumulam. Nada pra ligar.
 */
type Mode = 'instant' | 'history';

export type DealType = 'oferta' | 'menor_preco' | 'achado';

/**
 * As partes do score, cada uma 0-100. É o que explica por que uma oferta
 * ganhou de outra — ver `motivo` e o `--all`.
 */
export interface Componentes {
  /** Confiabilidade: tipo do produto, faixa de variações, âncora inflada. Multiplica o resto. */
  quality: number;
  /** Queda de preço. Medida no histórico; sem histórico, a da loja pela metade. */
  price: number;
  /** Nota ajustada pelo volume de vendas. */
  social: number;
  /** 100 quando é o menor preço que já medimos. */
  lowest: number;
  /** Valor da comissão em R$. Critério secundário — ver `scoreOffer`. */
  commission: number;
}

export interface Scored {
  offer: Offer;
  score: number;
  mode: Mode;
  /** Com histórico, o desconto medido; sem, o declarado pela loja. Ver `realDiscount`. */
  discount: number;
  /** Desconto contra o nosso baseline. `null` sem histórico — aí não há o que afirmar. */
  realDiscount: number | null;
  baseline: number | null;
  isLowest: boolean;
  /** null enquanto rejeitado. */
  dealType: DealType | null;
  /**
   * Não é OFERTA: entrou pela nota/vendas ou pelo menor preço. A mensagem não
   * mostra "de/por" nesse caso — anunciar 5% como promoção queima o grupo.
   */
  semDesconto: boolean;
  componentes: Componentes;
  /** Uma linha legível: o que fez esse produto entrar e pontuar. */
  motivo: string;
  /**
   * Preço do último envio pro grupo, quando ele volta por ter caído de novo.
   * Preenchido em `grupo.naoRepetidas`, não aqui.
   */
  reenvioDe?: number;
  /** Link de afiliado emitido pro canal desta rodada. Ver `ofertas.garantirLinks`. */
  link?: LinkAfiliado;
  /** O que o título diz que o produto é. Ver `produto.ts`. */
  produto: Produto;
  /** null = eligible; otherwise why it was dropped. */
  rejected: string | null;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const pct = (n: number) => `${Math.round(n * 100)}%`;
const reais = (v: number) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);

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

/**
 * Prova social 0-100: nota E vendas, nunca a nota sozinha.
 *
 * A nota é puxada pra 4,0 com o peso de 50 vendas (média bayesiana): 5,0 com
 * 3 vendas vira ~4,06, enquanto 4,8 com 8.000 fica ~4,8. A confiança cresce
 * aos poucos com as vendas, em vez de virar de zero pra cem num limiar. O
 * volume entra também sozinho, em log — 10.000 vendas = cheio.
 */
const NOTA_PRIOR = 4.0;
const PESO_PRIOR = 50;

export function socialScore(rating: number | null, sold: number | null): number {
  const n = Math.max(0, sold ?? 0);
  const r = rating ?? NOTA_PRIOR;
  const ajustada = (n * r + PESO_PRIOR * NOTA_PRIOR) / (n + PESO_PRIOR);
  const nota = clamp01((ajustada - NOTA_PRIOR) / (5 - NOTA_PRIOR));
  const volume = clamp01(Math.log10(n + 1) / 4);
  return 100 * (0.65 * nota + 0.35 * volume);
}

/**
 * Pesos do mérito por tipo. Comissão fica de fora daqui de propósito.
 *
 * OFERTA e MENOR PREÇO têm preço medido, então o preço manda. ACHADO não tem
 * nada verificado sobre preço: a prova social manda e o teto é mais baixo (70
 * contra 85) — um achado só passa uma oferta medida se for bem melhor nela.
 */
const PESOS: Record<DealType, { price: number; social: number; lowest: number }> = {
  oferta: { price: 45, social: 25, lowest: 15 },
  menor_preco: { price: 45, social: 25, lowest: 15 },
  achado: { price: 20, social: 50, lowest: 0 },
};
const MERITO_MAX = 85;
/** Teto da comissão. Ela é escalada pelo mérito: comissão não salva produto fraco. */
const PESO_COMISSAO = 15;

/** Abaixo disto de queda, "menor preço" é preço parado, não notícia. */
const QUEDA_MIN_MENOR_PRECO = 0.03;
/** Loja anuncia X%, medimos Y%: acima desta diferença a âncora é inflada. */
const GAP_ANCORA = 0.25;

/**
 * `pedido`: busca sob demanda (`npm run buscar`). Os filtros de qualidade são
 * os MESMOS — produto ruim não passa porque alguém pediu. O que muda é só a
 * última pergunta: no grupo é "isso merece ser empurrado pra todo mundo?"
 * (exige oferta, menor preço ou achado); num pedido é "isso atende bem quem
 * pediu?". Produto bom sem destaque de preço volta com `dealType` null.
 */
export function scoreOffer(
  offer: Offer,
  snaps: Snapshot[],
  opts: { pedido?: boolean } = {},
): Scored {
  const produto = analisarProduto(offer.title, offer.price);
  const social = socialScore(offer.rating, offer.sold);
  const base = (rejected: string | null, extra: Partial<Scored> = {}): Scored => ({
    offer,
    score: 0,
    mode: 'instant',
    discount: 0,
    realDiscount: null,
    baseline: null,
    isLowest: false,
    dealType: null,
    semDesconto: true,
    componentes: { quality: 0, price: 0, social, lowest: 0, commission: 0 },
    motivo: '',
    produto,
    rejected,
    ...extra,
  });

  // ── Filtros de qualidade, iguais nos dois modos ──
  // Primeiro de todos: produto de criança não entra nem com nota perfeita.
  if (ehInfantil(offer.title)) return base('infantil');
  if (offer.rating !== null && offer.rating < config.MIN_RATING) return base('rating_baixo');
  if (offer.sold !== null && offer.sold < config.MIN_SALES) return base('poucas_vendas');
  // Preço real, produto diferente do que o título vende: é o que faz o grupo
  // parar de confiar. Vem antes do desconto porque nenhum desconto conserta.
  const incompativel = precoIncompativel(produto, offer.price);
  if (incompativel) return base(incompativel);

  // ── Preço: o que dá pra afirmar ──
  const prior = snaps.slice(0, -1).map((s) => s.price); // exclude the current reading
  const hasBaseline =
    snaps.length >= config.BASELINE_MIN_SNAPSHOTS && spanDays(snaps) >= config.BASELINE_MIN_DAYS;

  const mode: Mode = hasBaseline ? 'history' : 'instant';
  let baseline: number | null = null;
  let realDiscount: number | null = null;
  let isLowest = false;

  if (hasBaseline) {
    baseline = trimmedMedian(prior);
    if (baseline === null || baseline <= 0) return base('sem_baseline');
    realDiscount = (baseline - offer.price) / baseline;
    // Igual ao menor E abaixo do normal: produto de preço parado seria "menor
    // preço" toda rodada, e isso não é notícia pra ninguém.
    isLowest = offer.price <= Math.min(...prior) && realDiscount >= QUEDA_MIN_MENOR_PRECO;
  }

  const discount = realDiscount ?? offer.vendorDiscount ?? 0;
  const extra = { mode, discount, realDiscount, baseline, isLowest };
  if (discount > config.MAX_DISCOUNT) return base('desconto_implausivel', extra);

  // Sem baseline ainda, mas com algumas leituras: já dá pra dizer se está
  // mais caro que o de costume. Achado em preço cheio não é achado.
  if (!hasBaseline && prior.length) {
    const visto = trimmedMedian(prior)!;
    if (offer.price > visto * 1.03) return base('acima_do_historico', extra);
  }
  if (realDiscount !== null && realDiscount < 0) return base('acima_do_normal', extra);

  // ── Tipo ──
  const consagrado =
    (offer.rating ?? 0) >= config.TOP_RATING && (offer.sold ?? 0) >= config.TOP_SALES;

  let dealType: DealType | null;
  if (realDiscount !== null && realDiscount >= config.MIN_DISCOUNT) dealType = 'oferta';
  else if (isLowest) dealType = 'menor_preco';
  else if (consagrado) dealType = 'achado';
  else if (opts.pedido) dealType = null;
  else return base(hasBaseline ? 'desconto_pequeno' : 'prova_social_fraca', extra);

  // ── Componentes ──
  const notas: string[] = [];
  let quality = 1;

  // Perfume: o que ele É (original, contratipo, refil…). Ver `PESO_TIPO`.
  if (produto.categoria) {
    quality *= PESO_TIPO[produto.tipo];
    if (produto.tipo !== 'original') notas.push(produto.tipo.replace('_', ' '));
  }

  // Faixa de variações larga: o preço anunciado é o da variação mais barata,
  // e quanto maior a distância mais gente chega na página e acha outro número.
  if (offer.priceMax !== null && offer.priceMax / offer.price > 1.5) {
    quality *= Math.max(0.6, 1 - (offer.priceMax / offer.price - 1.5) * 0.2);
    notas.push(`variações até ${reais(offer.priceMax)}`);
  }

  // A loja diz 70%, medimos 18%: a âncora dela é inflada — sinal de que o
  // preço do vendedor não é confiável, mesmo com queda real.
  const vd = offer.vendorDiscount;
  if (realDiscount !== null && vd !== null && vd - realDiscount > GAP_ANCORA) {
    quality *= Math.max(0.6, 1 - (vd - realDiscount - GAP_ANCORA));
    notas.push(`loja anuncia ${pct(vd)}, medimos ${pct(realDiscount)}`);
  }
  // Sem histórico, desconto anunciado enorme é mais isca que promoção.
  if (realDiscount === null && vd !== null && vd >= 0.6) {
    quality *= 0.85;
    notas.push(`loja anuncia ${pct(vd)} (não verificado)`);
  }

  // Desconto: o medido vale inteiro (50% = cheio). O da loja vale metade —
  // ele é dado auxiliar, não prova.
  const price =
    realDiscount !== null ? 100 * clamp01(realDiscount / 0.5) : 50 * clamp01((vd ?? 0) / 0.5);
  const lowest = isLowest ? 100 : 0;
  // R$ 50 de comissão = cheio.
  const commission = 100 * clamp01(((offer.commissionRate ?? 0) * offer.price) / 50);

  // Sem tipo (só no pedido): pesa como achado — nada verificado sobre preço.
  const w = PESOS[dealType ?? 'achado'];
  const merito = (w.price * price + w.social * social + w.lowest * lowest) / 100;
  // Comissão é desempate, não mérito: escalada pelo próprio mérito, um
  // produto fraco não sobe por pagar mais.
  const comissao = (PESO_COMISSAO * commission * (merito / MERITO_MAX)) / 100;
  const score = (merito + comissao) * quality;

  return {
    offer,
    score: Number(score.toFixed(1)),
    mode,
    discount,
    realDiscount,
    baseline,
    isLowest,
    dealType,
    semDesconto: dealType !== 'oferta',
    componentes: {
      quality: Math.round(quality * 100),
      price: Math.round(price),
      social: Math.round(social),
      lowest,
      commission: Math.round(commission),
    },
    motivo: explicar(dealType, offer, realDiscount, baseline, isLowest, notas),
    produto,
    rejected: null,
  };
}

function explicar(
  tipo: DealType | null,
  o: Offer,
  real: number | null,
  baseline: number | null,
  isLowest: boolean,
  notas: string[],
): string {
  const partes: string[] = [];
  if (tipo === 'oferta' && real !== null && baseline) {
    partes.push(`preço ${pct(real)} abaixo do baseline (${reais(baseline)})`);
    if (isLowest) partes.push('menor preço medido');
  } else if (tipo === 'menor_preco' && baseline) {
    partes.push(`menor preço medido (normal ${reais(baseline)})`);
  } else {
    partes.push('sem queda verificada');
  }
  if (o.rating) partes.push(`nota ${o.rating.toFixed(1)}`);
  if (o.sold) partes.push(`${o.sold.toLocaleString('pt-BR')} vendas`);
  if (notas.length) partes.push(`⚠ ${notas.join(', ')}`);
  return partes.join(', ');
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
