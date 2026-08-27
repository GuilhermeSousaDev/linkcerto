import { createHash } from 'node:crypto';

/**
 * O código que vai impresso embaixo de cada produto da grade.
 *
 * Não vem da Shopee — a API de afiliado não tem campo de código nenhum (os 25
 * campos do `ProductOfferV2` só identificam produto por `itemId`/`shopId`, dois
 * inteiros longos que ninguém digita num comentário). O código é INVENÇÃO
 * nossa, e é o que transforma um post passivo em conversa: pra saber o preço e
 * o link, a pessoa precisa comentar o código. Comentário empurra o vídeo no
 * algoritmo e ainda abre a janela de direct — que é por onde o convite do grupo
 * passa.
 *
 * Derivado do id do produto, e não sorteado, por dois motivos: o mesmo produto
 * recebe sempre o mesmo código (dá pra responder um direct de três dias atrás
 * sem procurar em qual post ele saiu), e nada precisa ser gravado no banco pra
 * isso funcionar.
 */

/**
 * Sem vogal e sem I/O.
 *
 * Sem vogal, nenhum código consegue formar palavra — e "CU", "PT0" ou coisa
 * pior impressa em cima de um produto é o tipo de erro que só se descobre
 * depois de publicado. Sem I e O porque a pessoa digita no comentário olhando
 * do celular, e ali eles viram 1 e 0.
 */
const ALFABETO = 'BCDFGHJKLMNPQRSTVWXZ';
const BLOCOS = 3;
const POR_BLOCO = 3;

function derivar(semente: string): string {
  const bytes = createHash('sha256').update(semente).digest();
  let out = '';
  for (let i = 0; i < BLOCOS * POR_BLOCO; i++) {
    if (i > 0 && i % POR_BLOCO === 0) out += '-';
    out += ALFABETO[bytes[i]! % ALFABETO.length];
  }
  return out;
}

/** O código de um produto. Estável: mesmo id, mesmo código, sempre. */
export const codigo = (offerId: string): string => derivar(offerId);

/**
 * Os códigos de um post, garantidamente distintos.
 *
 * 20^9 combinações tornam colisão quase impossível, mas "quase" aqui custa
 * caro: dois produtos com o mesmo código no mesmo post e você não sabe qual
 * link mandar pra quem comentou. Colidiu, re-deriva com um sufixo até sair
 * diferente — e como o desempate é determinístico, o resultado continua estável
 * pra aquele conjunto.
 */
export function codigosDoPost(offerIds: string[]): Map<string, string> {
  const porId = new Map<string, string>();
  const usados = new Set<string>();

  for (const id of offerIds) {
    let c = codigo(id);
    for (let tentativa = 1; usados.has(c); tentativa++) c = derivar(`${id}#${tentativa}`);
    usados.add(c);
    porId.set(id, c);
  }
  return porId;
}
