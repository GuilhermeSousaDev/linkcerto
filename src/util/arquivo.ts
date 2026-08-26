import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';

/**
 * Os arquivos que um comando deixa pro próximo: o plano do `ideia` que o
 * `photos` renderiza, e o lote do `deals` que o `send` manda.
 */

export interface Salvo {
  file: string;
  raw: string;
  /** Horas desde que foi gravado. */
  idade: number;
}

/**
 * O mais recente da pasta, ou o que foi pedido pelo nome.
 *
 * Achado sozinho só vale se for recente: reaproveitar sem avisar o plano de uma
 * semana atrás seria pior que gerar um novo. Pedido explicitamente, vale a
 * qualquer idade — aí a escolha foi sua.
 */
export function ultimoSalvo(
  dir: string,
  escolhido: string | undefined,
  ignorar: boolean,
  horas = 6,
): Salvo | null {
  if (ignorar) return null;

  let file: string | undefined;
  if (escolhido && !escolhido.startsWith('--')) {
    file = escolhido;
  } else if (existsSync(dir)) {
    const ultimo = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .pop();
    if (ultimo) file = `${dir}/${ultimo}`;
  }

  if (!file || !existsSync(file)) {
    if (escolhido) throw new Error(`Arquivo não encontrado: ${file ?? escolhido}`);
    return null;
  }

  const idade = (Date.now() - statSync(file).mtimeMs) / 3_600_000;
  if (!escolhido && idade > horas) return null;

  return { file, raw: readFileSync(file, 'utf8'), idade };
}

export function salvar(dir: string, conteudo: string): string {
  mkdirSync(dir, { recursive: true });
  const file = `${dir}/${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
  writeFileSync(file, conteudo, 'utf8');
  return file;
}

export const idadeEmTexto = (h: number) => (h < 1 ? 'agora há pouco' : `${h.toFixed(0)}h atrás`);

/**
 * Pasta do dia, numerada se já existir card lá dentro.
 *
 * A segunda rodada do mesmo dia traz outros produtos (o cooldown troca a
 * lista), então os cards novos ficariam ao lado dos velhos e o `photos:send`
 * mandaria dois posts misturados. Nada é apagado — a pasta só ganha um número.
 */
export function pastaDoDia(raiz: string): string {
  const base = `${raiz}/${new Date().toISOString().slice(0, 10)}`;
  let dir = base;
  for (let n = 2; existsSync(dir) && readdirSync(dir).some((f) => f.endsWith('.jpg')); n++) {
    dir = `${base}-${n}`;
  }
  return dir;
}
