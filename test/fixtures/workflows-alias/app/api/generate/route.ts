import { start } from 'workflow/api';
import { generateBirthdayCard } from '@/app/api/generate/generate-birthday-card';

export async function POST() {
  return start(generateBirthdayCard, []);
}
