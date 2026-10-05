import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpretarPedido } from '../ai/intencao.js';
import { precoDoPedido } from './intencao.js';

/**
 * A IA é mockada: cada caso devolve o que um modelo plausível devolveria —
 * alguns com os erros que a normalização tem que pegar (preço inventado pra
 * "barato", cor que ninguém pediu, preço dentro da keyword).
 */
const RESPOSTAS: Record<string, Record<string, unknown>> = {
  'tênis de corrida masculino até 200 reais': {
    product: 'tênis de corrida', category: 'calçados', subcategory: 'tênis', audience: 'masculino',
    purpose: ['corrida'], priceMax: 200,
    keywords: ['tênis corrida masculino até 200', 'tênis running masculino', 'Tênis corrida masculino'],
    confidence: 0.95,
  },
  'perfume masculino até 150': {
    product: 'perfume', category: 'beleza', subcategory: 'perfumaria', audience: 'masculino',
    priceMax: 150, keywords: ['perfume masculino', 'perfume masculino importado'], confidence: 0.9,
  },
  'cadeira de escritório confortável até 800': {
    product: 'cadeira de escritório', category: 'móveis', audience: null,
    features: ['confortável', 'ergonômica'], material: ['couro'], priceMax: 800,
    keywords: ['cadeira escritório ergonômica', 'cadeira de escritório confortável'], confidence: 0.9,
  },
  'iPhone 15 até 3000': {
    product: 'iPhone', category: 'eletrônicos', subcategory: 'celular', brand: ['Apple'], model: '15',
    priceMax: 3000, keywords: ['iphone 15', 'apple iphone 15 128gb'], confidence: 0.95,
  },
  'camisa oversized masculina preta até 100': {
    product: 'camisa oversized', category: 'moda', audience: 'masculino', color: ['preta'],
    features: ['oversized'], priceMax: 100,
    keywords: ['camisa oversized masculina', 'camiseta oversized preta masculina'], confidence: 0.9,
  },
  'notebook gamer até 4000': {
    product: 'notebook gamer', category: 'informática', features: ['gamer'], priceMax: 4000,
    keywords: ['notebook gamer', 'notebook gamer rtx'], confidence: 0.9,
  },
  // Erros de propósito: preço inventado e cor que não está no pedido.
  'tênis Nike': {
    product: 'tênis', category: 'calçados', brand: ['Nike'], color: ['preto'], priceMax: 500,
    keywords: ['tênis nike', 'tênis nike masculino'], confidence: 0.8,
  },
  'produto para academia': {
    product: 'produto para academia', category: 'esporte', purpose: ['academia'],
    keywords: ['acessórios academia', 'luva academia', 'garrafa academia'], confidence: 0.4,
  },
  // Erro de propósito: "barato" virou teto.
  'celular barato': {
    product: 'celular', category: 'eletrônicos', priceMax: 1000,
    keywords: ['celular barato', 'smartphone barato'], confidence: 0.6,
  },
  'TV 50 polegadas 4K até 2500': {
    product: 'smart tv', category: 'eletrônicos', subcategory: 'televisão',
    features: ['50 polegadas', '4K'], priceMax: 2500,
    keywords: ['smart tv 50 polegadas 4k', 'tv 4k 50'], confidence: 0.9,
  },
};

const mock = async (pedido: string) => {
  const r = RESPOSTAS[pedido];
  if (!r) throw new Error(`sem mock pra "${pedido}"`);
  return r;
};
const ler = (pedido: string) => interpretarPedido(pedido, mock).then((r) => r.intent);

test('1. tênis de corrida masculino até 200 reais', async () => {
  const i = await ler('tênis de corrida masculino até 200 reais');
  assert.equal(i.product, 'tênis de corrida');
  assert.equal(i.category, 'calçados');
  assert.equal(i.audience, 'masculino');
  assert.deepEqual(i.purpose, ['corrida']);
  assert.equal(i.priceMin, null);
  assert.equal(i.priceMax, 200);
  // Preço fora da keyword, duplicata (caixa/acento) removida.
  assert.deepEqual(i.keywords, ['tenis corrida masculino', 'tenis running masculino']);
});

test('2. perfume masculino até 150', async () => {
  const i = await ler('perfume masculino até 150');
  assert.equal(i.priceMax, 150);
  assert.equal(i.audience, 'masculino');
  assert.ok(i.keywords.every((k) => k.includes('perfume')));
});

test('3. cadeira de escritório confortável até 800 — material inventado sai', async () => {
  const r = await interpretarPedido('cadeira de escritório confortável até 800', mock);
  assert.equal(r.intent.priceMax, 800);
  assert.deepEqual(r.intent.features, ['confortável']);
  assert.deepEqual(r.intent.material, []);
  assert.ok(r.avisos.some((a) => a.includes('couro')));
});

test('4. iPhone 15 até 3000 — marca implícita fica, "15" não é preço', async () => {
  const i = await ler('iPhone 15 até 3000');
  assert.deepEqual(i.brand, ['Apple']);
  assert.equal(i.model, '15');
  assert.equal(i.priceMax, 3000);
  assert.equal(i.priceMin, null);
});

test('5. camisa oversized masculina preta até 100', async () => {
  const i = await ler('camisa oversized masculina preta até 100');
  assert.equal(i.audience, 'masculino');
  assert.deepEqual(i.color, ['preta']);
  assert.deepEqual(i.features, ['oversized']);
  assert.equal(i.priceMax, 100);
});

test('6. notebook gamer até 4000', async () => {
  const i = await ler('notebook gamer até 4000');
  assert.equal(i.priceMax, 4000);
  assert.deepEqual(i.features, ['gamer']);
});

test('7. tênis Nike — sem preço nem cor inventados', async () => {
  const i = await ler('tênis Nike');
  assert.deepEqual(i.brand, ['Nike']);
  assert.equal(i.priceMax, null);
  assert.deepEqual(i.color, []);
});

test('8. produto para academia — vago, sem preço', async () => {
  const i = await ler('produto para academia');
  assert.equal(i.priceMax, null);
  assert.deepEqual(i.purpose, ['academia']);
  assert.ok(i.confidence < 0.6);
});

test('9. celular barato — "barato" não vira teto nem keyword', async () => {
  const i = await ler('celular barato');
  assert.equal(i.priceMax, null);
  assert.deepEqual(i.keywords, ['celular', 'smartphone']);
});

test('10. TV 50 polegadas 4K até 2500 — "50 polegadas" não é preço', async () => {
  const i = await ler('TV 50 polegadas 4K até 2500');
  assert.equal(i.priceMax, 2500);
  assert.deepEqual(i.features, ['50 polegadas', '4K']);
});

test('resposta da IA sem produto é recusada', async () => {
  await assert.rejects(interpretarPedido('x', async () => ({ keywords: ['x'] })));
});

test('precoDoPedido: formas de orçamento', () => {
  assert.deepEqual(precoDoPedido('entre 100 e 200 reais'), { min: 100, max: 200 });
  assert.deepEqual(precoDoPedido('por volta de 300'), { min: 270, max: 330 });
  assert.deepEqual(precoDoPedido('tênis preto até uns 200 reais'), { min: null, max: 200 });
  assert.deepEqual(precoDoPedido('menos de 150'), { min: null, max: 150 });
  assert.deepEqual(precoDoPedido('notebook até R$ 3.500,00'), { min: null, max: 3500 });
  assert.deepEqual(precoDoPedido('iphone até 3 mil'), { min: null, max: 3000 });
  assert.deepEqual(precoDoPedido('acima de 50 reais'), { min: 50, max: null });
  assert.deepEqual(precoDoPedido('perfume de 150 reais'), { min: null, max: 150 });
  assert.deepEqual(precoDoPedido('memória de 16 a 32gb'), { min: null, max: null });
  assert.deepEqual(precoDoPedido('celular barato'), { min: null, max: null });
});
