import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { config } from './infra/config.js';
import { logger } from './infra/logger.js';
import { horarioDaVez, lerHorarios, sortearNicho } from './domain/agenda.js';
import { todosNichos } from './domain/niches.js';

/**
 * O envio pro grupo sem você: roda o `send` nos horários do AGENDA_HORARIOS.
 *
 * Processo de longa duração — é o que o container "agenda" executa. Cada envio
 * é um `cli.ts send` novo em vez de uma chamada aqui dentro: o CLI abre e
 * fecha banco e WhatsApp sozinho, e um envio que quebra não derruba a agenda.
 *
 * O nicho de cada envio é sorteado do catálogo (`npm run niches`), sem repetir
 * os últimos. Se o nicho não rende oferta que passe na curadoria, tenta outro.
 */

const TICK_MS = 30_000;
/** Quantos nichos tenta num mesmo horário antes de desistir. */
const TENTATIVAS = 3;
/** Um envio normal leva uns 3 minutos (os intervalos entre mensagens). */
const LIMITE_MIN = 15;
/** Espera antes de tentar de novo um envio que falhou. */
const RETRY_MIN = 10;
/** O CLI sai com isto quando o lote ficou vazio — ver `EXIT_NADA_ENVIADO`. */
const NADA_ENVIADO = 3;
const ESTADO = 'data/agenda-estado.json';

const horarios = lerHorarios(config.AGENDA_HORARIOS);
const fora = new Set(
  config.AGENDA_NICHOS_FORA.split(',').map((n) => n.trim()).filter(Boolean),
);
const nichos = todosNichos().filter((n) => !fora.has(n.nome));

/** Os últimos nichos, do mais novo pro mais velho. Sobrevive a reinício do container. */
function lerRecentes(): string[] {
  try {
    return existsSync(ESTADO) ? (JSON.parse(readFileSync(ESTADO, 'utf8')) as string[]) : [];
  } catch {
    return [];
  }
}

function lembrar(recentes: string[]): void {
  try {
    mkdirSync('data', { recursive: true });
    writeFileSync(ESTADO, JSON.stringify(recentes.slice(0, 20)));
  } catch (err) {
    logger.warn((err as Error).message);
  }
}

const enviar = (keywords: string[]): Promise<number> =>
  rodarCli([
    'send',
    // --novo: o lote salvo é de quem rodou o `deals` na mão, talvez ontem.
    '--novo',
    // As palavras do catálogo direto: sem gastar IA pra inventar termos.
    '--keywords', keywords.join(','),
    '--top', String(config.AGENDA_TOP),
  ]);

/**
 * Avisa no seu grupo pessoal. Se o problema for o próprio WhatsApp o aviso
 * também falha — fica só no log, sem derrubar a agenda.
 */
async function avisar(texto: string): Promise<void> {
  if (!config.WA_PERSONAL_GROUP_JID) return;
  const code = await rodarCli(['avisar', '--texto', `🤖 Agenda: ${texto}`]);
  if (code) logger.warn('não consegui mandar o aviso pro grupo pessoal');
}

function rodarCli(comando: string[]): Promise<number> {
  const args = ['--import', 'tsx', 'src/cli.ts', ...comando];
  return new Promise((res) => {
    const filho = spawn(process.execPath, args, { stdio: 'inherit' });
    // Rede de segurança: um envio que pendura não pode travar os próximos.
    const limite = setTimeout(() => {
      logger.error({ minutos: LIMITE_MIN }, 'envio passou do limite — encerrando');
      filho.kill('SIGKILL');
    }, LIMITE_MIN * 60_000);
    filho.on('exit', (code) => {
      clearTimeout(limite);
      res(code ?? 1);
    });
    filho.on('error', (err) => {
      logger.error(err.message);
      res(1);
    });
  });
}

async function rodada(horario: string): Promise<void> {
  let recentes = lerRecentes();
  const tentados: string[] = [];

  for (let i = 0; i < TENTATIVAS; i++) {
    const escolhido = sortearNicho(
      nichos.filter((n) => !tentados.includes(n.nome)),
      recentes,
    );
    if (!escolhido) break;

    tentados.push(escolhido.nome);
    recentes = [escolhido.nome, ...recentes];
    lembrar(recentes);

    logger.info({ horario, nicho: escolhido.nome }, 'envio automático começou');
    let code = await enviar(escolhido.niche.keywords);

    if (code && code !== NADA_ENVIADO) {
      // Falha de verdade (Shopee fora, WhatsApp caiu): outro nicho não ajuda,
      // mas a pane costuma passar em minutos. Uma segunda chance, mesmo nicho.
      logger.warn({ horario, code }, `envio falhou — nova tentativa em ${RETRY_MIN} min`);
      await new Promise((r) => setTimeout(r, RETRY_MIN * 60_000));
      code = await enviar(escolhido.niche.keywords);
    }

    if (code === 0) {
      logger.info({ horario, nicho: escolhido.nome }, 'envio automático terminou');
      return;
    }
    if (code !== NADA_ENVIADO) {
      logger.error({ horario, nicho: escolhido.nome, code }, 'envio automático falhou');
      await avisar(`o envio das ${horario.slice(-5)} FALHOU (${escolhido.nome}). Veja npm run agenda:logs.`);
      return;
    }
    logger.info({ nicho: escolhido.nome }, 'nada bom nesse nicho — tentando outro');
  }
  logger.warn({ horario, tentados }, 'nenhum nicho rendeu oferta — nada enviado');
  await avisar(`nada foi enviado às ${horario.slice(-5)}: nenhum nicho rendeu oferta boa (${tentados.join(', ')}).`);
}

let ultima: string | null = null;
let rodando = false;

/**
 * A pasta ./data do host precisa estar de pé dentro do container.
 *
 * No boot do Windows o Docker sobe a agenda ANTES do WSL ter o ./data pronto:
 * o container ganha uma pasta vazia, de root, no lugar. Aí a sessão do WhatsApp
 * "some" e todo envio morre com EACCES. Sair daqui faz o Docker recriar o
 * processo (`restart: unless-stopped`) até o mount aparecer.
 */
function exigirDados(): void {
  if (existsSync(config.WA_AUTH_DIR)) return;
  logger.error(`${config.WA_AUTH_DIR} não existe — o ./data do host não montou. Reiniciando.`);
  process.exit(1);
}

async function tick(): Promise<void> {
  const vez = horarioDaVez(new Date(), horarios);
  if (!vez || vez === ultima || rodando) return;
  exigirDados();

  ultima = vez;
  rodando = true;
  try {
    await rodada(vez);
  } finally {
    rodando = false;
  }
}

if (!nichos.length) {
  logger.error('AGENDA_NICHOS_FORA tirou todos os nichos — nada pra sortear');
  process.exit(1);
}

exigirDados();
logger.info(
  {
    horarios: config.AGENDA_HORARIOS,
    top: config.AGENDA_TOP,
    nichos: nichos.map((n) => n.nome),
    tz: process.env.TZ,
  },
  'agenda no ar',
);
setInterval(() => void tick(), TICK_MS);
void tick();
