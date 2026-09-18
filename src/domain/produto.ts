/**
 * O que o produto É, lido do título.
 *
 * O scoring mede se o DESCONTO é real, mas não se o produto é o que o título
 * promete. "Perfume Importado Premium" por R$ 10,90 tem preço real — só que é
 * contratipo, frasco pequeno ou refil, e o grupo lê "perfume de grife barato".
 * Um membro reclamou exatamente disso: preço bom demais pra ser verdade faz a
 * pessoa desconfiar do grupo inteiro, não só do produto.
 *
 * Por enquanto só perfume, que é onde a distância entre o título e o produto é
 * maior. Outra categoria entra aqui com as suas próprias regras.
 */

export type Tipo = 'original' | 'inspirado' | 'refil' | 'amostra' | 'body_splash' | 'sem_marca';
type Faixa = 'grife' | 'arabe' | 'popular';

export interface Produto {
  categoria: 'perfume' | null;
  /** Volume de UMA unidade. Com faixa de variações, o menor — é o do menor preço. */
  ml: number | null;
  qtd: number;
  tipo: Tipo;
  marca: string | null;
  faixa: Faixa | null;
  /** Preço por ml do conjunto (kit inteiro), quando o volume é conhecido. */
  precoMl: number | null;
}

/**
 * Menor R$/ml plausível pra cada faixa de marca.
 *
 * Grife de 100ml não sai por menos de ~R$ 250 nem em cinza/tester; árabe
 * (Lattafa, Armaf) roda R$ 100-250; nacional popular chega a R$ 30-60 em
 * promoção. Abaixo disso a marca no título é mentira.
 */
const PISO_ML: Record<Faixa, number> = { grife: 2.5, arabe: 0.7, popular: 0.3 };

/**
 * Sem volume no título e abaixo disto, não dá pra dizer o que a pessoa recebe.
 * Perfume sem marca por menos de R$ 60 é quase sempre frasco pequeno ou refil.
 */
const PISO_SEM_TAMANHO = 60;

/** Grife de 30ml, o menor frasco comum — abaixo disso nem o menor tamanho fecha. */
const ML_MINIMO_GRIFE = 30;

const MARCAS: { faixa: Faixa; nome: string; re: RegExp }[] = [
  ...[
    ['Dior', /\b(dior|sauvage)\b/],
    ['Chanel', /\bchanel\b/],
    ['Paco Rabanne', /\b(paco rabanne|1 million|one million|invictus|phantom)\b/],
    ['Carolina Herrera', /\b(carolina herrera|212 (vip|men|sexy)|bad boy|good girl)\b/],
    ['Armani', /\b(giorgio armani|armani code|acqua di gio|stronger with you)\b/],
    ['Versace', /\b(versace|eros flame)\b/],
    ['Dolce & Gabbana', /\b(dolce (& |e |and )?gabbana|light blue)\b/],
    ['Hugo Boss', /\bhugo boss\b/],
    ['Azzaro', /\bazzaro\b/],
    ['Jean Paul Gaultier', /\b(jean paul gaultier|le male|ultra male)\b/],
    ['Montblanc', /\bmont ?blanc\b/],
    ['YSL', /\b(yves saint laurent|ysl)\b/],
    ['Lancôme', /\b(lancome|la vie est belle)\b/],
    ['Calvin Klein', /\b(calvin klein|ck one)\b/],
    ['Givenchy', /\bgivenchy\b/],
    ['Prada', /\bprada\b/],
    ['Burberry', /\bburberry\b/],
    ['Valentino', /\bvalentino\b/],
    ['Bvlgari', /\b(bvlgari|bulgari)\b/],
    ['Tom Ford', /\btom ford\b/],
    ['Creed', /\b(creed|aventus)\b/],
    ['Guerlain', /\bguerlain\b/],
    ['Mugler', /\bmugler\b/],
    ['Kenzo', /\bkenzo\b/],
  ].map(([nome, re]) => ({ faixa: 'grife' as const, nome: nome as string, re: re as RegExp })),
  ...[
    ['Lattafa', /\b(lattafa|asad|khamrah|fakhar)\b/],
    ['Armaf', /\b(armaf|club de nuit)\b/],
    ['Afnan', /\bafnan\b/],
    ['Rasasi', /\brasasi\b/],
    ['Al Wataniah', /\bal wataniah\b/],
    ['Maison Alhambra', /\bmaison alhambra\b/],
    ['French Avenue', /\bfrench avenue\b/],
    ['Orientica', /\borientica\b/],
  ].map(([nome, re]) => ({ faixa: 'arabe' as const, nome: nome as string, re: re as RegExp })),
  ...[
    ['Natura', /\b(natura|kaiak|essencial)\b/],
    ['O Boticário', /\b(boticario|malbec|quasar|egeo)\b/],
    ['Eudora', /\beudora\b/],
    ['Jequiti', /\bjequiti\b/],
    ['Avon', /\bavon\b/],
    ['Antonio Banderas', /\bantonio banderas\b/],
  ].map(([nome, re]) => ({ faixa: 'popular' as const, nome: nome as string, re: re as RegExp })),
];

const PERFUME = /\b(perfume|perfumes|parfum|eau de (parfum|toilette)|edp|edt|colonia|fragrancia|body splash|body mist)\b/;
const AMOSTRA = /\b(amostra|decant|miniatura|mini)\b/;
const REFIL = /\b(refil|refill)\b/;
const INSPIRADO = /\b(inspirad[oa]s?|contratipo|similar|referencia|replica|versao)\b/;
const SPLASH = /\b(body splash|splash|body mist)\b/;

const normalizar = (t: string) =>
  t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ');

function volume(t: string): number | null {
  const achados = [...t.matchAll(/(\d{1,4}(?:[.,]\d)?)\s*ml\b/g)]
    .map((m) => Number(m[1]!.replace(',', '.')))
    .filter((n) => n > 0 && n <= 1000);
  return achados.length ? Math.min(...achados) : null;
}

function quantidade(t: string): number {
  const m =
    /\bkit\s*(?:c\/|com)?\s*(\d{1,2}(?:\/\d{1,2})*)\b/.exec(t) ??
    /\b(\d{1,2}(?:\/\d{1,2})*)\s*(?:unidades|unid|un|pcs|pecas|frascos|perfumes)\b/.exec(t) ??
    /\b(\d{1,2})\s*x\s*\d{1,4}\s*ml\b/.exec(t);
  // "Kit 12/6/3" é variação: o preço mostrado é o do menor kit.
  const n = m ? Math.min(...m[1]!.split('/').map(Number)) : 1;
  return n >= 1 && n <= 24 ? n : 1;
}

export function analisarProduto(titulo: string, preco: number): Produto {
  const t = normalizar(titulo);
  const nada: Produto = {
    categoria: null, ml: null, qtd: 1, tipo: 'sem_marca', marca: null, faixa: null, precoMl: null,
  };
  if (!PERFUME.test(t)) return nada;

  const ml = volume(t);
  const qtd = quantidade(t);
  const achada = MARCAS.find((m) => m.re.test(t)) ?? null;

  // "Inspirado no Sauvage" cita a marca como referência, não como produto —
  // por isso inspirado vem antes da marca.
  const tipo: Tipo = INSPIRADO.test(t)
    ? 'inspirado'
    : AMOSTRA.test(t)
      ? 'amostra'
      : REFIL.test(t)
        ? 'refil'
        : SPLASH.test(t)
          ? 'body_splash'
          : achada
            ? 'original'
            : 'sem_marca';

  const comMarca = tipo !== 'inspirado' && achada;
  return {
    categoria: 'perfume',
    ml,
    qtd,
    tipo,
    marca: comMarca ? achada.nome : null,
    faixa: comMarca ? achada.faixa : null,
    precoMl: ml ? preco / (ml * qtd) : null,
  };
}

/**
 * O preço fecha com o que o título diz? `null` = fecha; senão, o motivo.
 *
 * Barato e honesto passa: contratipo de 100ml por R$ 25 é oferta de verdade,
 * a mensagem só precisa dizer que é contratipo. O que cai é o que não dá pra
 * anunciar sem enganar alguém.
 */
export function precoIncompativel(p: Produto, preco: number): string | null {
  if (p.categoria !== 'perfume') return null;

  // Body splash da marca custa uma fração do perfume dela; o piso não vale.
  if (p.faixa && p.tipo !== 'body_splash') {
    const piso = PISO_ML[p.faixa];
    if (p.precoMl !== null && p.precoMl < piso) return 'provavel_falsificado';
    if (p.ml === null && p.faixa === 'grife' && preco < piso * ML_MINIMO_GRIFE) {
      return 'provavel_falsificado';
    }
  }

  if (p.ml === null && preco < PISO_SEM_TAMANHO) return 'tamanho_desconhecido';
  return null;
}

const ROTULO: Record<Tipo, string> = {
  original: '🏷️ Marca',
  inspirado: '🧪 Inspirado em perfume famoso (não é o original)',
  refil: '🔁 Refil',
  amostra: '💧 Amostra / decant',
  body_splash: '🌸 Body splash (mais leve que perfume)',
  sem_marca: '🧪 Sem marca de grife',
};

const reais = (v: number) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);

/** A linha que diz o que a pessoa recebe. `null` fora das categorias conhecidas. */
export function rotuloProduto(p: Produto): string | null {
  if (!p.categoria) return null;

  const partes = [p.tipo === 'original' && p.marca ? `${ROTULO.original}: ${p.marca}` : ROTULO[p.tipo]];
  if (p.ml) partes.push(p.qtd > 1 ? `Kit ${p.qtd} × ${p.ml}ml` : `${p.ml}ml`);
  else if (p.qtd > 1) partes.push(`Kit ${p.qtd}`);
  if (p.precoMl !== null) partes.push(`${reais(p.precoMl)}/ml`);
  return partes.join(' · ');
}

/**
 * Título sem as promessas que o rótulo não sustenta.
 *
 * "Importado Premium Original" é palavra-chave de vendedor, não fato. Fica só
 * quando a marca foi reconhecida — e mesmo aí "importado" continua sendo dele.
 */
export function tituloHonesto(titulo: string, p: Produto): string {
  if (p.categoria !== 'perfume' || p.tipo === 'original') return titulo;
  return titulo
    .replace(/\b(importad[oa]s?|premium|original|luxo|grife)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
