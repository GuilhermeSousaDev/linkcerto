import { z } from 'zod';
import type { Offer } from '../infra/shopee.js';
import { veredito } from './genero.js';

/**
 * Busca sob demanda: o que o administrador pediu, em forma de dados.
 *
 * A IA só traduz a descrição pra isto (ver `ai/intencao.ts`). Tudo que é
 * NÚMERO ou FILTRO é conferido aqui por regra, depois dela: preço vem do texto
 * do pedido, não do modelo — "celular barato" não pode virar "até R$ 1.000"
 * porque o modelo achou razoável.
 */

export type Publico = 'masculino' | 'feminino' | 'infantil' | 'unissex';

export interface SearchIntent {
  originalQuery: string;
  /** O produto principal ("tênis de corrida"). Pesa mais no match. */
  product: string;
  category: string | null;
  subcategory: string | null;
  audience: Publico | null;
  brand: string[];
  model: string | null;
  color: string[];
  size: string[];
  material: string[];
  purpose: string[];
  features: string[];
  priceMin: number | null;
  priceMax: number | null;
  /** 1 a 5 termos curtos pra busca textual na Shopee. Sem preço. */
  keywords: string[];
  /** Título com qualquer um destes fica fora ("usado", "capa"). */
  exclusions: string[];
  confidence: number;
}

// ─── Validação da resposta da IA ────────────────────────────────────────────

/** Lista que o modelo às vezes devolve como null ou string solta. */
const lista = z
  .union([z.array(z.string()), z.string()])
  .nullish()
  .transform((v) => (v == null ? [] : Array.isArray(v) ? v : [v]))
  .transform((v) => v.map((x) => x.trim()).filter(Boolean));
const texto = z
  .string()
  .nullish()
  .transform((v) => (v && v.trim() ? v.trim() : null));
const preco = z
  .union([z.number(), z.string()])
  .nullish()
  .transform((v) => (v == null || v === '' ? null : Number(v)))
  .transform((v) => (v !== null && Number.isFinite(v) && v > 0 ? v : null));

export const intentSchema = z.object({
  product: z.string().min(1),
  category: texto,
  subcategory: texto,
  audience: z
    .enum(['masculino', 'feminino', 'infantil', 'unissex'])
    .nullish()
    .catch(null)
    .transform((v) => v ?? null),
  brand: lista,
  model: texto,
  color: lista,
  size: lista,
  material: lista,
  purpose: lista,
  features: lista,
  priceMin: preco,
  priceMax: preco,
  keywords: lista,
  exclusions: lista,
  confidence: z.coerce.number().catch(0.5),
});
export type IntentDaIA = z.infer<typeof intentSchema>;

// ─── Texto ──────────────────────────────────────────────────────────────────

const semAcento = (t: string) =>
  t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const VAZIAS = new Set([
  'de', 'da', 'do', 'das', 'dos', 'para', 'pra', 'pro', 'com', 'sem', 'e', 'ou',
  'o', 'a', 'os', 'as', 'um', 'uma', 'uns', 'umas', 'em', 'no', 'na', 'nos', 'nas',
]);

/**
 * Raiz grosseira, igual dos dois lados: "preta"/"preto" → "pret",
 * "tênis"/"tenis" → "teni", "polegadas" → "polegad". Não é linguística — só
 * precisa ser consistente entre o pedido e o título.
 */
function raiz(p: string): string {
  let s = p;
  if (s.length > 4 && s.endsWith('s')) s = s.slice(0, -1);
  if (s.length > 4 && /[aoe]$/.test(s)) s = s.slice(0, -1);
  return s;
}

export function raizes(t: string): string[] {
  return semAcento(t)
    .split(/[^a-z0-9]+/)
    .filter((p) => p && !VAZIAS.has(p))
    .map(raiz);
}

// ─── Preço ──────────────────────────────────────────────────────────────────

/** Unidade logo depois do número: é medida, não dinheiro ("de 16 a 32gb"). */
const UNIDADE = String.raw`(?:gb|tb|mb|polegadas?|pol|ml|cm|mm|kg|w|v|mah|hz|anos?|meses|gramas|litros?|l)\b`;
const NUM = String.raw`(?:r\$\s*)?(\d{1,3}(?:\.\d{3})+|\d+)(?!\d)(?:,\d{1,2})?\s*(mil|k\b)?(?!\s*${UNIDADE})`;

function valor(inteiro: string, mil?: string): number {
  return Number(inteiro.replace(/\./g, '')) * (mil ? 1000 : 1);
}

/**
 * O orçamento escrito no pedido, por regra.
 *
 * Só número em CONTEXTO de preço conta: "iPhone 15", "TV 50 polegadas" e "4K"
 * não são orçamento. Sem nenhum número assim, não há limite — "barato" não é
 * um valor, e inventar um corta opção boa sem ninguém ter pedido.
 */
export function precoDoPedido(pedido: string): { min: number | null; max: number | null } {
  const t = semAcento(pedido);
  const nada = { min: null, max: null };

  const entre = new RegExp(String.raw`\b(?:entre|de)\s+${NUM}\s+(?:e|a|ate)\s+${NUM}`).exec(t);
  if (entre) {
    return { min: valor(entre[1]!, entre[2]), max: valor(entre[3]!, entre[4]) };
  }

  const ate = new RegExp(
    String.raw`\b(?:ate|no maximo|maximo|max|menos de|abaixo de|nao passa(?:r)? de|orcamento(?: de)?)\s+(?:uns |umas |de )?${NUM}`,
  ).exec(t);
  if (ate) return { min: null, max: valor(ate[1]!, ate[2]) };

  const desde = new RegExp(
    String.raw`\b(?:acima de|mais de|a partir de|no minimo|pelo menos)\s+${NUM}`,
  ).exec(t);
  if (desde) return { min: valor(desde[1]!, desde[2]), max: null };

  const volta = new RegExp(
    String.raw`\b(?:por volta de|cerca de|em torno de|aproximadamente|perto de|na faixa de|uns|umas)\s+${NUM}`,
  ).exec(t);
  if (volta) {
    const v = valor(volta[1]!, volta[2]);
    return { min: Math.round(v * 0.9), max: Math.round(v * 1.1) };
  }

  // "um perfume de 150 reais": valor solto com moeda é teto.
  const solto = new RegExp(String.raw`(?:r\$\s*(\d{1,3}(?:\.\d{3})+|\d+)|\b(\d{1,3}(?:\.\d{3})+|\d+)\s*(mil\s*)?(?:reais|conto|pila))`).exec(t);
  if (solto) {
    const v = solto[1] ? valor(solto[1]) : valor(solto[2]!, solto[3]);
    return { min: null, max: v };
  }

  return nada;
}

// ─── Normalização ───────────────────────────────────────────────────────────

/** Palavras que a busca da Shopee não indexa bem e só trazem lixo. */
const RUIDO = /\b(barat[oa]s?|promocao|promo|desconto|oferta|imperdivel|melhor|top)\b/g;
const PRECO_NO_TERMO = /\b(ate|menos de|abaixo de|por volta de|entre)\b.*$|r\$\s*\d+\S*|\b\d+\s*(reais|conto|mil)\b/g;

function limparTermo(t: string): string {
  return semAcento(t).replace(PRECO_NO_TERMO, ' ').replace(RUIDO, ' ').replace(/\s+/g, ' ').trim();
}

/** O termo aparece no pedido? Pelo menos uma raiz dele, pra tolerar plural e gênero. */
function noPedido(termo: string, pedido: Set<string>): boolean {
  return raizes(termo).some((r) => pedido.has(r));
}

/**
 * A resposta da IA, conferida contra o próprio pedido.
 *
 * - Preço: SEMPRE o do texto (`precoDoPedido`). O da IA é descartado.
 * - Público: se o pedido escreve "masculino"/"feminino", vale o que está escrito.
 * - Cor, tamanho, material, finalidade e característica que não aparecem no
 *   pedido saem: a IA não acrescenta o que ninguém pediu. Marca e modelo ficam,
 *   porque "iPhone" implica Apple sem a palavra estar lá.
 * - Keywords: sem preço, sem "barato", sem repetição, 1 a 5.
 */
export function normalizarIntent(
  raw: IntentDaIA,
  pedido: string,
): { intent: SearchIntent; avisos: string[] } {
  const avisos: string[] = [];
  const doPedido = new Set(raizes(pedido));

  const p = precoDoPedido(pedido);
  if ((raw.priceMax !== null && raw.priceMax !== p.max) || (raw.priceMin !== null && raw.priceMin !== p.min)) {
    avisos.push(
      `IA sugeriu preço ${raw.priceMin ?? '-'}..${raw.priceMax ?? '-'}; vale o do pedido: ${p.min ?? '-'}..${p.max ?? '-'}`,
    );
  }

  const t = semAcento(pedido);
  let audience = raw.audience;
  if (/\bmasculin[oa]s?\b|\bhomem\b|\bhomens\b/.test(t)) audience = 'masculino';
  else if (/\bfeminin[oa]s?\b|\bmulher(es)?\b/.test(t)) audience = 'feminino';
  else if (/\bunissex\b/.test(t)) audience = 'unissex';

  const soDoPedido = (campo: string, v: string[]) => {
    const fica = v.filter((x) => noPedido(x, doPedido));
    const saiu = v.filter((x) => !fica.includes(x));
    if (saiu.length) avisos.push(`${campo} não pedido, descartado: ${saiu.join(', ')}`);
    return fica;
  };

  const keywords = [
    ...new Set(raw.keywords.map(limparTermo).filter((k) => k.length > 2)),
  ].slice(0, 5);
  if (!keywords.length) keywords.push(limparTermo(raw.product));

  return {
    intent: {
      originalQuery: pedido,
      product: raw.product.trim(),
      category: raw.category,
      subcategory: raw.subcategory,
      audience,
      brand: raw.brand,
      model: raw.model,
      color: soDoPedido('cor', raw.color),
      size: soDoPedido('tamanho', raw.size),
      material: soDoPedido('material', raw.material),
      purpose: soDoPedido('finalidade', raw.purpose),
      features: soDoPedido('característica', raw.features),
      priceMin: p.min,
      priceMax: p.max,
      keywords,
      exclusions: raw.exclusions,
      confidence: Math.max(0, Math.min(1, raw.confidence)),
    },
    avisos,
  };
}

// ─── Match com o pedido ─────────────────────────────────────────────────────

export interface Match {
  /** 0-100: o quanto o título corresponde ao pedido. */
  score: number;
  /** Motivo de exclusão (público errado, termo excluído). null = elegível. */
  excluido: string | null;
  /** O que o título tem / não tem, pro `--debug`. */
  tem: string[];
  falta: string[];
}

/**
 * Pesos do match. O produto manda: "tênis casual" não é "tênis de corrida",
 * por maior que seja o desconto. Campo vazio no pedido não entra na conta.
 */
const PESO_MATCH = {
  product: 40,
  subcategory: 5,
  brand: 15,
  model: 15,
  audience: 10,
  purpose: 10,
  features: 10,
  color: 10,
  material: 5,
  size: 5,
} as const;

export function intentMatch(intent: SearchIntent, offer: Offer): Match {
  const titulo = semAcento(offer.title);
  const doTitulo = new Set(raizes(offer.title));
  const tem: string[] = [];
  const falta: string[] = [];

  for (const x of intent.exclusions) {
    if (x && raizes(x).every((r) => doTitulo.has(r))) {
      return { score: 0, excluido: `excluido:${x}`, tem, falta };
    }
  }

  // Reaproveita a regra do filtro de público: gênero escrito no título decide.
  let publico: number | null = null;
  if (intent.audience === 'masculino' || intent.audience === 'feminino') {
    const v = veredito(offer.title, intent.audience === 'masculino' ? 'm' : 'f');
    if (v === 'fora') return { score: 0, excluido: 'publico_errado', tem, falta };
    publico = v === 'dentro' ? 1 : 0.5;
  } else if (intent.audience === 'unissex') {
    publico = /\bunisse?x\b/.test(titulo) ? 1 : 0.5;
  }

  /** Fração das raízes do termo presentes no título. */
  const cobre = (termo: string) => {
    const r = raizes(termo);
    if (!r.length) return 1;
    const m = r.filter((x) => doTitulo.has(x)).length / r.length;
    (m === 1 ? tem : falta).push(termo);
    return m;
  };
  const media = (v: string[]) => v.reduce((s, x) => s + cobre(x), 0) / v.length;

  const partes: [number, number][] = [];

  // Produto: só as palavras dele que a busca também usa — "produto para
  // academia" tem "produto", que não identifica nada. A primeira delas é o
  // núcleo: sem ela no título não é o produto pedido ("meia de corrida" não é
  // "tênis de corrida"), e a parte do produto zera.
  // Título que contém uma keyword inteira conta como o produto: é como o
  // sinônimo da IA ("running" por "corrida") deixa de ser punido.
  const daBusca = new Set(intent.keywords.flatMap(raizes));
  const nucleo = raizes(intent.product).filter((r) => daBusca.has(r));
  const cobreKeyword = intent.keywords.some((k) => raizes(k).every((r) => doTitulo.has(r)));
  if (nucleo.length) {
    const m = cobreKeyword
      ? 1
      : doTitulo.has(nucleo[0]!)
        ? nucleo.filter((r) => doTitulo.has(r)).length / nucleo.length
        : 0;
    (m === 1 ? tem : falta).push(intent.product);
    partes.push([PESO_MATCH.product, m]);
  }

  // Subcategoria só conta se disser algo além do produto ("tênis" já está em "tênis de corrida").
  const doProduto = new Set(raizes(intent.product));
  if (intent.subcategory && raizes(intent.subcategory).some((r) => !doProduto.has(r))) {
    partes.push([PESO_MATCH.subcategory, cobre(intent.subcategory)]);
  }
  if (intent.brand.length) {
    partes.push([PESO_MATCH.brand, intent.brand.some((b) => cobre(b) === 1) ? 1 : 0]);
  }
  if (intent.model) partes.push([PESO_MATCH.model, cobre(intent.model)]);
  if (publico !== null) partes.push([PESO_MATCH.audience, publico]);
  if (intent.purpose.length) partes.push([PESO_MATCH.purpose, media(intent.purpose)]);
  if (intent.features.length) partes.push([PESO_MATCH.features, media(intent.features)]);
  if (intent.color.length) partes.push([PESO_MATCH.color, media(intent.color)]);
  if (intent.material.length) partes.push([PESO_MATCH.material, media(intent.material)]);
  if (intent.size.length) partes.push([PESO_MATCH.size, media(intent.size)]);

  // Pedido sem nenhum atributo comparável: vale o termo de busca que o título
  // mais cobre, pra não dividir por zero nem aprovar tudo.
  if (!partes.length) {
    const melhor = Math.max(
      ...intent.keywords.map((k) => {
        const r = raizes(k);
        return r.length ? r.filter((x) => doTitulo.has(x)).length / r.length : 0;
      }),
    );
    partes.push([1, melhor]);
  }

  const peso = partes.reduce((s, [w]) => s + w, 0);
  const pontos = partes.reduce((s, [w, m]) => s + w * m, 0);
  return {
    score: Math.round((100 * pontos) / peso),
    excluido: null,
    tem: [...new Set(tem)],
    falta: [...new Set(falta)],
  };
}

// ─── Orçamento ──────────────────────────────────────────────────────────────

export interface Orcamento {
  cabe: boolean;
  /**
   * Cabe só pela variação mais barata: o teto das variações passa do
   * orçamento. Sai com "a partir de" e aviso — a variação que a pessoa quer
   * pode não ser a barata.
   */
  parcial: boolean;
  /** Fora do orçamento: quanto (R$) acima do teto ou abaixo do mínimo. */
  distancia: number;
  lado: 'acima' | 'abaixo' | null;
}

/** Filtro de preço real, contra `price` e `priceMax` — não um "200" na query. */
export function orcamento(intent: SearchIntent, offer: Offer): Orcamento {
  const topo = offer.priceMax ?? offer.price;
  if (intent.priceMax !== null && offer.price > intent.priceMax) {
    return { cabe: false, parcial: false, distancia: offer.price - intent.priceMax, lado: 'acima' };
  }
  if (intent.priceMin !== null && topo < intent.priceMin) {
    return { cabe: false, parcial: false, distancia: intent.priceMin - topo, lado: 'abaixo' };
  }
  const parcial = intent.priceMax !== null && offer.priceMax !== null && offer.priceMax > intent.priceMax;
  return { cabe: true, parcial, distancia: 0, lado: null };
}
