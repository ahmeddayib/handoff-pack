import { createWebhook } from 'workflow';

async function writeProgressEvent() {
  'use step';
}

export async function generateBirthdayCard() {
  'use workflow';
  await writeProgressEvent();
  await writeProgressEvent();
  const webhook = createWebhook();
  await webhook;
}
