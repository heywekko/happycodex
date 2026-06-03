#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const ref = process.env.HAPPYCLAW_REF;

if (!ref) {
  console.error('HAPPYCLAW_REF is required.');
  process.exit(1);
}

if (!fs.existsSync(path.join(ref, '.git'))) {
  console.error(`HAPPYCLAW_REF must point to a HappyClaw Git checkout: ${ref}`);
  process.exit(1);
}

const allowlistPath = path.join(root, 'config/happyclaw-route-allowlist.txt');

function readAllowlist(filePath) {
  const allowed = {
    'happycodex-only': new Set(),
    'happyclaw-only': new Set(),
  };
  let section = null;

  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^\[([^\]]+)\]$/);
    if (match) {
      section = match[1];
      if (!allowed[section]) allowed[section] = new Set();
      continue;
    }
    if (!section) {
      throw new Error(`Allowlist entry without section: ${line}`);
    }
    allowed[section].add(line);
  }

  return allowed;
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      walk(full, out);
    } else if (stat.isFile() && full.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

function routeFiles(baseDir) {
  const files = walk(path.join(baseDir, 'src/routes'));
  const web = path.join(baseDir, 'src/web.ts');
  if (fs.existsSync(web)) files.push(web);
  return files;
}

function rel(baseDir, filePath) {
  return path.relative(baseDir, filePath).split(path.sep).join('/');
}

function collectRoutes(baseDir) {
  const routes = new Set();
  const httpRoute =
    /\b[A-Za-z_$][\w$]*\.(get|post|put|patch|delete)\(\s*(['"`])([^'"`]+)\2/g;
  const routeMount =
    /\b[A-Za-z_$][\w$]*\.route\(\s*(['"`])([^'"`]+)\1\s*,\s*([A-Za-z_$][\w$]*)/g;

  for (const filePath of routeFiles(baseDir)) {
    const relativePath = rel(baseDir, filePath);
    const source = fs.readFileSync(filePath, 'utf8');

    for (const match of source.matchAll(httpRoute)) {
      routes.add(`${relativePath} ${match[1].toUpperCase()} ${match[3]}`);
    }

    for (const match of source.matchAll(routeMount)) {
      routes.add(`${relativePath} ROUTE ${match[2]} ${match[3]}`);
    }
  }

  return routes;
}

function sortedDifference(left, right) {
  return [...left].filter((item) => !right.has(item)).sort();
}

const allowed = readAllowlist(allowlistPath);
const currentRoutes = collectRoutes(root);
const happyclawRoutes = collectRoutes(ref);

const currentOnly = sortedDifference(currentRoutes, happyclawRoutes);
const happyclawOnly = sortedDifference(happyclawRoutes, currentRoutes);

const unexpectedCurrentOnly = currentOnly.filter(
  (entry) => !allowed['happycodex-only'].has(entry),
);
const unexpectedHappyclawOnly = happyclawOnly.filter(
  (entry) => !allowed['happyclaw-only'].has(entry),
);
const staleCurrentOnlyAllowlist = [...allowed['happycodex-only']]
  .filter((entry) => !currentOnly.includes(entry))
  .sort();
const staleHappyclawOnlyAllowlist = [...allowed['happyclaw-only']]
  .filter((entry) => !happyclawOnly.includes(entry))
  .sort();

if (
  unexpectedCurrentOnly.length ||
  unexpectedHappyclawOnly.length ||
  staleCurrentOnlyAllowlist.length ||
  staleHappyclawOnlyAllowlist.length
) {
  if (unexpectedCurrentOnly.length) {
    console.error('Unexpected HappyCodex-only routes:');
    for (const entry of unexpectedCurrentOnly) console.error(entry);
  }
  if (unexpectedHappyclawOnly.length) {
    console.error('Unexpected HappyClaw-only routes:');
    for (const entry of unexpectedHappyclawOnly) console.error(entry);
  }
  if (staleCurrentOnlyAllowlist.length) {
    console.error('Stale HappyCodex-only route allowlist entries:');
    for (const entry of staleCurrentOnlyAllowlist) console.error(entry);
  }
  if (staleHappyclawOnlyAllowlist.length) {
    console.error('Stale HappyClaw-only route allowlist entries:');
    for (const entry of staleHappyclawOnlyAllowlist) console.error(entry);
  }
  process.exit(1);
}

console.log('HappyClaw baseline route-surface check passed.');
