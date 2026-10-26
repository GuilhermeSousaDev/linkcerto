/**
 * Quando o envio automático roda.
 *
 * Não calcula "a próxima execução" com um setTimeout longo: se o PC dorme às
 * 11h e acorda às 15h, o timer do meio-dia dispara às 15h e o grupo recebe
 * oferta fora de hora. Em vez disso o agendador olha o relógio a cada pouco e
 * só roda se estiver DENTRO da janela do horário. Horário perdido fica perdido.
 */

/** Minutos depois do horário em que ainda vale rodar. */
export const JANELA_MIN = 10;

export function lerHorarios(texto: string): { h: number; m: number }[] {
  return texto
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => {
      const [h, m] = t.split(':').map(Number);
      if (h === undefined || m === undefined || h > 23 || m > 59) {
        throw new Error(`Horário inválido: "${t}" (use HH:MM)`);
      }
      return { h, m };
    });
}

/**
 * A chave do horário que está valendo agora ("2026-10-19 12:00"), ou null.
 *
 * A chave é o que impede a mesma janela de rodar duas vezes: o agendador
 * guarda a última que rodou e ignora quando ela volta.
 */
export function horarioDaVez(agora: Date, horarios: { h: number; m: number }[]): string | null {
  const minutos = agora.getHours() * 60 + agora.getMinutes();
  for (const { h, m } of horarios) {
    const inicio = h * 60 + m;
    if (minutos >= inicio && minutos < inicio + JANELA_MIN) {
      const dia = [agora.getFullYear(), agora.getMonth() + 1, agora.getDate()]
        .map((n) => String(n).padStart(2, '0'))
        .join('-');
      return `${dia} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }
  }
  return null;
}

/**
 * Sorteia o nicho do envio, sem repetir os últimos.
 *
 * `recentes` vem do mais novo pro mais velho. Só entra no sorteio quem não está
 * entre os últimos `metade` usados: com 11 nichos, o mesmo só volta depois de
 * uns 5 envios, então o grupo não vê perfume duas vezes no mesmo dia.
 */
export function sortearNicho<T extends { nome: string }>(
  nichos: T[],
  recentes: string[],
  aleatorio: () => number = Math.random,
): T | null {
  if (!nichos.length) return null;
  const evitar = new Set(recentes.slice(0, Math.floor(nichos.length / 2)));
  const livres = nichos.filter((n) => !evitar.has(n.nome));
  const pool = livres.length ? livres : nichos;
  return pool[Math.floor(aleatorio() * pool.length)] ?? null;
}
