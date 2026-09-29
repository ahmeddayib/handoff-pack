import { sleep, createHook } from 'workflow';

async function chargeCard() {
  'use step';
  return 'charged';
}

const sendReceipt = async () => {
  'use step';
  return 'sent';
};

export async function orderWorkflow() {
  'use workflow';
  await chargeCard();
  await sleep('3d');
  const approval = createHook();
  await approval;
  await sendReceipt();
}
