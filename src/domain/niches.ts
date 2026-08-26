import { config } from '../infra/config.js';

/**
 * Nichos prontos.
 *
 * Cada um é um conjunto de termos de busca que a Shopee entende bem. Escolher um
 * nicho é a decisão mais importante do grupo: quem entra por causa de um produto
 * e vê outros vinte sem relação silencia o grupo.
 *
 * `comissao` é a faixa típica observada nesses termos. Moda e acessórios pagam
 * bem mais que eletrônico — e como o formato é compra por impulso, ticket baixo
 * com comissão alta costuma render mais que o contrário.
 */
export interface Niche {
  keywords: string[];
  descricao: string;
  comissao: string;
}

const NICHES: Record<string, Niche> = {
  relogios: {
    keywords: ['relogio masculino', 'relogio feminino', 'smartwatch', 'relogio digital'],
    descricao: 'Relógios e smartwatches',
    comissao: 'alta (12-18%)',
  },
  perfumes: {
    keywords: ['perfume masculino', 'perfume feminino', 'body splash', 'perfume importado'],
    descricao: 'Perfumaria',
    comissao: 'alta (15-20%)',
  },
  roupas: {
    keywords: ['camisa masculina', 'camiseta oversized', 'vestido feminino', 'conjunto feminino'],
    descricao: 'Roupas em geral',
    comissao: 'alta (15-19%)',
  },
  'roupa-masculina': {
    keywords: ['camisa masculina', 'camiseta oversized masculina', 'bermuda masculina', 'calca masculina'],
    descricao: 'Moda masculina',
    comissao: 'alta (15-19%)',
  },
  'roupa-feminina': {
    keywords: ['vestido feminino', 'conjunto feminino', 'blusa feminina', 'saia feminina'],
    descricao: 'Moda feminina',
    comissao: 'alta (15-19%)',
  },
  sapatos: {
    keywords: ['tenis masculino', 'tenis feminino', 'sandalia feminina', 'sapato social masculino'],
    descricao: 'Calçados',
    comissao: 'alta (14-19%)',
  },
  academia: {
    keywords: ['roupa academia', 'top fitness', 'legging fitness', 'luva academia'],
    descricao: 'Fitness e treino',
    comissao: 'alta (14-18%)',
  },
  beleza: {
    keywords: ['maquiagem', 'skincare', 'batom', 'kit maquiagem'],
    descricao: 'Beleza e maquiagem',
    comissao: 'alta (15-20%)',
  },
  bolsas: {
    keywords: ['bolsa feminina', 'mochila', 'carteira masculina', 'necessaire'],
    descricao: 'Bolsas e mochilas',
    comissao: 'alta (14-18%)',
  },
  casa: {
    keywords: ['organizador cozinha', 'utensilios domesticos', 'decoracao casa', 'panela'],
    descricao: 'Casa e cozinha',
    comissao: 'média (8-14%)',
  },
  pet: {
    keywords: ['brinquedo pet', 'coleira cachorro', 'cama pet', 'comedouro pet'],
    descricao: 'Pet shop',
    comissao: 'média (10-15%)',
  },
  infantil: {
    keywords: ['roupa infantil', 'brinquedo educativo', 'kit bebe', 'tenis infantil'],
    descricao: 'Infantil e bebê',
    comissao: 'média (10-16%)',
  },
  eletronicos: {
    keywords: ['fone bluetooth', 'carregador rapido', 'caixa de som', 'mouse gamer'],
    descricao: 'Eletrônicos e acessórios',
    comissao: 'BAIXA (4-8%) — ticket maior, mas converte menos por impulso',
  },
  ferramentas: {
    keywords: ['kit ferramentas', 'parafusadeira', 'furadeira', 'chave de fenda'],
    descricao: 'Ferramentas',
    comissao: 'média (8-13%)',
  },
};

/**
 * Termos da busca. Uma única fonte: `--keywords` na linha de comando sobrescreve
 * `SHOPEE_KEYWORDS` do `.env`. Sem nenhum dos dois, cai no feed geral.
 *
 * Os nichos acima são catálogo, não configuração — `npm run niches` imprime a
 * linha pronta pra você colar no `.env`.
 */
export function keywords(override?: string): string[] {
  return (override ?? config.SHOPEE_KEYWORDS)
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
}

const semAcento = (t: string) =>
  t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/**
 * Acha o nicho pronto que corresponde a um pedido em texto livre.
 *
 * "academia", "Academia", "fitness", "roupa de academia" — tudo cai no mesmo
 * nicho. Existe porque `--tema academia` tem que buscar produto de academia, e
 * o catálogo aqui é melhor que qualquer termo que a IA invente na hora.
 */
export function findNiche(pedido: string): { nome: string; niche: Niche } | null {
  const p = semAcento(pedido);
  if (!p) return null;

  for (const [nome, niche] of Object.entries(NICHES)) {
    const n = semAcento(nome);
    if (p === n) return { nome, niche };
  }
  // Só depois de falhar no nome exato: aqui "relogio" acha "relogios" e
  // "roupa de academia" acha "academia", sem que "casa" engula "casaco".
  for (const [nome, niche] of Object.entries(NICHES)) {
    const n = semAcento(nome);
    const palavras = p.split(/\s+/);
    if (palavras.includes(n) || n.startsWith(p) || p.startsWith(n)) return { nome, niche };
  }
  return null;
}

/** Catálogo, com a linha já no formato do `.env` pra copiar. */
export function listNiches(): string {
  const rows = Object.entries(NICHES).map(([nome, n]) => {
    return [
      `  ${nome.padEnd(18)} ${n.descricao.padEnd(28)} comissão ${n.comissao}`,
      `  ${' '.repeat(18)} SHOPEE_KEYWORDS=${n.keywords.join(',')}`,
    ].join('\n');
  });
  return [
    '\nNichos sugeridos — copie a linha pro seu .env:\n',
    rows.join('\n\n'),
    '',
    'Ou teste sem editar o .env:',
    '  npm run photos -- --keywords "relogio masculino,smartwatch"',
    '',
  ].join('\n');
}
