import { mkdirSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import { config } from './config.js';
import { logger } from './logger.js';

// Baileys moved between default and named exports across versions; resolve both.
import baileysDefault, * as baileysNamespace from 'baileys';
/* eslint-disable @typescript-eslint/no-explicit-any */
const ns = baileysNamespace as any;
const def = (baileysDefault as any) ?? {};
const makeWASocket: any = ns.makeWASocket ?? def.makeWASocket ?? def;
const useMultiFileAuthState: any = ns.useMultiFileAuthState ?? def.useMultiFileAuthState;
const fetchLatestBaileysVersion: any = ns.fetchLatestBaileysVersion ?? def.fetchLatestBaileysVersion;
const DisconnectReason: any = ns.DisconnectReason ?? def.DisconnectReason ?? {};
const Browsers: any = ns.Browsers ?? def.Browsers;
const isJidBroadcast: any = ns.isJidBroadcast ?? def.isJidBroadcast;
/* eslint-enable @typescript-eslint/no-explicit-any */

const log = logger.child({ mod: 'whatsapp' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Silencia dois erros conhecidos e inofensivos do libsignal.
 *
 * Ao vincular um aparelho novo, o WhatsApp entrega mensagens antigas cifradas
 * com chaves que este aparelho nunca teve — no Signal cada chave de mensagem é
 * de uso único, então elas são indecifráveis por definição. Isso afeta só o
 * RECEBIMENTO, e este programa apenas envia.
 *
 * O libsignal escreve direto no console, driblando o logger do Baileys, então
 * a única forma de filtrar é interceptar aqui. Rode com LOG_LEVEL=debug pra ver
 * tudo de novo.
 */
const BENIGN = [
  'Failed to decrypt message with any known session',
  'MessageCounterError',
  'Session error',
  // Renegociação normal do Signal — o libsketch despeja o SessionEntry inteiro.
  'Closing open session',
  'Closing session',
];

function muteBenignNoise(): void {
  if (config.LOG_LEVEL === 'debug' || config.LOG_LEVEL === 'trace') return;
  for (const method of ['log', 'error', 'warn'] as const) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      const text = args.map((a) => (typeof a === 'string' ? a : '')).join(' ');
      if (BENIGN.some((p) => text.includes(p))) return;
      original(...args);
    };
  }
}

export interface Outbound {
  text: string;
  imageUrl?: string | null;
}

export class WhatsApp {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sock: any = null;
  private connected = false;

  async connect(timeoutMs = 120_000): Promise<void> {
    if (this.connected) return;

    muteBenignNoise();

    const authDir = resolve(process.cwd(), config.WA_AUTH_DIR);
    mkdirSync(authDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    let version: number[] | undefined;
    try {
      ({ version } = await fetchLatestBaileysVersion());
    } catch {
      log.warn('using bundled WhatsApp Web version');
    }

    this.sock = makeWASocket({
      auth: state,
      version,
      logger: pino({ level: 'silent' }), // Baileys is very chatty
      browser: Browsers ? Browsers.ubuntu('Chrome') : undefined,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      // Só enviamos. Ignorar status/broadcast corta a maior parte das mensagens
      // que o aparelho novo não consegue decifrar, na origem.
      shouldIgnoreJid: (jid: string) =>
        jid === 'status@broadcast' || Boolean(isJidBroadcast?.(jid)),
      // Sem store de mensagens: não tenta reenviar nada que falhou ao decifrar.
      getMessage: async () => undefined,
    });
    this.sock.ev.on('creds.update', saveCreds);

    await new Promise<void>((res, rej) => {
      const timer = setTimeout(() => rej(new Error('WhatsApp connection timed out')), timeoutMs);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.sock.ev.on('connection.update', (u: any) => {
        if (u.qr) {
          console.log('\nEscaneie no WhatsApp → Aparelhos conectados → Conectar aparelho\n');
          qrcode.generate(u.qr, { small: true });
        }
        if (u.connection === 'open') {
          clearTimeout(timer);
          this.connected = true;
          res();
        }
        if (u.connection === 'close') {
          this.connected = false;
          clearTimeout(timer);
          if (u.lastDisconnect?.error?.output?.statusCode === DisconnectReason?.loggedOut) {
            rej(new Error(`Sessão encerrada. Apague ${config.WA_AUTH_DIR} e rode "npm run wa:login".`));
          } else {
            this.connect(timeoutMs).then(res).catch(rej);
          }
        }
      });
    });
  }

  async groups(): Promise<{ jid: string; subject: string }[]> {
    const all = await this.sock.groupFetchAllParticipating();
    return Object.values(all as Record<string, { id: string; subject: string }>)
      .map((g) => ({ jid: g.id, subject: g.subject }))
      .sort((a, b) => a.subject.localeCompare(b.subject));
  }

  /**
   * Envia um arquivo local.
   *
   * `asImage: false` (padrão) manda como documento, que é o único jeito de o
   * WhatsApp NÃO recomprimir. A foto da Shopee já é 800x800 ampliada pra 1080 —
   * uma segunda compressão estraga o que sobrou. O custo é que documento cai em
   * "Documentos" no celular, não na galeria.
   */
  async sendFile(
    jid: string,
    filePath: string,
    opts: { asImage?: boolean; caption?: string } = {},
  ): Promise<void> {
    if (!this.connected || !this.sock) throw new Error('WhatsApp não conectado');
    const data = readFileSync(filePath);
    const fileName = basename(filePath);

    if (opts.asImage) {
      await this.sock.sendMessage(jid, {
        image: data,
        ...(opts.caption ? { caption: opts.caption } : {}),
      });
      return;
    }

    await this.sock.sendMessage(jid, {
      document: data,
      mimetype: 'image/jpeg',
      fileName,
      ...(opts.caption ? { caption: opts.caption } : {}),
    });
  }

  async send(jid: string, msg: Outbound): Promise<void> {
    if (msg.imageUrl) {
      try {
        await this.sock.sendMessage(jid, { image: { url: msg.imageUrl }, caption: msg.text });
        return;
      } catch (err) {
        // A dead image URL must never cost us the deal.
        log.warn({ err: (err as Error).message }, 'image failed, sending as text');
      }
    }
    await this.sock.sendMessage(jid, { text: msg.text });
  }

  /**
   * Randomised gaps between messages. Bursty sending is the fastest way to get
   * an unofficial client banned.
   */
  async sendMany(
    jid: string,
    msgs: Outbound[],
    onSent: (i: number) => Promise<void> | void,
  ): Promise<number> {
    let n = 0;
    for (const [i, m] of msgs.entries()) {
      await this.send(jid, m);
      await onSent(i); // grava na hora: falha no meio do lote não pode causar reenvio
      n++;
      if (i < msgs.length - 1) {
        await sleep(
          config.WA_MIN_DELAY_MS +
            Math.random() * (config.WA_MAX_DELAY_MS - config.WA_MIN_DELAY_MS),
        );
      }
    }
    return n;
  }

  async close(): Promise<void> {
    if (!this.sock) return;
    await sleep(1500); // let outbound frames flush
    try {
      this.sock.end(undefined);
    } catch {
      /* already closed */
    }
    this.sock = null;
    this.connected = false;
  }
}
