import { config } from '../infra/config.js';
import { apagarOfertas, candidatosLimpeza, compactar, type CandidatoLimpeza } from '../infra/db.js';
import { generoDoPublico } from '../domain/genero.js';
import { motivoLimpeza, type MotivoLimpeza } from '../domain/limpeza.js';

/**
 * Leitura única e velha: a Shopee devolveu o produto uma vez e nunca mais. Sem
 * segunda leitura não há baseline, e o `--db` já não usa leitura com mais de
 * `DB_MAX_AGE_DAYS` — é linha que só ocupa espaço.
 */
const DIAS_LEITURA_UNICA = 30;

export type Motivo = MotivoLimpeza | 'leitura_unica_velha';

export interface PlanoLimpeza {
  apagar: { c: CandidatoLimpeza; motivo: Motivo }[];
  total: number;
}

/** O que sairia, sem apagar nada. Produto que foi pro grupo/post nunca entra. */
export async function planejar(): Promise<PlanoLimpeza> {
  const genero = generoDoPublico(config.AI_PUBLICO);
  const corte = Date.now() - DIAS_LEITURA_UNICA * 86_400_000;
  const candidatos = await candidatosLimpeza();

  const apagar: PlanoLimpeza['apagar'] = [];
  for (const c of candidatos) {
    const motivo: Motivo | null =
      motivoLimpeza(c.title, genero) ??
      (c.leituras <= 1 && c.lastSeenAt.getTime() < corte ? 'leitura_unica_velha' : null);
    if (motivo) apagar.push({ c, motivo });
  }
  return { apagar, total: candidatos.length };
}

export async function aplicar(plano: PlanoLimpeza): Promise<{ ofertas: number; leituras: number }> {
  const r = await apagarOfertas(plano.apagar.map((a) => a.c.id));
  await compactar();
  return r;
}
