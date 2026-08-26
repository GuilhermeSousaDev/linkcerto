import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

/** Minimal .env loader. Real env vars win over the file. */
function loadDotEnv(path = resolve(process.cwd(), '.env')): void {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

const schema = z.object({
  LOG_LEVEL: z.string().default('info'),
  /** Postgres do docker-compose.yml. Suba com "npm run db:up". */
  DATABASE_URL: z
    .string()
    .default('postgres://alerta:alerta@localhost:5433/alerta'),

  // ── Shopee ──
  SHOPEE_APP_ID: z.string().default(''),
  SHOPEE_APP_SECRET: z.string().default(''),
  SHOPEE_API_URL: z.string().default('https://open-api.affiliate.shopee.com.br/graphql'),
  SHOPEE_SUB_ID: z.string().default('wa-group'),
  /** Feed pages per run. Pages are disjoint, so pages x size = products seen. */
  SHOPEE_PAGES: z.coerce.number().int().min(1).max(20).default(5),
  SHOPEE_PAGE_SIZE: z.coerce.number().int().min(1).max(100).default(50),
  /**
   * Termos de busca, separados por vírgula — define o nicho do grupo.
   * Vazio = feed geral de mais vendidos (produto aleatório, funil incoerente).
   * Cada termo custa SHOPEE_PAGES chamadas, então use 3-6 termos e menos páginas.
   */
  SHOPEE_KEYWORDS: z.string().default(''),

  // ── Filters ──
  MIN_RATING: z.coerce.number().min(0).max(5).default(4.3),
  MIN_SALES: z.coerce.number().int().min(0).default(100),
  /** Minimum discount to bother sending. */
  MIN_DISCOUNT: z.coerce.number().min(0).max(1).default(0.2),
  /**
   * Corte visual da foto (0-1). Abaixo disso a imagem é recorte de catálogo em
   * fundo branco, que no vídeo entrega cara de marketplace. Ver imagescore.ts.
   */
  MIN_IMAGE_SCORE: z.coerce.number().min(0).max(1).default(0.45),
  /** Above this, it's a pricing error or bait, not a deal. */
  MAX_DISCOUNT: z.coerce.number().min(0).max(1).default(0.9),
  /**
   * Quantas ofertas mostrar/enviar por execução — vale pro `deals`, `send` e
   * `photos`. No `send` isso é o número de mensagens no WhatsApp: 15 leva uns
   * 3-4 minutos com o intervalo aleatório, e lote maior = mais risco de bloqueio
   * no cliente não-oficial.
   */
  TOP_N: z.coerce.number().int().min(1).default(15),
  /** Don't resend an item unless it's this much cheaper than when last sent. */
  RESEND_DROP: z.coerce.number().min(0).max(1).default(0.05),
  /**
   * Dias que um produto fica fora dos posts depois de virar card.
   *
   * O ranking é estável — sem essa janela o post de hoje sai igual ao de
   * ontem, porque os mesmos campeões seguem no topo por semanas. Vale só pro
   * conteúdo (`photos`, `ideia`); o WhatsApp tem a própria regra (RESEND_DROP).
   */
  POST_COOLDOWN_DAYS: z.coerce.number().int().min(0).default(14),
  /**
   * Continuar medindo o preço dos produtos que JÁ estão no banco.
   *
   * `false` (padrão) grava só o que você escolhe: o banco para de crescer, mas
   * o baseline medido também para — ele precisa de BASELINE_MIN_SNAPSHOTS
   * leituras do MESMO produto ao longo de BASELINE_MIN_DAYS dias.
   * `true` mantém o histórico vivo sem deixar produto novo entrar.
   */
  RECORD_KNOWN: z.stringbool().default(false),
  /** Janela do `--db`: leitura mais velha que isso não vira post nem envio. */
  DB_MAX_AGE_DAYS: z.coerce.number().int().min(1).default(7),

  // ── Price-history baseline (used automatically once enough data exists) ──
  BASELINE_MIN_SNAPSHOTS: z.coerce.number().int().min(2).default(8),
  BASELINE_MIN_DAYS: z.coerce.number().min(0).default(14),

  // ── Identidade (o resto do texto quem escreve é a IA) ──
  /** Pílula do slide final. É instrução, não copy — por isso não varia. */
  CTA_TEXT: z.string().default('LINK NA BIO'),
  /** Aparece no slide final, se preenchido. Ex: @alertadepreco */
  PROFILE_HANDLE: z.string().default(''),
  /**
   * Convite do grupo. Vai pro 00-LEGENDA.txt como referência, pra você colar
   * no direct — nunca na legenda do post: link de convite em legenda do TikTok
   * não é clicável e conta como spam.
   */
  GRUPO_URL: z.string().default(''),
  /**
   * A palavra que o seguidor comenta pra receber o convite no direct.
   *
   * É o CTA de todo post: comentário empurra o vídeo no algoritmo e ainda abre
   * a janela de mensagem, coisa que "link na bio" não faz — e a bio do TikTok
   * só aceita link clicável em conta Business. Vazio volta a apontar pra bio.
   */
  GRUPO_PALAVRA: z.string().default('LINK'),

  // ── IA (obrigatória pro conteúdo) ──
  /**
   * Sem chave não sai post: `photos` e `ideia` param com erro em vez de gerar
   * card genérico. Qualquer endpoint compatível com OpenAI serve — padrão Groq.
   */
  REMOTE_AI_API_KEY: z.string().default(''),
  REMOTE_AI_BASE_URL: z.string().default('https://api.groq.com/openai/v1'),
  REMOTE_AI_MODEL: z.string().default('openai/gpt-oss-120b'),
  /**
   * Modelos de reserva, em ordem, quando o principal bate no limite.
   *
   * Cada modelo tem seu próprio balde de 8.000 tokens/min, então a reserva só
   * ajuda se for um modelo de verdade. Dois candidatos saíram daqui por não
   * serem: o qwen/qwen3.6-27b devolve HTTP 400 json_validate_failed com o
   * prompt do plano mesmo de balde cheio (o <think> dele estoura o max_tokens
   * antes de fechar o JSON), e o groq/compound-mini roteia por dentro pro
   * gpt-oss-120b — os 70.000 tokens/min dele são de fachada, o 429 que ele
   * devolve cita o gpt-oss pelo nome.
   */
  REMOTE_AI_FALLBACKS: z.string().default('openai/gpt-oss-20b'),
  /**
   * Pra quem o grupo fala, em uma linha. É o campo que mais muda a qualidade do
   * texto: "mulher 25-40 que compra por impulso e adora mostrar achado barato"
   * gera copy diferente de "homem que quer parecer arrumado gastando pouco".
   */
  AI_PUBLICO: z.string().default(''),

  // ── WhatsApp ──
  WA_AUTH_DIR: z.string().default('./data/wa-auth'),
  WA_GROUP_JID: z.string().default(''),
  /**
   * Grupo pessoal usado só como ponte pro celular: o `photos:send` manda os
   * cards pra cá pra você baixar e postar no TikTok pelo app.
   */
  WA_PERSONAL_GROUP_JID: z.string().default(''),
  WA_MIN_DELAY_MS: z.coerce.number().int().min(0).default(8000),
  WA_MAX_DELAY_MS: z.coerce.number().int().min(0).default(20000),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid configuration:\n' + z.prettifyError(parsed.error));
  process.exit(1);
}

export const config = parsed.data;
