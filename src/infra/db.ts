import pg from 'pg';
import { config } from './config.js';
import type { Offer } from './shopee.js';

/**
 * Postgres, quatro tabelas:
 *   offer          — o que já vimos
 *   price_snapshot — cada leitura de preço, só insere (é o baseline)
 *   sent           — o que já foi pro WhatsApp, pra nada repetir
 *   posted         — o que já virou card de TikTok, pelo mesmo motivo
 *
 * `sent` e `posted` são separados de propósito: são públicos diferentes. O
 * grupo pode receber hoje o produto que o TikTok mostrou semana passada — quem
 * está no grupo já converteu, e é lá que o link é entregue.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS offer (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  url             TEXT NOT NULL,
  image_url       TEXT,
  shop_name       TEXT,
  commission_rate DOUBLE PRECISION,
  first_seen_at   TIMESTAMPTZ NOT NULL,
  last_seen_at    TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS price_snapshot (
  id              BIGSERIAL PRIMARY KEY,
  offer_id        TEXT NOT NULL,
  price           DOUBLE PRECISION NOT NULL,
  rating          DOUBLE PRECISION,
  sold            BIGINT,
  -- Guardado pra que o "--db" consiga pontuar produto sem baseline medido: sem
  -- isso, ofertas vindas do banco caem todas em "sem_desconto".
  vendor_discount DOUBLE PRECISION,
  captured_at     TIMESTAMPTZ NOT NULL
);
-- O link de afiliado, que é o que faz o post render dinheiro. Fica em offer e
-- não em price_snapshot porque é estável: muda de produto pra produto, não de
-- leitura pra leitura.
ALTER TABLE offer ADD COLUMN IF NOT EXISTS offer_link TEXT;

ALTER TABLE price_snapshot ADD COLUMN IF NOT EXISTS vendor_discount DOUBLE PRECISION;
-- Teto das variações. Mora no snapshot e não em offer porque muda junto do
-- preço: variação que esgota muda a faixa sem mudar o produto.
ALTER TABLE price_snapshot ADD COLUMN IF NOT EXISTS price_max DOUBLE PRECISION;
CREATE INDEX IF NOT EXISTS idx_snap ON price_snapshot (offer_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS sent (
  id       BIGSERIAL PRIMARY KEY,
  offer_id TEXT NOT NULL,
  price    DOUBLE PRECISION NOT NULL,
  sent_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sent ON sent (offer_id, sent_at DESC);

CREATE TABLE IF NOT EXISTS posted (
  id        BIGSERIAL PRIMARY KEY,
  offer_id  TEXT NOT NULL,
  posted_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_posted ON posted (posted_at DESC);
`;

let pool: pg.Pool | null = null;
let pronto: Promise<void> | null = null;

/**
 * O schema é aplicado uma vez por processo, na primeira query.
 *
 * O container pode estar de pé mas ainda aceitando conexões, ou parado — a
 * mensagem diz o que fazer em vez de vazar um ECONNREFUSED cru.
 */
function db(): pg.Pool {
  if (pool) return pool;

  pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 4 });
  pronto = pool
    .query(SCHEMA)
    .then(() => undefined)
    .catch((err: Error) => {
      const dica =
        /ECONNREFUSED|ENOTFOUND|timeout/i.test(err.message)
          ? '\nO banco não respondeu. Suba com: npm run db:up'
          : '';
      throw new Error(`Postgres: ${err.message}${dica}`);
    });

  return pool;
}

async function query<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) {
  const p = db();
  await pronto;
  return p.query<T>(sql, params);
}

export async function close(): Promise<void> {
  await pool?.end();
  pool = null;
  pronto = null;
}

/** Atualiza a oferta e acrescenta uma leitura de preço. */
export async function record(offers: Offer[]): Promise<void> {
  if (!offers.length) return;
  const agora = new Date();

  const p = db();
  await pronto;
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    for (const o of offers) {
      await client.query(
        `INSERT INTO offer (id, title, url, offer_link, image_url, shop_name, commission_rate, first_seen_at, last_seen_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
         ON CONFLICT (id) DO UPDATE SET
           title = EXCLUDED.title, url = EXCLUDED.url, image_url = EXCLUDED.image_url,
           -- COALESCE e não EXCLUDED direto: uma releitura que venha sem o
           -- link (a busca por id nem sempre traz) apagaria o que já temos, e
           -- o post seguinte sairia com link sem rastreio de novo.
           offer_link = COALESCE(EXCLUDED.offer_link, offer.offer_link),
           shop_name = EXCLUDED.shop_name, commission_rate = EXCLUDED.commission_rate,
           last_seen_at = EXCLUDED.last_seen_at`,
        [o.id, o.title, o.url, o.offerLink, o.imageUrl, o.shopName, o.commissionRate, agora],
      );
      await client.query(
        `INSERT INTO price_snapshot (offer_id, price, price_max, rating, sold, vendor_discount, captured_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [o.id, o.price, o.priceMax, o.rating, o.sold, o.vendorDiscount, agora],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export interface Snapshot {
  price: number;
  capturedAt: string;
}

/**
 * Histórico de vários produtos de uma vez.
 *
 * Uma query pro lote inteiro, não uma por produto: o scoring roda em cima de
 * centenas de ofertas por execução, e com driver assíncrono isso seriam
 * centenas de idas ao banco em série.
 */
export async function historyFor(
  offerIds: string[],
  windowDays = 90,
): Promise<Map<string, Snapshot[]>> {
  const porId = new Map<string, Snapshot[]>();
  if (!offerIds.length) return porId;

  const desde = new Date(Date.now() - windowDays * 86_400_000);
  const { rows } = await query<{ offer_id: string; price: number; captured_at: Date }>(
    `SELECT offer_id, price, captured_at
       FROM price_snapshot
      WHERE offer_id = ANY($1) AND captured_at >= $2
      ORDER BY captured_at ASC`,
    [offerIds, desde],
  );

  for (const r of rows) {
    const lista = porId.get(r.offer_id) ?? [];
    lista.push({ price: Number(r.price), capturedAt: r.captured_at.toISOString() });
    porId.set(r.offer_id, lista);
  }
  return porId;
}

/**
 * Preços já enviados que ainda não caíram o suficiente pra valer repetir.
 * Impede o mesmo produto reaparecer no grupo por causa de alguns centavos.
 */
export async function ultimoEnvio(offerIds: string[]): Promise<Map<string, number>> {
  if (!offerIds.length) return new Map();

  const { rows } = await query<{ offer_id: string; price: number }>(
    `SELECT DISTINCT ON (offer_id) offer_id, price
       FROM sent
      WHERE offer_id = ANY($1)
      ORDER BY offer_id, sent_at DESC`,
    [offerIds],
  );
  return new Map(rows.map((r) => [r.offer_id, Number(r.price)]));
}

/**
 * Guarda um link de afiliado recém-emitido.
 *
 * `IS NULL` na condição: só preenche buraco, nunca troca um link que já existe.
 * O link carrega o sub_id de rastreio, e sobrescrever o de um produto que já
 * saiu num post quebraria a atribuição das vendas daquele post.
 */
export async function guardarOfferLink(offerId: string, link: string): Promise<void> {
  await query('UPDATE offer SET offer_link = $2 WHERE id = $1 AND offer_link IS NULL', [
    offerId,
    link,
  ]);
}

export async function markSent(offerId: string, price: number): Promise<void> {
  await query('INSERT INTO sent (offer_id, price, sent_at) VALUES ($1,$2,$3)', [
    offerId,
    price,
    new Date(),
  ]);
}

/**
 * IDs que já viraram card nos últimos N dias.
 *
 * Sem isso o post de hoje é o de ontem: o ranking é estável, então os mesmos
 * campeões ficam no topo por semanas.
 */
export async function postedSince(days: number): Promise<Set<string>> {
  const { rows } = await query<{ offer_id: string }>(
    'SELECT DISTINCT offer_id FROM posted WHERE posted_at >= $1',
    [new Date(Date.now() - days * 86_400_000)],
  );
  return new Set(rows.map((r) => r.offer_id));
}

export async function markPosted(offerIds: string[]): Promise<void> {
  if (!offerIds.length) return;
  await query(
    `INSERT INTO posted (offer_id, posted_at)
     SELECT unnest($1::text[]), $2`,
    [offerIds, new Date()],
  );
}

export async function stats(): Promise<Record<string, number>> {
  const { rows } = await query<Record<string, string>>(
    `SELECT
       (SELECT COUNT(*) FROM offer)                        AS offers,
       (SELECT COUNT(*) FROM price_snapshot)               AS snapshots,
       (SELECT COUNT(*) FROM sent)                         AS sent,
       (SELECT COUNT(DISTINCT offer_id) FROM posted)       AS posted,
       (SELECT COUNT(*) FROM (
          SELECT offer_id FROM price_snapshot
           GROUP BY offer_id
          HAVING COUNT(*) >= $1
             AND MAX(captured_at) - MIN(captured_at) >= ($2 || ' days')::interval
        ) t)                                               AS "withBaseline"`,
    [config.BASELINE_MIN_SNAPSHOTS, config.BASELINE_MIN_DAYS],
  );

  const r = rows[0] ?? {};
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v)]));
}

/** Dos ids passados, quais já existem no banco. */
export async function jaConhecidos(ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const { rows } = await query<{ id: string }>('SELECT id FROM offer WHERE id = ANY($1)', [ids]);
  return new Set(rows.map((r) => r.id));
}

/**
 * As ofertas que já estão no banco, com a última leitura de preço de cada uma.
 *
 * É a fonte do `--db`: em vez de buscar na Shopee, reaproveita o que já foi
 * coletado. `dias` corta o que está velho demais — anunciar no grupo um preço
 * de duas semanas atrás é pior que não anunciar.
 *
 * Ordenado pela leitura mais recente: entre dois produtos, o de preço mais
 * fresco é o menos arriscado de anunciar.
 */
export async function ofertasDoBanco(
  dias: number,
  limite = 2000,
  palavras: string[] = [],
): Promise<Offer[]> {
  const { rows } = await query<{
    id: string; title: string; url: string; image_url: string | null;
    offer_link: string | null;
    shop_name: string | null; commission_rate: number | null; price: number;
    price_max: number | null;
    rating: number | null; sold: string | null; vendor_discount: number | null;
  }>(
    `SELECT o.id, o.title, o.url, o.offer_link, o.image_url, o.shop_name, o.commission_rate,
            s.price, s.price_max, s.rating, s.sold, s.vendor_discount
       FROM offer o
       JOIN LATERAL (
         SELECT price, price_max, rating, sold, vendor_discount, captured_at
           FROM price_snapshot ps
          WHERE ps.offer_id = o.id
          ORDER BY captured_at DESC
          LIMIT 1
       ) s ON TRUE
      WHERE s.captured_at >= $1
        AND ($3::text[] IS NULL OR o.title ILIKE ANY($3))
      ORDER BY s.captured_at DESC
      LIMIT $2`,
    [
      new Date(Date.now() - dias * 86_400_000),
      limite,
      palavras.length ? palavras.map((p) => `%${p}%`) : null,
    ],
  );

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    url: r.url,
    offerLink: r.offer_link,
    imageUrl: r.image_url,
    price: Number(r.price),
    priceMax: r.price_max === null ? null : Number(r.price_max),
    vendorDiscount: r.vendor_discount === null ? null : Number(r.vendor_discount),
    rating: r.rating === null ? null : Number(r.rating),
    sold: r.sold === null ? null : Number(r.sold),
    commissionRate: r.commission_rate === null ? null : Number(r.commission_rate),
    shopName: r.shop_name,
  }));
}

/** Quantas ofertas o `--db` teria pra oferecer. */
export async function quantasNoBanco(dias: number, palavras: string[] = []): Promise<number> {
  const { rows } = await query<{ c: string }>(
    `SELECT COUNT(*) c FROM offer o
      WHERE EXISTS (SELECT 1 FROM price_snapshot ps
                     WHERE ps.offer_id = o.id AND ps.captured_at >= $1)
        AND ($2::text[] IS NULL OR o.title ILIKE ANY($2))`,
    [new Date(Date.now() - dias * 86_400_000), palavras.length ? palavras.map((p) => `%${p}%`) : null],
  );
  return Number(rows[0]?.c ?? 0);
}

/**
 * Ofertas específicas, pela última leitura de cada uma.
 *
 * É como o `send` reencontra o que o `deals` escolheu, e o `photos` o que o
 * `ideia` planejou: os dois produtores gravam a seleção, então o consumidor
 * lê por id em vez de varrer a Shopee de novo atrás dos mesmos produtos.
 */
export async function ofertasPorIds(ids: string[]): Promise<Offer[]> {
  if (!ids.length) return [];

  const { rows } = await query<{
    id: string; title: string; url: string; image_url: string | null;
    offer_link: string | null;
    shop_name: string | null; commission_rate: number | null; price: number;
    price_max: number | null;
    rating: number | null; sold: string | null; vendor_discount: number | null;
  }>(
    `SELECT o.id, o.title, o.url, o.offer_link, o.image_url, o.shop_name, o.commission_rate,
            s.price, s.price_max, s.rating, s.sold, s.vendor_discount
       FROM offer o
       JOIN LATERAL (
         SELECT price, price_max, rating, sold, vendor_discount
           FROM price_snapshot ps
          WHERE ps.offer_id = o.id
          ORDER BY captured_at DESC
          LIMIT 1
       ) s ON TRUE
      WHERE o.id = ANY($1)`,
    [ids],
  );

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    url: r.url,
    offerLink: r.offer_link,
    imageUrl: r.image_url,
    price: Number(r.price),
    priceMax: r.price_max === null ? null : Number(r.price_max),
    vendorDiscount: r.vendor_discount === null ? null : Number(r.vendor_discount),
    rating: r.rating === null ? null : Number(r.rating),
    sold: r.sold === null ? null : Number(r.sold),
    commissionRate: r.commission_rate === null ? null : Number(r.commission_rate),
    shopName: r.shop_name,
  }));
}
