import { z } from 'zod';
import { config } from '../infra/config.js';
import { logger } from '../infra/logger.js';

const log = logger.child({ mod: 'ai' });

/** Sem chave a IA fica desligada; só o `--tema` degrada, o resto exige. */
export function aiEnabled(): boolean {
  return Boolean(config.REMOTE_AI_API_KEY);
}

interface Msg {
  role: 'system' | 'user';
  content: string;
}

/**
 * Endpoint compatível com OpenAI (Groq, por padrão).
 *
 * JSON mode em vez de "responda em JSON, por favor": o modelo é obrigado a
 * fechar um objeto válido, o que mata a falha mais comum aqui — o modelo
 * cumprimentando antes da primeira chave.
 */
/** O principal e as reservas, em ordem de preferência. */
const MODELOS = [
  config.REMOTE_AI_MODEL,
  ...config.REMOTE_AI_FALLBACKS.split(',').map((m) => m.trim()),
].filter((m, i, todos) => m && todos.indexOf(m) === i);

async function chamar(
  model: string,
  messages: Msg[],
  maxTokens: number,
  temperature: number,
): Promise<string> {
  const res = await fetch(`${config.REMOTE_AI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.REMOTE_AI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
      // O gpt-oss gastava mais tokens pensando do que escrevendo: 3.789 de
      // raciocínio pra 1.993 de JSON, medido no prompt do plano. Em "low" caiu
      // pra 473 e o JSON saiu maior e válido. Não é economia de centavo — é o
      // que decide se a chamada cabe nos 8.000 tokens/min da cota.
      ...(/gpt-oss/.test(model) ? { reasoning_effort: 'low' } : {}),
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    // 400 chars porque a informação que importa vem no fim: o "Please try again
    // in 31.56s" e o "(TPD)" ficavam os dois fora quando isto cortava em 180 —
    // o corte caía exatamente em "tokens per minute (TPM): Limit".
    const err = new Error(`HTTP ${res.status} — ${(await res.text()).slice(0, 400)}`);
    // Chave inválida não melhora trocando de modelo; cota e modelo inexistente,
    // sim. Só o primeiro caso é fatal de verdade.
    if (res.status === 401 || res.status === 403) {
      (err as Error & { fatal?: boolean }).fatal = true;
    }
    throw err;
  }

  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = body.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('respondeu vazio');
  return text;
}

/**
 * Uma resposta, tentando os modelos em ordem.
 *
 * Cada modelo tem sua própria cota por minuto na Groq — 8.000 tokens/min cada.
 * Bater no limite do principal não é motivo pra falhar: é motivo pra usar o
 * próximo. O que NÃO serve de reserva é o groq/compound-mini: ele roteia por
 * dentro pro openai/gpt-oss-120b (o 429 dele cita o gpt-oss pelo nome), então
 * herda exatamente a cota da qual se está fugindo.
 */
async function complete(messages: Msg[], maxTokens: number, temperature: number): Promise<string> {
  let ultimo: Error | null = null;

  for (const [i, model] of MODELOS.entries()) {
    try {
      const texto = await chamar(model, messages, maxTokens, temperature);
      if (i > 0) log.info({ model }, 'respondido pelo modelo de reserva');
      return texto;
    } catch (err) {
      const motivo = (err as Error).message;
      ultimo = new Error(`${model}: ${motivo}`);

      // O marcador tem que viajar junto: sem isso o `askJson` retentava três
      // vezes uma chave inválida, que não melhora nem trocando de modelo.
      if ((err as Error & { fatal?: boolean }).fatal) {
        (ultimo as Error & { fatal?: boolean }).fatal = true;
        throw ultimo;
      }

      if (i < MODELOS.length - 1) {
        log.warn(`${model} falhou (${motivo.slice(0, 90)}) — tentando ${MODELOS[i + 1]}`);
      }
    }
  }

  throw ultimo ?? new Error('IA indisponível');
}

/**
 * Quanto esperar antes da próxima tentativa.
 *
 * A Groq diz o número exato no corpo do 429 ("Please try again in 31.56s"),
 * porque a cota é um balde que reenche continuamente e ela sabe o quanto falta.
 * Chutar 20s era sempre pouco: uma chamada do plano reserva ~2.300 tokens e o
 * balde reenche a 133/s, então 20s devolvem menos da metade do necessário.
 */
function esperaDe(msg: string): number {
  const m = /try again in ([\d.]+)s/i.exec(msg);
  if (m) return Math.min(Number(m[1]) * 1000 + 500, 65_000);
  if (msg.includes('429')) return 40_000;
  // Erro de formato costuma passar já na segunda tentativa: a espera é simbólica.
  return 500;
}

/**
 * Uma tentativa de retry: erro de formato aqui é quase sempre transitório.
 *
 * A `temperature` padrão é 0.9 porque quase tudo aqui é copy, e copy repetida
 * é copy morta. Quem faz EXTRAÇÃO (ler um tema e devolver termos de busca) deve
 * pedir uma temperatura baixa: a 0.9 o modelo trata o exemplo do prompt como
 * sugestão criativa e devolve o exemplo em vez da resposta.
 *
 * O teto de 2.500 é medido, não chutado: o JSON do plano dá ~2.100 tokens e o
 * raciocínio em "low" some em 473. E o teto não é só um limite — a Groq RESERVA
 * o `max_tokens` inteiro antes de gerar a primeira letra ("Requested 4826" num
 * limite de 8.000, com max_tokens 5000). Com 5000 cabia UMA chamada por minuto;
 * com 2.500 cabem três.
 */
export async function askJson<T>(
  schema: z.ZodType<T>,
  messages: Msg[],
  maxTokens = 2500,
  temperature = 0.9,
): Promise<T> {
  let last: Error | null = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const raw = await complete(messages, maxTokens, temperature);
      const parsed = schema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
      last = new Error(z.prettifyError(parsed.error).slice(0, 200));
    } catch (err) {
      last = err as Error;
      if ((err as Error & { fatal?: boolean }).fatal) throw err;
    }

    if (attempt === 3) break;

    // Cota POR DIA (TPD) não volta esperando. Insistir só faz o comando travar
    // um minuto antes de falhar do mesmo jeito.
    if (/TPD|per day/i.test(last?.message ?? '')) {
      throw new Error(
        'Cota diária da IA esgotada (TPD). Ela volta na virada do dia — ' +
          'ou troque REMOTE_AI_MODEL / REMOTE_AI_API_KEY no .env.',
      );
    }

    const espera = esperaDe(last?.message ?? '');
    log.warn(`IA falhou (tentativa ${attempt}), nova em ${espera / 1000}s — ${last?.message}`);
    await new Promise((r) => setTimeout(r, espera));
  }

  throw last ?? new Error('IA indisponível');
}
