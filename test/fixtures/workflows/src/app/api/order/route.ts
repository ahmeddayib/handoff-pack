import { start as begin } from 'workflow/api';
import { orderWorkflow as order } from '../../../workflows/order';

export async function POST() {
  const run = await begin(order);
  return Response.json({ id: run.runId });
}
