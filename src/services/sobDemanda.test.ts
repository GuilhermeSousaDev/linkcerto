import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../infra/config.js';
import type { Snapshot } from '../infra/db.js';
import type { Offer } from '../infra/shopee.js';
import { intentMatch, intentSchema, normalizarIntent, type SearchIntent } from '../domain/intencao.js';
import { MIN_MATCH, searchByIntent, type Fontes } from './sobDemanda.js';

/**
 * Shopee e histórico mockados. Nota/vendas dos produtos "bons" ficam bem acima
 * de qualquer MIN_RATING/MIN_SALES razoável, e os "ruins" bem abaixo, pra que
 * o teste não dependa do .env local.
 */
const oferta = (id: string, title: string, price: number, extra: Partial<Offer> = {}): Offer => ({
  id, title, url: `https://shopee.com.br/${id}`, offerLink: `https://s.shopee.com.br/${id}`,
  imageUrl: null, price, priceMax: null, vendorDiscount: null, rating: 4.8, sold: 3000,
  commissionRate: 0.1, shopName: 'Loja', ...extra,
});

/** Histórico que fecha baseline em qualquer config: mais leituras e mais dias que o mínimo. */
function historico(precoNormal: number, atual: number): Snapshot[] {
  const n = config.BASELINE_MIN_SNAPSHOTS + 2;
  const dias = config.BASELINE_MIN_DAYS + 5;
  const t0 = Date.now() - dias * 86_400_000;
  const snaps = Array.from({ length: n }, (_, i) => ({
    price: precoNormal,
    capturedAt: new Date(t0 + (i * dias * 86_400_000) / n).toISOString(),
  }));
  snaps.push({ price: atual, capturedAt: new Date().toISOString() });
  return snaps;
}

function intent(pedido: string, raw: Record<string, unknown>): SearchIntent {
  return normalizarIntent(intentSchema.parse(raw), pedido).intent;
}

const TENIS = intent('tênis de corrida masculino preto até 200 reais', {
  product: 'tênis de corrida', category: 'calçados', subcategory: 'tênis', audience: 'masculino',
  color: ['preto'], purpose: ['corrida'], priceMax: 200,
  keywords: ['tênis corrida masculino', 'tênis running masculino', 'tênis corrida preto masculino'],
  confidence: 0.95,
});

const CATALOGO: Offer[] = [
  oferta('A', 'Tênis Masculino Para Corrida Preto Amortecido', 149.9, { rating: 4.8, sold: 3200 }),
  // Desconto anunciado enorme, mais vendido — mas é casual, não de corrida.
  oferta('B', 'Tênis Casual Masculino Preto Confortável', 99, { vendorDiscount: 0.6, rating: 4.9, sold: 9000 }),
  oferta('C', 'Tênis Feminino Corrida Preto', 120),
  oferta('D', 'Tênis Corrida Masculino Preto Leve', 110, { rating: 3.0 }),
  oferta('E', 'Tênis Infantil Corrida Menino Preto', 80),
  oferta('F', 'Tênis Corrida Masculino Preto Pro', 229),
  oferta('G', 'Tênis Corrida Masculino Preto Variações', 120, { priceMax: 260 }),
  oferta('H', 'Tênis Running Corrida Masculino Preto', 130),
  oferta('I', 'Meia de Corrida Masculina Preta Kit', 39),
];

function fontes(catalogo: Offer[], hist: Record<string, Snapshot[]> = {}): Fontes & { termos: string[] } {
  const termos: string[] = [];
  return {
    termos,
    // Cada termo devolve o catálogo inteiro: força a deduplicação.
    buscar: async (t) => {
      termos.push(t);
      return catalogo;
    },
    historico: async (ids) => new Map(ids.filter((id) => hist[id]).map((id) => [id, hist[id]!])),
  };
}

test('executa cada keyword e deduplica', async () => {
  const f = fontes(CATALOGO);
  const r = await searchByIntent(TENIS, f);
  assert.deepEqual(f.termos, TENIS.keywords);
  assert.equal(r.queries, 3);
  assert.equal(r.encontrados, CATALOGO.length * 3);
  assert.equal(r.unicos, CATALOGO.length);
});

test('filtros de qualidade e do pedido valem na busca sob demanda', async () => {
  const r = await searchByIntent(TENIS, fontes(CATALOGO));
  const ids = r.resultados.map((x) => x.s.offer.id);
  assert.ok(!ids.includes('C'), 'feminino num pedido masculino');
  assert.ok(!ids.includes('D'), 'nota baixa');
  assert.ok(!ids.includes('E'), 'infantil');
  assert.ok(!ids.includes('I'), 'meia não é tênis');
  assert.equal(r.descartes['publico_errado'], 1);
  assert.equal(r.descartes['rating_baixo'], 1);
  assert.equal(r.descartes['infantil'], 1);
  // A meia (não é tênis) e o casual (não é de corrida).
  assert.equal(r.descartes['pouco_relevante'], 2);
});

test('filtro de preço é real: acima do teto vai pros próximos com a distância', async () => {
  const r = await searchByIntent(TENIS, fontes(CATALOGO));
  assert.ok(r.resultados.every((x) => x.s.offer.price <= 200));
  const f = r.proximos.find((x) => x.s.offer.id === 'F');
  assert.ok(f);
  assert.equal(f.orcamento.distancia, 29);
  assert.equal(f.orcamento.lado, 'acima');
});

test('variação acima do orçamento: entra como parcial, com penalidade', async () => {
  const r = await searchByIntent(TENIS, fontes(CATALOGO));
  const g = r.resultados.find((x) => x.s.offer.id === 'G');
  assert.ok(g);
  assert.equal(g.orcamento.parcial, true);
});

test('match: corresponder ao pedido ganha de desconto maior', async () => {
  const porId = (id: string) => CATALOGO.find((o) => o.id === id)!;
  const a = intentMatch(TENIS, porId('A'));
  const b = intentMatch(TENIS, porId('B'));
  assert.ok(a.score > b.score);
  assert.ok(b.score < MIN_MATCH, 'casual com -60% nem entra num pedido de corrida');
  const r = await searchByIntent(TENIS, fontes(CATALOGO));
  assert.ok(r.resultados.some((x) => x.s.offer.id === 'A'));
  assert.ok(!r.resultados.some((x) => x.s.offer.id === 'B'));
});

test('match: sinônimo usado na keyword ("running") conta como o produto', () => {
  const m = intentMatch(TENIS, oferta('R', 'Tênis Running Masculino Preto', 150));
  assert.ok(m.score >= 80, `match ${m.score}`);
});

test('histórico: com baseline mostra queda real; sem, não inventa desconto', async () => {
  const r = await searchByIntent(TENIS, fontes(CATALOGO, { H: historico(170, 130) }));
  const h = r.resultados.find((x) => x.s.offer.id === 'H')!;
  assert.equal(h.s.mode, 'history');
  assert.equal(h.s.dealType, 'oferta');
  assert.ok(Math.abs(h.s.realDiscount! - 40 / 170) < 0.001);

  const a = r.resultados.find((x) => x.s.offer.id === 'A')!;
  assert.equal(a.s.mode, 'instant');
  assert.equal(a.s.realDiscount, null);
});

test('produto mais caro que o próprio histórico é descartado', async () => {
  const r = await searchByIntent(TENIS, fontes(CATALOGO, { A: historico(120, 149.9) }));
  assert.ok(!r.resultados.some((x) => x.s.offer.id === 'A'));
  assert.equal(r.descartes['acima_do_normal'], 1);
});

test('comissão não faz produto pior passar o melhor', async () => {
  const catalogo = [
    oferta('BOM', 'Tênis Corrida Masculino Preto', 150, { rating: 4.9, sold: 8000, commissionRate: 0.01 }),
    oferta('PAGA', 'Tênis Corrida Masculino Preto', 150, { rating: 4.5, sold: 300, commissionRate: 0.3 }),
  ];
  const r = await searchByIntent(TENIS, fontes(catalogo));
  assert.deepEqual(r.resultados.map((x) => x.s.offer.id), ['BOM', 'PAGA']);
});

test('sem nada no orçamento: zero resultados, próximos ordenados pela distância', async () => {
  const caro = intent('tênis de corrida masculino até 100', {
    product: 'tênis de corrida', audience: 'masculino', purpose: ['corrida'], priceMax: 100,
    keywords: ['tênis corrida masculino'], confidence: 0.9,
  });
  const r = await searchByIntent(caro, fontes(CATALOGO));
  assert.equal(r.resultados.length, 0);
  assert.ok(r.proximos.length > 0);
  const d = r.proximos.map((x) => x.orcamento.distancia);
  assert.deepEqual(d, [...d].sort((x, y) => x - y));
});

test('exclusões do pedido tiram o produto', async () => {
  const semKit = intent('meia de corrida masculina sem kit', {
    product: 'meia de corrida', audience: 'masculino', exclusions: ['kit'],
    keywords: ['meia corrida masculina'], confidence: 0.9,
  });
  const r = await searchByIntent(semKit, fontes(CATALOGO));
  assert.ok(!r.resultados.some((x) => x.s.offer.id === 'I'));
  assert.equal(r.descartes['excluido'], 1);
});
