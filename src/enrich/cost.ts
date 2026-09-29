import { findModel, type ModelRegistry } from "./modelRegistry.js";
import type { ModelRecord } from "../types.js";

export interface CostAssumptions {
  avgInputTokens: number;
  avgOutputTokens: number;
}

function estimate(
  inputPrice: number | null,
  outputPrice: number | null,
  inputTokens: number,
  outputTokens: number,
): number | null {
  if (inputPrice === null || outputPrice === null) return null;
  return (inputTokens * inputPrice + outputTokens * outputPrice) / 1000;
}

export function modelCost(
  model: ModelRecord,
  registry: ModelRegistry,
  assumptions: CostAssumptions,
): { label: string; replacement?: string } {
  if (model.configuredViaEnv)
    return {
      label: `price unknown (production model set by ${model.configuredViaEnv})`,
    };
  const entry = model.modelId
    ? findModel(registry, model.provider, model.modelId)
    : null;
  if (!entry) return { label: "price unknown" };
  const embedding =
    model.callKind === "embed" || model.callKind === "embedMany";
  const outputTokens = embedding
    ? 0
    : (model.maxOutputTokens ?? assumptions.avgOutputTokens);
  const cost = estimate(
    entry.inputUsdPerMTok,
    embedding ? 0 : entry.outputUsdPerMTok,
    assumptions.avgInputTokens,
    outputTokens,
  );
  if (cost === null) return { label: "price unknown" };
  const label = `$${cost.toFixed(2)}${model.maxOutputTokens !== undefined && !embedding ? " upper bound (uses maxOutputTokens)" : ""}`;
  const replacement = entry.replacement
    ? findModel(registry, model.provider, entry.replacement)
    : null;
  const replacementCost = replacement
    ? estimate(
        replacement.inputUsdPerMTok,
        embedding ? 0 : replacement.outputUsdPerMTok,
        assumptions.avgInputTokens,
        outputTokens,
      )
    : null;
  return {
    label,
    ...(replacementCost !== null
      ? {
          replacement: `switching changes estimated cost from $${cost.toFixed(2)} to $${replacementCost.toFixed(2)} per 1,000 requests`,
        }
      : {}),
  };
}
