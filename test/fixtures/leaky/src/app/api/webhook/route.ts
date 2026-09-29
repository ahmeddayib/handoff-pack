const publishable = process.env.NEXT_PUBLIC_STRIPE_SECRET;
const secret = process.env['STRIPE_SECRET_KEY'];
const { STRIPE_WEBHOOK_SECRET } = process.env;

export async function POST() {
  return Response.json({ publishable, secret, hasWebhookSecret: !!STRIPE_WEBHOOK_SECRET });
}
