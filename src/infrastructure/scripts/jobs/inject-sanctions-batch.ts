#!/usr/bin/env node
/**
 * Script de batch quotidien — injection des listes de sanctions OFAC/UE/ONU.
 *
 * Usage : npx tsx scripts/inject-sanctions-batch.ts
 * Cron  : 0 6 * * * npx tsx scripts/inject-sanctions-batch.ts
 *
 * Format d'entrée attendu : fichiers JSON dans /data/sanctions/
 *   ├── ofac-YYYY-MM-DD.json
 *   ├── eu-YYYY-MM-DD.json
 *   └── un-YYYY-MM-DD.json
 *
 * Chaque fichier JSON contient un tableau d'entrées :
 *   [{ "entryRef": "OFAC-12345", "fullName": "John DOE", "matchType": "sanction",
 *      "listName": "SDN", "identityHint": "email@example.com" }]
 *
 * Si identityHint est fourni, le système tente un matching automatique
 * avec les utilisateurs existants et crée un ComplianceCase pour chaque match.
 * Sans identityHint, l'entrée est importée sans matching automatique.
 */

import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { screeningBatchService } from '../../../application/services/screening-batch-service.ts';
import { PROCESS_IDS, runCronWithEvidence } from '../../../application/services/process-evidence-service.ts';

const DATA_DIR = process.env.SANCTIONS_DATA_DIR || join(process.cwd(), 'data', 'sanctions');
const PROCESSED_DIR = join(DATA_DIR, 'processed');
const LOG_FILE = join(DATA_DIR, 'sanctions-batch.log');

function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  const dir = join(DATA_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(LOG_FILE, line + '\n', { flag: 'a' });
}

interface SanctionEntry {
  entryRef: string;
  fullName: string;
  matchType: 'sanction' | 'pep' | 'ubo' | 'country_risk' | 'adverse_media';
  listName?: string;
  identityHint?: string;
  rawData?: Record<string, unknown>;
}

interface SanctionFile {
  source: string;
  sourceDate: string;
  entries: SanctionEntry[];
}

function loadSanctionFile(filepath: string): SanctionFile | null {
  try {
    const content = readFileSync(filepath, 'utf8');
    const entries = JSON.parse(content) as SanctionEntry[];
    if (!Array.isArray(entries) || entries.length === 0) return null;

    const filename = filepath.split('/').pop() || 'unknown.json';
    const match = filename.match(/^([a-z]+)-(\d{4}-\d{2}-\d{2})\.json$/i);

    return {
      source: match ? match[1].toUpperCase() + ' Sanctions List' : filename.replace('.json', ''),
      sourceDate: match ? match[2] : new Date().toISOString().slice(0, 10),
      entries,
    };
  } catch (err: any) {
    log(`ERREUR chargement ${filepath}: ${err.message}`);
    return null;
  }
}

async function runScheduledControl() {
  log('=== Début batch sanctions quotidien ===');

  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
    log(`Dossier créé: ${DATA_DIR}`);
    log('Placer les fichiers JSON de sanctions dans ce dossier.');
    log('Format: [{ "entryRef": "...", "fullName": "...", "matchType": "sanction|pep|ubo|country_risk|adverse_media", "listName": "...", "identityHint": "..." }]');
    return;
  }

  if (!existsSync(PROCESSED_DIR)) {
    mkdirSync(PROCESSED_DIR, { recursive: true });
  }

  const adminUserId = process.env.ADMIN_USER_ID || '00000000-0000-0000-0000-000000000000';
  const today = new Date().toISOString().slice(0, 10);

  const files = readdirSync(DATA_DIR)
    .filter(f => f.endsWith('.json') && !f.startsWith('.'))
    .sort();

  let totalProcessed = 0;
  let totalMatches = 0;

  for (const filename of files) {
    const filepath = join(DATA_DIR, filename);
    const data = loadSanctionFile(filepath);

    if (!data) {
      log(`Fichier ignoré (vide ou invalide): ${filename}`);
      continue;
    }

    const batchRef = `${data.source.replace(/\s+/g, '-')}-${today}`;

    try {
      const result = await screeningBatchService.importBatch({
        batchRef,
        source: data.source,
        sourceDate: data.sourceDate,
        entries: data.entries,
      }, adminUserId);

      log(`${filename}: ${result.totalEntries} entrées, ${result.casesCreated} ComplianceCases créés, ${result.noMatch} sans correspondance`);

      totalProcessed += result.totalEntries;
      totalMatches += result.casesCreated;

      // Déplacer vers processed
      const destPath = join(PROCESSED_DIR, filename);
      writeFileSync(destPath, readFileSync(filepath));
      unlinkSync(filepath);
    } catch (err: any) {
      log(`ERREUR batch ${batchRef}: ${err.message}`);
    }
  }

  log(`=== Fin batch — ${totalProcessed} entrées, ${totalMatches} utilisateurs bloqués ===`);
}

// GAP-024: durable start and terminal evidence for the mandatory P01/P17
// scheduled control (sanctions-cron).
async function main() {
  await runCronWithEvidence(PROCESS_IDS.sanctionsCron, runScheduledControl);
}

main().catch(err => {
  log(`ERREUR FATALE: ${err.message}`);
  process.exit(1);
});
