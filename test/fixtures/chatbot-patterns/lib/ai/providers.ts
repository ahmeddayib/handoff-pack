import { gateway } from "ai";
import { titleModel } from "./models";
export const chosen = (modelId: string) => gateway.languageModel(modelId);
export const title = () => gateway.languageModel(titleModel.id);
