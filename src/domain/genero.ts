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

/** Como o gênero aparece pra pessoa, no aviso do terminal e nos prompts. */
export const rotuloGenero: Record<Genero, string> = {
  m: 'masculino',
  f: 'feminino',
};
