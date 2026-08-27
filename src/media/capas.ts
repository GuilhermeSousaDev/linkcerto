import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { config } from '../infra/config.js';
import { logger } from '../infra/logger.js';

const log = logger.child({ mod: 'capas' });

/**
 * Biblioteca de retratos da capa.
 *
 * A capa é o único slide que decide se alguém para de deslizar, e foto de
 * produto desfocada não para ninguém — quem para é um rosto. Como não existe
 * geração de imagem de graça (checado: os 11 modelos com saída de imagem no
 * OpenRouter são todos pagos) e nenhum gerador desenha uma pessoa real de
 * verdade, a biblioteca é de arquivo mesmo: você põe as fotos, o código faz o
 * tratamento e a diagramação.
 *
 * Uma pasta por "casting" — o tipo de gente, não o nicho do produto. O tema do
 * post é livre, então o que amarra tema e foto é o tom: `luta` serve pra
 * academia e pra "produto que aguenta o tranco"; `rico` serve pra relógio,
 * perfume e "parece caro e custa pouco".
 */

/** O que conta como foto. */
const EXT = /\.(jpe?g|png|webp)$/i;

/**
 * Quando cada foto foi usada pela última vez.
 *
 * Fora de `assets/` de propósito: a pasta de fotos é sua, e um arquivo de
 * estado no meio dela é lixo. `data/` já é onde mora tudo que o programa
 * escreve sozinho.
 */
const USO = resolve('data/capas-uso.json');

/**
 * Ids do Pexels que já foram baixados alguma vez, por casting.
 *
 * É o que faz APAGAR valer alguma coisa. Sem isso, a curadoria não grudava: o
 * `capas:fetch` pede as N mais relevantes, e as ruins que você acabou de apagar
 * são exatamente as que voltam na próxima chamada, porque continuam relevantes.
 * Com o registro, completar a pasta sempre traz foto NOVA.
 */
const VISTAS = resolve('data/capas-vistas.json');

export interface Casting {
  /** Nome da pasta — é o que a IA devolve em `capa.casting`. */
  nome: string;
  /** Como a IA enxerga esse casting na hora de escolher. */
  descricao: string;
  /** Quantas fotos existem na pasta. */
  fotos: number;
}

export interface CastingDef {
  /** Como a IA enxerga esse casting na hora de escolher. */
  descricao: string;
  /** Termo do Pexels pro `capas:fetch`. Sem ele, a pasta é só manual. */
  busca?: string;
}

/** Onde o catálogo editável mora. Versionado — diferente das fotos. */
const ARQUIVO = resolve('capas.json');

/**
 * O catálogo que vem de fábrica, calibrado no que o perfil REALMENTE postou:
 * relógio, camisa social e polo, roupa de academia, fone de ouvido — e
 * perfume, que ainda não apareceu no banco mas está no plano. Tudo masculino,
 * porque 100% dos produtos postados até aqui são.
 *
 * Isto é semente, não regra: o `capas.json` na raiz ganha dele, e é lá que
 * você acrescenta um casting quando começar a vender outra coisa. Pasta criada
 * na mão também funciona sem estar em lugar nenhum — só entra no prompt da IA
 * com o próprio nome no lugar da descrição.
 */
const PADRAO: Record<string, CastingDef> = {
  comedia: {
    descricao: 'humor, cara de deboche, expressão de meme — post que faz rir',
    // Rosto CONHECIDO é o que funciona aqui, e isso não existe em banco livre.
    // A busca fica mesmo assim pra pasta não nascer vazia: cara de espanto
    // genérica segura um post enquanto você não põe as suas.
    busca: 'man laughing face close up',
  },
  luta: {
    descricao: 'lutador, boxe, MMA, intensidade — produto que aguenta pancada',
    busca: 'boxing man face portrait',
  },
  academia: {
    descricao: 'treino, musculação, suor — dry fit, short, camiseta de treino',
    busca: 'muscular man face portrait gym',
  },
  rico: {
    descricao: 'luxo, terno, ostentação — relógio, camisa social, "parece caro"',
    busca: 'businessman face portrait suit',
  },
  perfume: {
    descricao: 'homem arrumado, luz dramática, cara de cheiroso — perfumaria',
    busca: 'handsome man face portrait dark',
  },
  som: {
    descricao: 'fone de ouvido, música, foco — fone, caixa de som, áudio',
    busca: 'man listening music headphones face',
  },
};

/**
 * O catálogo em vigor: o `capas.json` quando existe, senão o padrão.
 *
 * JSON quebrado avisa alto em vez de cair no padrão em silêncio — descobrir
 * que a descrição editada não valeu, três posts depois, é pior que o erro.
 */
function definicoes(): Record<string, CastingDef> {
  if (!existsSync(ARQUIVO)) return PADRAO;

  try {
    const lido = JSON.parse(readFileSync(ARQUIVO, 'utf8')) as Record<string, CastingDef>;
    const ok: Record<string, CastingDef> = {};
    for (const [nome, def] of Object.entries(lido)) {
      if (def && typeof def.descricao === 'string' && def.descricao.trim()) {
        ok[nome] = { descricao: def.descricao, busca: def.busca };
      }
    }
    if (Object.keys(ok).length) return ok;
    log.warn(`${ARQUIVO} não tem nenhum casting válido — usando o catálogo padrão`);
  } catch (err) {
    log.warn(`${ARQUIVO} está quebrado (${(err as Error).message}) — usando o catálogo padrão`);
  }
  return PADRAO;
}

/** Onde as pastas moram. */
export const raiz = (): string => resolve(config.CAPAS_DIR);

const semAcento = (t: string) =>
  t.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();

export function fotosDe(nome: string): string[] {
  const dir = join(raiz(), nome);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => EXT.test(f))
      .sort()
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

/**
 * Os castings que existem DE VERDADE — pasta no disco com pelo menos uma foto.
 *
 * Pasta vazia não entra: oferecer pra IA um casting sem foto faz o plano
 * escolher uma capa que não vai poder ser renderizada, e o post cai no
 * fallback sem ninguém entender por quê.
 */
export function castings(): string[] {
  const dir = raiz();
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((nome) => fotosDe(nome).length > 0)
      .sort();
  } catch {
    return [];
  }
}

/** Catálogo pra impressão e pro prompt: o que existe, com quantas fotos. */
export function catalogo(): Casting[] {
  const defs = definicoes();
  return castings().map((nome) => ({
    nome,
    descricao: defs[nome]?.descricao ?? nome,
    fotos: fotosDe(nome).length,
  }));
}

/**
 * Casa o que a IA devolveu com uma pasta real.
 *
 * O modelo escreve "Luta", "luta", "lutador" e às vezes a descrição inteira.
 * Devolve `''` quando não casa nada — e aí a capa volta a ser a foto do produto
 * desfocada, que é feio mas nunca quebra.
 */
export function resolverCasting(pedido: string): string {
  const p = semAcento(pedido);
  if (!p) return '';

  const nomes = castings();
  const exato = nomes.find((n) => semAcento(n) === p);
  if (exato) return exato;

  // "lutador" acha "luta", e "capa de comédia" acha "comedia".
  return (
    nomes.find((n) => {
      const s = semAcento(n);
      return p.startsWith(s) || s.startsWith(p) || p.split(/\s+/).includes(s);
    }) ?? ''
  );
}

function lerUso(): Record<string, number> {
  try {
    return JSON.parse(readFileSync(USO, 'utf8')) as Record<string, number>;
  } catch {
    return {};
  }
}

/**
 * Uma foto do casting: a que faz mais tempo que não aparece.
 *
 * Rodízio e não sorteio, porque sorteio repete — com 6 fotos, a chance de cair
 * a mesma de ontem é 1 em 6, e capa repetida em dois dias seguidos é o mesmo
 * que capa fixa pra quem segue o perfil. O rodízio garante que as 6 saem antes
 * de qualquer uma sair de novo, e é a recorrência espaçada que dá cara de
 * perfil em vez de post avulso.
 */
export function pegarFoto(casting: string): string | null {
  const nome = resolverCasting(casting);
  if (!nome) return null;

  const fotos = fotosDe(nome);
  if (!fotos.length) return null;

  const uso = lerUso();
  const escolhida = fotos.reduce((a, b) => ((uso[a] ?? 0) <= (uso[b] ?? 0) ? a : b));

  uso[escolhida] = Date.now();
  try {
    mkdirSync(resolve('data'), { recursive: true });
    writeFileSync(USO, JSON.stringify(uso, null, 2), 'utf8');
  } catch (err) {
    // Perder o rodízio não justifica perder o post: sem o arquivo, a próxima
    // execução escolhe a primeira foto e segue.
    log.warn(`não consegui gravar o rodízio das capas (${(err as Error).message})`);
  }

  log.info({ casting: nome, foto: escolhida.split(/[\\/]/).pop() }, 'retrato da capa');
  return escolhida;
}

// ─── Encher as pastas ───────────────────────────────────────────────────────

interface PexelsFoto {
  id?: number;
  src?: { original?: string; large2x?: string; large?: string };
}

/**
 * Baixa retratos livres do Pexels pros castings que têm termo de busca.
 *
 * Existe porque as pastas de arquétipo (lutador, terno, beleza) não pedem
 * curadoria nenhuma — qualquer rosto com a luz certa serve, e o tratamento em
 * `cards.ts` uniformiza o resto. O que NÃO dá pra automatizar é `comedia`: ali
 * o que funciona é rosto que o público reconhece, e isso não existe em banco de
 * imagem livre. Essa pasta é sua.
 */
function lerVistas(): Record<string, number[]> {
  try {
    return JSON.parse(readFileSync(VISTAS, 'utf8')) as Record<string, number[]>;
  } catch {
    return {};
  }
}

export async function baixarDoPexels(
  quantas: number,
  aviso: (linha: string) => void,
): Promise<void> {
  const vistas = lerVistas();
  if (!config.PEXELS_API_KEY) {
    throw new Error(
      'PEXELS_API_KEY não está no .env.\n' +
        'Chave grátis e na hora em pexels.com/api — as fotos são de uso comercial\n' +
        'livre e sem atribuição obrigatória.',
    );
  }

  for (const [nome, { busca }] of Object.entries(definicoes())) {
    if (!busca) {
      aviso(`  ${nome.padEnd(10)} sem termo de busca no capas.json — pasta manual`);
      continue;
    }

    const dir = join(raiz(), nome);
    mkdirSync(dir, { recursive: true });

    const jaTem = fotosDe(nome).length;
    if (jaTem >= quantas) {
      aviso(`  ${nome.padEnd(10)} já tem ${jaTem} foto(s) — pulando`);
      continue;
    }

    const faltam = quantas - jaTem;
    const conhecidas = new Set(vistas[nome] ?? []);

    // Pede bem mais que o necessário: a maior parte do topo do ranking já foi
    // baixada em alguma rodada anterior, e é justamente essa parte que vai ser
    // pulada. Pedir só o que falta devolveria uma página inteira de repetidas.
    const url =
      'https://api.pexels.com/v1/search' +
      `?query=${encodeURIComponent(busca)}` +
      `&per_page=${Math.min(80, Math.max(faltam * 4, 15))}&orientation=portrait`;

    const res = await fetch(url, {
      headers: { authorization: config.PEXELS_API_KEY },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      throw new Error(`Pexels HTTP ${res.status} — ${(await res.text()).slice(0, 200)}`);
    }

    const body = (await res.json()) as { photos?: PexelsFoto[] };
    let baixadas = 0;

    for (const foto of body.photos ?? []) {
      if (baixadas >= faltam) break;

      // Já baixada alguma vez — inclusive se você apagou depois. Apagar é a
      // curadoria; trazer de volta o que foi recusado desfaz o seu trabalho.
      if (foto.id && conhecidas.has(foto.id)) continue;

      // `original`, não `large2x`: o large2x de retrato vem em 867x1300, e o
      // enquadramento da capa RECORTA dentro da foto pra achar o rosto — de
      // 867px de largura, o recorte já sai sendo ampliado pra 1080 e o card
      // fica mole. O original passa de 4000px e absorve o recorte.
      const link = foto.src?.original ?? foto.src?.large2x ?? foto.src?.large;
      if (!link) continue;

      // Nomeado pelo id do Pexels, não pela contagem da pasta. Com a contagem,
      // apagar as ruins e rodar de novo reescrevia as boas: sobrando 4 fotos,
      // o próximo download virava "pexels-05" e "pexels-06" — e o 06 que tinha
      // sobrado era justamente o sobrescrito.
      const dest = join(dir, `pexels-${foto.id ?? Date.now()}.jpg`);
      if (foto.id) conhecidas.add(foto.id);
      if (existsSync(dest)) continue;

      const img = await fetch(link, { signal: AbortSignal.timeout(30_000) });
      if (!img.ok) continue;

      writeFileSync(dest, Buffer.from(await img.arrayBuffer()));
      baixadas++;
    }

    vistas[nome] = [...conhecidas];
    const restam = quantas - fotosDe(nome).length;
    aviso(
      `  ${nome.padEnd(10)} ${baixadas} foto(s) nova(s) — "${busca}"` +
        (restam > 0 ? `  (o Pexels não tinha mais ${restam} inéditas)` : ''),
    );
  }

  try {
    mkdirSync(resolve('data'), { recursive: true });
    writeFileSync(VISTAS, JSON.stringify(vistas, null, 2), 'utf8');
  } catch (err) {
    log.warn(`não consegui gravar ${VISTAS} (${(err as Error).message})`);
  }
}

/**
 * Cria o `capas.json` e as pastas dele, cada uma com um LEIA-ME dentro.
 *
 * Rodar de novo é seguro: nada que já existe é sobrescrito. É o comando pra
 * chamar depois de acrescentar um casting no `capas.json`.
 */
export function preparar(): string {
  const criadas: string[] = [];
  const notas: string[] = [];

  if (!existsSync(ARQUIVO)) {
    writeFileSync(ARQUIVO, `${JSON.stringify(PADRAO, null, 2)}\n`, 'utf8');
    notas.push(`Catálogo criado em ${ARQUIVO} — edite ali pra acrescentar casting.`);
  }

  for (const [nome, { descricao, busca }] of Object.entries(definicoes())) {
    const dir = join(raiz(), nome);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      criadas.push(nome);
    }

    const leiaMe = join(dir, 'LEIA-ME.txt');
    if (existsSync(leiaMe)) continue;

    writeFileSync(
      leiaMe,
      [
        `CASTING "${nome}" — ${descricao}`,
        '',
        'Ponha aqui .jpg/.png/.webp. O código faz o resto: preto e branco,',
        'contraste duro, grão, e o recorte que procura o rosto sozinho.',
        '',
        'O que funciona:',
        '  - Retrato vertical, pessoa ocupando boa parte do quadro.',
        '  - Rosto olhando pra câmera, expressão forte.',
        '  - 1200px de altura pra cima; abaixo disso o card sai mole.',
        '  - Fundo qualquer: ele some no tratamento.',
        '',
        'O que não funciona: corpo inteiro de longe, grupo de pessoas, ou',
        'imagem que já vem com texto escrito em cima.',
        '',
        busca
          ? `Pra encher esta pasta sozinho: npm run capas:fetch (busca "${busca}")`
          : 'Sem termo de busca no capas.json: esta pasta é só manual.',
        '',
        nome === 'comedia'
          ? [
              'ESTA PASTA EM ESPECIAL: o que funciona aqui é rosto que o seu público',
              'RECONHECE, e banco de imagem livre não tem rosto conhecido — o que o',
              'capas:fetch traz é cara de espanto genérica, que segura mas não é a',
              'mesma coisa. As boas você põe à mão.',
              '',
              'Só lembre que rosto de pessoa real em post monetizado é uso comercial',
              'de imagem. Quem entra aqui é escolha sua.',
              '',
            ].join('\n')
          : '',
      ].join('\n'),
      'utf8',
    );
  }

  if (criadas.length) notas.push(`Pastas criadas: ${criadas.join(', ')}`);
  return notas.length ? notas.join('\n') : 'Catálogo e pastas já existiam — nada a fazer.';
}

/** Catálogo impresso, pro `npm run capas`. */
export function listarCapas(): string {
  const tem = catalogo();

  if (!tem.length) {
    return [
      `\nNenhuma capa em ${raiz()}\n`,
      'Crie as pastas com "npm run capas:prep", depois:',
      '  - npm run capas:fetch   enche as de arquétipo (Pexels, grátis)',
      '  - e ponha à mão as fotos de "comedia"',
      '',
      'Sem nenhuma capa o post continua saindo: a capa volta a ser a foto do',
      'produto desfocada, como era antes.',
      '',
    ].join('\n');
  }

  // Casting definido no catálogo que ainda não tem foto: some do prompt da IA
  // sem avisar, e a pessoa fica esperando uma capa que nunca vem.
  const vazios = Object.keys(definicoes()).filter((n) => !tem.some((c) => c.nome === n));

  return [
    `\nCapas em ${raiz()}:\n`,
    ...tem.map(
      (c) => `  ${c.nome.padEnd(10)} ${String(c.fotos).padStart(3)} foto(s)   ${c.descricao}`,
    ),
    ...(vazios.length
      ? ['', `Sem foto (a IA não vai poder escolher): ${vazios.join(', ')}`]
      : []),
    '',
    'A IA escolhe uma por post, a partir do --tema. As fotos entram em rodízio:',
    'a que faz mais tempo que não aparece é a próxima.',
    '',
    `Pra acrescentar um casting, edite ${ARQUIVO} e rode "npm run capas:prep".`,
    '',
  ].join('\n');
}
