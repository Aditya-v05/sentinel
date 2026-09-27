// Fixed label sets keep LLM output aggregatable (free text would fragment every chart).

export const SENTIMENTS = ["positive", "neutral", "negative"] as const;
export const EMOTIONS = ["excitement", "joy", "hope", "neutral", "surprise", "anxiety", "anger", "sadness"] as const;
export const STANCES = ["supportive", "neutral", "against"] as const;

export const AGE_BRACKETS = ["13-17", "18-24", "25-34", "35-44", "45-54", "55+", "unknown"] as const;
export const INTERESTS = [
  "technology", "politics", "finance & crypto", "sports", "entertainment", "education",
  "health", "business", "religion", "news & current affairs", "gaming", "travel", "other",
] as const;
export const PROFESSIONS = [
  "student", "tech professional", "business owner", "finance professional", "educator",
  "healthcare", "media / journalist", "public sector", "creative", "homemaker", "retired", "unknown",
] as const;

/** Snap an LLM value onto the allowed list (case-insensitive), else fallback. */
export function pick<T extends readonly string[]>(list: T, value: unknown, fallback: T[number]): T[number] {
  const v = String(value ?? "").trim().toLowerCase();
  return list.find((x) => x === v) ?? fallback;
}
