/** Valor digitado em reais, aceitando vírgula. null quando fora da faixa ou mal formado. */
export function parseAmount(text: string, min: number, max = Number.POSITIVE_INFINITY) {
  const normalized = text.trim().replace(',', '.')
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null
  const value = Number(normalized)
  return value >= min && value <= max ? normalized : null
}
