/**
 * Espaço real de cada texto dentro do card 1080x1080.
 *
 * Manchete da capa e do CTA quebram em linhas; o resto é uma linha só e o
 * `fitSize` encolhe a fonte até caber. Os mesmos números vão no prompt e são
 * conferidos na saída: texto que passa volta pra IA reescrever (ver
 * `ai/plano.ts`), porque cortar deixa frase pela metade ("Qual código vai te").
 */
export const LIMITS = {
  titulo: 48,
  subtitulo: 32,
  etiqueta: 38,
  // Era 22: a pergunta do slide final quase nunca cabe nisso e saía cortada.
  ctaHeadline: 40,
  ctaLinha: 34,
  // Daqui pra baixo nada é desenhado na imagem — vai pro 00-LEGENDA.txt. Os
  // limites existem só pra caber onde serão colados: a bio do TikTok tem 80
  // caracteres e comentário curto é o que a pessoa lê antes de deslizar.
  gancho: 140,
  comentario: 150,
  resposta: 220,
  bio: 80,
} as const;
