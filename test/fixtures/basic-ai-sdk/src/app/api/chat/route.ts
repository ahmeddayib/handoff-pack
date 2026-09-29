import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';

const MODEL = 'claude-sonnet-4-5';
const key = process.env.OPENAI_API_KEY;
const { ANTHROPIC_API_KEY: anthropicKey } = process.env;
const aiGateway = import.meta.env.AI_GATEWAY_API_KEY;
const fallback = process.env.MODEL ?? 'gpt-4o';

export async function GET() {
  await generateText({ model: openai('gpt-4o'), prompt: 'hello', maxOutputTokens: 200 });
  await generateText({ model: anthropic(MODEL), prompt: 'hello' });
  await generateText({ model: 'openai/gpt-4o', prompt: 'hello' });
  await generateText({ model: openai(process.env.MODEL ?? 'gpt-4o'), prompt: 'hello' });
  return Response.json({ key, anthropicKey, aiGateway, fallback });
}
