/** Leitura do argv. É o único lugar do projeto que toca em `process.argv`. */

const ARGV = process.argv;

/** O subcomando desta execução. */
export const comando = ARGV[2] ?? 'help';

export function flag(nome: string): boolean {
  return ARGV.includes(`--${nome}`);
}

export function num(nome: string, padrao: number): number {
  const i = ARGV.indexOf(`--${nome}`);
  if (i === -1) return padrao;
  const v = Number(ARGV[i + 1]);
  return Number.isFinite(v) ? v : padrao;
}

export function texto(nome: string): string | undefined {
  const i = ARGV.indexOf(`--${nome}`);
  return i === -1 ? undefined : ARGV[i + 1];
}

/**
 * Como `texto`, mas junta tudo até a próxima opção.
 *
 * `--tema volta as aulas` funciona sem aspas. Esquecer as aspas era o erro mais
 * fácil de cometer, e o sintoma era silencioso: o post inteiro saía construído
 * em cima da palavra "volta".
 */
export function frase(nome: string): string | undefined {
  const i = ARGV.indexOf(`--${nome}`);
  if (i === -1) return undefined;

  const palavras: string[] = [];
  for (let j = i + 1; j < ARGV.length; j++) {
    const arg = ARGV[j]!;
    if (arg.startsWith('--')) break;
    palavras.push(arg);
  }
  return palavras.join(' ').trim() || undefined;
}

/** Lista de números: `--skip 1,4` → [1, 4]. */
export function numeros(nome: string): Set<number> {
  return new Set(
    (texto(nome) ?? '')
      .split(',')
      .map((n) => Number(n.trim()))
      .filter((n) => Number.isFinite(n) && n > 0),
  );
}
