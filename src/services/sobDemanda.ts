import { historyFor, type Snapshot } from '../infra/db.js';
import { fetchOffers, ORDEM, type Offer } from '../infra/shopee.js';
import { scoreOffer, type Scored } from '../domain/scoring.js';
import {
  intentMatch,
  orcamento,
  type Match,
  type Orcamento,
  type SearchIntent,
} from '../domain/intencao.js';

/**
 * Busca sob demanda: o administrador pediu um produto, o LinkCerto acha as
 * melhores opções que ATENDEM o pedido E passam nos critérios de sempre.
 *
 *   SearchIntent → keywords → Shopee → filtros de qualidade + histórico
 *   (o mesmo `scoreOffer` do radar) → match com o pedido → orçamento → ranking
 *
 * Nada aqui fala com o cliente final nem envia mensagem: devolve dados pro
 * administrador decidir. Não imprime — quem mostra é o cli.
 */

/** Abaixo disto o produto não é o que foi pedido, por melhor que seja a oferta. */
export const MIN_MATCH = 60;

export interface Resultado {
  s: Scored;
  match: Match;
  orcamento: Orcamento;
  /** 0-100. Match pesa mais que o score de curadoria — ver `searchByIntent`. */
  final: number;
}

export interface BuscaSobDemanda {
  intent: SearchIntent;
  queries: number;
  /** Somando o que cada termo devolveu, com repetição. */
  encontrados: number;
  /** Depois de juntar os termos e tirar duplicados. */
  unicos: number;
  /** Quantos caíram em cada filtro (qualidade, pedido, relevância). */
  descartes: Record<string, number>;
  /** Quantos passaram em tudo e cabem no orçamento (antes do top). */
  aprovados: number;
  /** Os melhores deles, até o top. */
  resultados: Resultado[];
  /** Passaram em tudo, mas ficaram fora do orçamento — o mais perto primeiro. */
  proximos: Resultado[];
}

/** De onde vêm os produtos e o histórico. Trocado por mock nos testes. */
export interface Fontes {
  buscar: (termo: string) => Promise<Offer[]>;
  historico: (ids: string[]) => Promise<Map<string, Snapshot[]>>;
}

export const fontesReais = (paginas: number): Fontes => ({
  // Relevância, não mais vendidos: aqui importa achar O produto pedido.
  buscar: (termo) => fetchOffers([termo], paginas, ORDEM.relevancia),
  historico: (ids) => historyFor(ids),
});

/**
 * Peso do match no score final. Ordem de prioridade: corresponder ao pedido >
 * qualidade > preço/oferta > comissão. Os três últimos já estão dentro do
 * score de curadoria (`scoreOffer`), na mesma ordem — comissão continua
 * escalada pelo mérito, então não salva produto fraco aqui também.
 */
const PESO_MATCH = 0.6;
/** "A partir de" com variações acima do orçamento: pode não ser a que serve. */
const PENALIDADE_PARCIAL = 0.9;

export async function searchByIntent(
  intent: SearchIntent,
  fontes: Fontes,
  opts: { top?: number; proximos?: number } = {},
): Promise<BuscaSobDemanda> {
  const porId = new Map<string, Offer>();
  let encontrados = 0;
  for (const termo of intent.keywords) {
    const achados = await fontes.buscar(termo);
    encontrados += achados.length;
    for (const o of achados) porId.set(o.id, o);
  }

  const offers = [...porId.values()];
  const historico = await fontes.historico(offers.map((o) => o.id));
  const descartes: Record<string, number> = {};
  const descartar = (motivo: string) => (descartes[motivo] = (descartes[motivo] ?? 0) + 1);

  const resultados: Resultado[] = [];
  const proximos: Resultado[] = [];

  for (const o of offers) {
    // Mesmos filtros do radar: infantil, nota, vendas, perfume, desconto
    // implausível, mais caro que o normal. Pedido não é desculpa pra produto ruim.
    const s = scoreOffer(o, historico.get(o.id) ?? [], { pedido: true });
    if (s.rejected) {
      descartar(s.rejected);
      continue;
    }

    const match = intentMatch(intent, o);
    if (match.excluido) {
      descartar(match.excluido.split(':')[0]!);
      continue;
    }
    if (match.score < MIN_MATCH) {
      descartar('pouco_relevante');
      continue;
    }

    const orc = orcamento(intent, o);
    const final =
      (PESO_MATCH * match.score + (1 - PESO_MATCH) * s.score) * (orc.parcial ? PENALIDADE_PARCIAL : 1);
    const r: Resultado = { s, match, orcamento: orc, final: Number(final.toFixed(1)) };
    (orc.cabe ? resultados : proximos).push(r);
  }

  resultados.sort((a, b) => b.final - a.final);
  // Próximos: o que menos estoura o orçamento primeiro; empate, o melhor.
  proximos.sort((a, b) => a.orcamento.distancia - b.orcamento.distancia || b.final - a.final);
  if (proximos.length) descartes['fora_do_orcamento'] = proximos.length;

  return {
    intent,
    queries: intent.keywords.length,
    encontrados,
    unicos: offers.length,
    aprovados: resultados.length,
    descartes,
    resultados: resultados.slice(0, opts.top ?? 10),
    proximos: proximos.slice(0, opts.proximos ?? 5),
  };
}
