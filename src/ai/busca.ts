import { z } from 'zod';
import { config } from '../infra/config.js';
import { aiEnabled, askJson } from './client.js';

const termosSchema = z.object({
  categoria: z.boolean().default(false),
  termos: z.array(z.string()).default([]),
});

/**
 * Converte o tema do post em termos de busca da Shopee.
 *
 * Existe porque "--tema academia" tem que trazer produto de academia. Antes o
 * tema só mudava o texto, e o post saía com camisa social e relógio embaixo de
 * uma capa escrita "treino" — o pedido do usuário e a busca não se falavam.
 *
 * Devolve `[]` quando o tema é ÂNGULO e não categoria ("achados que parecem
 * caros"): aí os termos configurados continuam valendo, senão um gancho
 * editorial sequestraria o nicho do perfil.
 *
 * Pede temperatura 0.2, contra os 0.9 do resto: aqui não se escreve nada, se
 * lê um tema. A 0.9 o "--tema fone" devolvia, uma vez em duas, "camiseta dry
 * fit masculina, short academia masculino" — o exemplo do próprio prompt,
 * palavra por palavra, empurrado pelo AI_PUBLICO ("homem que quer parecer
 * arrumado"). Por isso também os exemplos abaixo vêm em pares tema→termos e
 * nenhum deles é de roupa: exemplo de saída solto o modelo copia, exemplo que
 * mostra a relação ele aplica.
 */
export async function searchTerms(tema: string, atuais: string[]): Promise<string[]> {
  if (!aiEnabled()) return [];

  const raw = await askJson(
    termosSchema,
    [
      {
        role: 'system',
        content: `Você conhece a busca da Shopee Brasil e como brasileiro digita nela.
Responda SOMENTE com JSON válido.`,
      },
      {
        role: 'user',
        content: `TEMA PEDIDO: ${tema}
PÚBLICO DO PERFIL: ${config.AI_PUBLICO || 'não informado'}
TERMOS QUE O PERFIL USA HOJE: ${atuais.join(', ') || 'nenhum'}

O tema nomeia uma CATEGORIA de produto (academia, perfume, cozinha, frio,
praia, pet) ou é só um ÂNGULO editorial (achados que parecem caros, presente de
última hora, o que eu compraria de novo)?

- Categoria  → "categoria": true e 3 a 5 termos de busca.
- Ângulo     → "categoria": false e "termos": [] (os de hoje continuam valendo).

QUEM MANDA NA CATEGORIA É O TEMA. O público e os termos de hoje só recortam
DENTRO do que o tema pediu — eles nunca trocam a categoria. Se o tema é um
produto que o público não costuma comprar, o tema ainda ganha: quem digitou
sabe o que quer. Antes de responder, leia seus termos: se algum deles não é uma
instância do tema, ele está errado e você recomeça.

Regras dos termos:
- Curtos, 2 ou 3 palavras, do jeito que se digita numa busca.
- Sem marca, sem "barato", "promoção", "desconto", "kit" — a busca da Shopee
  não indexa isso bem e traz lixo.
- Gênero SÓ em categoria que tem gênero de verdade: roupa, calçado, perfume,
  acessório de vestir. Aí ele é obrigatório, porque "camiseta dry fit" traz peça
  feminina e "camiseta dry fit masculina" não. Eletrônico, casa, cozinha e pet
  não têm gênero: "fone de ouvido masculino" é uma busca que quase não tem
  resultado. Quando o público não for informado, use os termos de hoje como
  pista; sem os dois, prefira termos neutros a chutar um gênero.

EXEMPLOS — repare que o termo sempre carrega o TEMA, e o público entra só como
recorte (ou nem entra):
tema "cozinha", público "mulher que mora sozinha" →
{"categoria": true, "termos": ["jogo de panelas antiaderente", "potes hermeticos", "organizador de talheres"]}
tema "mochila", público "homem 20-40" →
{"categoria": true, "termos": ["mochila masculina notebook", "mochila casual masculina"]}
tema "o que eu compraria de novo", público "homem 20-40" →
{"categoria": false, "termos": []}`,
      },
    ],
    600,
    0.2,
  );

  if (!raw.categoria) return [];
  return raw.termos
    .map((t) => t.replace(/\s+/g, ' ').trim().toLowerCase())
    .filter((t) => t.length > 2)
    .slice(0, 5);
}
