#!/usr/bin/env bun

import { handleValidateCommand } from './src/rmplan/commands/validate.js';

async function debugOptions() {
  console.log('Testing with noFix: true');
  
  try {
    await handleValidateCommand(
      { dir: 'test_plans', noFix: true }, 
      { parent: { opts: () => ({}) } }
    );
  } catch (err) {
    console.log(`Caught error: ${err.message}`);
  }
}

debugOptions().catch(console.error);