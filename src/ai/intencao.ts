import { aiEnabled, askJson } from './client.js';
import {
  intentSchema,
  normalizarIntent,
  type IntentDaIA,
  type SearchIntent,
} from '../domain/intencao.js';

/**
 * Pedido em texto livre → `SearchIntent`. É o ÚNICO papel da IA na busca sob
 * demanda: ela não pesquisa, não recomenda, não julga oferta e não fala com
 * ninguém. Quem lê o resultado é o administrador.
 *
 * O provider é compatível com OpenAI em JSON mode (sem JSON Schema nativo),
 * então o "structured output" é JSON mode + validação zod em `askJson`, com
 * retry quando a forma vem errada. Depois disso, `normalizarIntent` confere
 * contra o próprio pedido o que não pode ficar na mão do modelo (preço,
 * público explícito, atributo inventado).
 */

const SYSTEM = `Você é um interpretador de intenção de busca de produtos.

Sua função é transformar a descrição fornecida pelo administrador em uma
estrutura objetiva para pesquisar produtos na Shopee Brasil.

Você NÃO pesquisa produtos.
Você NÃO recomenda produtos.
Você NÃO inventa informações.
Você NÃO gera links.
Você NÃO responde ao consumidor.

Responda SOMENTE com JSON válido.`;

function prompt(pedido: string): string {
  return `PEDIDO: ${pedido}

Extraia só o que é relevante pra busca:
- product: o produto principal, curto ("tênis de corrida", "cadeira de escritório")
- category / subcategory: categoria e subcategoria de loja ("calçados" / "tênis")
- audience: "masculino", "feminino", "infantil", "unissex" ou null se o pedido não diz
- brand: marcas citadas ou implicadas pelo modelo (iPhone → Apple); [] se nenhuma
- model: modelo específico ("15", "Galaxy S23") ou null
- color, size, material: só os citados
- purpose: finalidade ("corrida", "academia", "trabalho")
- features: características pedidas ("confortável", "4K", "50 polegadas", "gamer")
- priceMin / priceMax: orçamento em reais
- exclusions: o que o pedido recusa explicitamente ("sem ser usado" → "usado")
- keywords: 2 a 5 termos de busca
- confidence: 0 a 1, o quanto o pedido é claro

Orçamento:
- "até 200 reais" → priceMax 200
- "menos de 150" → priceMax 150
- "entre 100 e 200" → priceMin 100, priceMax 200
- "por volta de 300" → priceMin 270, priceMax 330
- "barato", "em conta", sem número → priceMin null, priceMax null. NÃO invente limite.

Keywords:
- Curtas (2 a 4 palavras), do jeito que se digita na busca da Shopee.
- Representam o produto e as características MAIS importantes do pedido.
- Sem preço, sem "barato", "promoção", "desconto" — o preço é filtrado depois.
- Variações úteis: sinônimo comum ("corrida" / "running"), com e sem a cor.
- Não acrescente característica que o pedido não tem.

EXEMPLO
pedido "tênis de corrida masculino preto até 200 reais" →
{"product":"tênis de corrida","category":"calçados","subcategory":"tênis","audience":"masculino","brand":[],"model":null,"color":["preto"],"size":[],"material":[],"purpose":["corrida"],"features":[],"priceMin":null,"priceMax":200,"keywords":["tênis corrida masculino","tênis running masculino","tênis corrida preto masculino"],"exclusions":[],"confidence":0.95}`;
}

/** A chamada à IA, isolada pra ser trocada por mock nos testes. */
export type Interpretador = (pedido: string) => Promise<unknown>;

const daIA: Interpretador = (pedido) =>
  askJson(
    intentSchema,
    [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: prompt(pedido) },
    ],
    900,
    // Extração, não copy: temperatura baixa pra não "criar" atributo.
    0.1,
  );

export async function interpretarPedido(
  pedido: string,
  perguntar: Interpretador = daIA,
): Promise<{ intent: SearchIntent; avisos: string[] }> {
  if (perguntar === daIA && !aiEnabled()) {
    throw new Error('REMOTE_AI_API_KEY não está no .env — a busca sob demanda precisa da IA pra ler o pedido.');
  }
  // Validado aqui também (não só no `askJson`): o mock dos testes passa pelo
  // mesmo schema que a resposta real.
  const raw: IntentDaIA = intentSchema.parse(await perguntar(pedido));
  return normalizarIntent(raw, pedido);
}
