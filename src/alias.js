// Saved model aliases live in cfg.models ({ alias: model-id }). Tools and
// routing accept both the alias and the raw id.
export function resolveAlias(cfg, name) {
  if (!name) return name;
  return cfg?.models?.[name] || name;
}
