// The user-editable price table (pricing.json in the app's data folder). Both
// the main process (chat turn costs) and the telemetry worker load it.
import fs from 'node:fs';
import path from 'node:path';
import type { PricingStatus } from '../../shared/types';
import { BUILTIN_PRICING_JSON, currentPricing, parsePricingTable, setPricingOverride, type PricingTable } from './pricing';

/** Loads `filePath` over the shipped table; a missing or broken file leaves the shipped table in force. */
export function loadPricingFile(filePath: string): PricingStatus {
  let override: PricingTable | null = null;
  let exists = false;
  let error: string | null = null;
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    exists = true;
    override = parsePricingTable(JSON.parse(text.replace(/^﻿/, '')));
  } catch (caught: any) {
    if (caught?.code !== 'ENOENT') error = `pricing.json was not used: ${caught instanceof Error ? caught.message : String(caught)}`;
  }
  setPricingOverride(override);
  const table = currentPricing();
  return { path: filePath, exists, pricingDate: table.pricingDate, models: table.rates.length, error, problems: override?.problems ?? [] };
}

/** Creates the editable copy from the shipped table, unless one exists. */
export function seedPricingFile(filePath: string) {
  if (fs.existsSync(filePath)) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(BUILTIN_PRICING_JSON, null, 2)}\n`, 'utf8');
}
