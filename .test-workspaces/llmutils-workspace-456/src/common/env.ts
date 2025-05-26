import { findUp } from 'find-up';
import * as dotenv from 'dotenv';

export async function loadEnv() {
  const envPath = await findUp('.env');
  if (envPath) {
    dotenv.config({
      path: envPath,
    });
  }
}
