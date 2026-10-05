/**
 * Pra quem é o produto DESTA rodada.
 *
 * Normalmente isso nem se decide: vem do `AI_PUBLICO` e não muda, porque o
 * perfil fala com um público só. O `--female` existe pra exceção — o mesmo
 * tema e o mesmo grupo, mas procurando a versão feminina do produto (dia das
 * mães, presente, teste de um nicho novo antes de mexer no `.env`).
 *
 * Sem a flag nada aqui roda e o comportamento é o de sempre.
 */
export type Genero = 'm' | 'f';

/** Par masculino/feminino de cada palavra que marca gênero num termo de busca. */
const PARES: [string, string][] = [
  ['masculino', 'feminino'],
  ['masculina', 'feminina'],
  ['masculinos', 'femininos'],
  ['masculinas', 'femininas'],
  ['homem', 'mulher'],
  ['homens', 'mulheres'],
  ['menino', 'menina'],
  ['meninos', 'meninas'],
];

/**
 * Reescreve termos de busca pro gênero pedido.
 *
 * SÓ TROCA o que já está marcado — nunca acrescenta. "fone de ouvido feminino"
 * é busca que quase não tem resultado na Shopee, então categoria sem gênero
 * (eletrônico, casa, cozinha, pet) passaria a não achar nada se a palavra fosse
 * grudada no fim. Termo neutro continua neutro; quem separa o que sobra é o
 * filtro de público, que olha título por título.
 *
 * É rede de segurança, não o caminho principal: quem monta os termos a partir
 * do tema é a IA, que já recebe o gênero. Isso aqui cobre o resto — nicho do
 * catálogo, `SHOPEE_KEYWORDS` e as vezes em que o modelo ignora a instrução.
 */
export function aplicarGenero(termos: string[], genero: Genero): string[] {
  const de = genero === 'f' ? 0 : 1;
  const para = genero === 'f' ? 1 : 0;

  return termos.map((termo) =>
    PARES.reduce(
      (t, par) => t.replace(new RegExp(`\\b${par[de]}\\b`, 'gi'), par[para]!),
      termo,
    ),
  );
}

/** Gênero do público, quando ele tem um. Só isso é decidível por regra. */
export function generoDoPublico(publico: string): Genero | null {
  const p = publico.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const m = /\b(homem|homens|masculin[oa]s?|rapaz|cara)\b/.test(p);
  const f = /\b(mulher|mulheres|feminin[oa]s?|menina|garota)\b/.test(p);
  if (m === f) return null; // os dois ou nenhum: não dá pra decidir por regra
  return m ? 'm' : 'f';
}

const UNISSEX = /\b(unissex|unisex|homens?\s+e\s+mulher|masculino\s+e\s+feminino|feminino\s+e\s+masculino)\b/;
const MARCA = {
  m: /\b(masculin[oa]s?|homem|homens|menino)\b/,
  f: /\b(feminin[oa]s?|mulher|mulheres|menina)\b/,
};

/**
 * Veredito por regra, quando o título é explícito.
 *
 * A IA sozinha errou nos dois sentidos no mesmo teste: deixou passar uma "…para
 * Academia Feminina" e derrubou uma "Calça Legging Masculina" achando que
 * legging é sempre feminino. Quando a palavra está escrita no título não há o
 * que interpretar — a regra decide e a IA não opina.
 *
 * `null` = não é explícito, deixa a IA julgar (cropped, suplex, corte).
 */
export function veredito(titulo: string, genero: Genero): 'dentro' | 'fora' | null {
  const t = titulo.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  if (UNISSEX.test(t)) return 'dentro';

  const oposto = genero === 'm' ? 'f' : 'm';
  const temMeu = MARCA[genero].test(t);
  const temOposto = MARCA[oposto].test(t);

  if (temMeu && temOposto) return 'dentro'; // "masculina e feminina" = serve
  if (temMeu) return 'dentro';
  if (temOposto) return 'fora';
  return null;
}

/** Como o gênero aparece pra pessoa, no aviso do terminal e nos prompts. */
export const rotuloGenero: Record<Genero, string> = {
  m: 'masculino',
  f: 'feminino',
};
