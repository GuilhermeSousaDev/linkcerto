/**
 * Espaço real de cada texto dentro do card 1080x1080.
 *
 * Estourar não quebra linha: o `fitSize` encolhe a fonte até o texto sumir. Os
 * mesmos números vão no prompt e são reaplicados na saída, porque modelo nenhum
 * respeita limite de caractere de forma confiável.
 */
export const LIMITS = {
  titulo: 42,
  subtitulo: 32,
  etiqueta: 38,
  ctaHeadline: 22,
  ctaLinha: 34,
  // Daqui pra baixo nada é desenhado na imagem — vai pro 00-LEGENDA.txt. Os
  // limites existem só pra caber onde serão colados: a bio do TikTok tem 80
  // caracteres e comentário curto é o que a pessoa lê antes de deslizar.
  gancho: 140,
  comentario: 150,
  resposta: 220,
  bio: 80,
} as const;
