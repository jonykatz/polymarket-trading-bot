import fs from "node:fs";
import path from "node:path";
import type { LivePosition } from "../types/index.js";

const dataDir = path.join(process.cwd(), ".data");
const legacyPath = path.join(process.cwd(), "open-positions.json");
const defaultPath = path.join(dataDir, "open-positions.json");

function resolvePositionsPath(filePath?: string): string {
  if (filePath) return filePath;
  fs.mkdirSync(dataDir, { recursive: true });
  migrateLegacyPositionsFile();
  return defaultPath;
}

function migrateLegacyPositionsFile(): void {
  try {
    if (!fs.existsSync(legacyPath) || fs.existsSync(defaultPath)) return;
    fs.renameSync(legacyPath, defaultPath);
  } catch (error) {
    console.error("Failed to migrate open-positions.json to .data/:", error);
  }
}

function loadPositions(filePath = defaultPath): LivePosition[] {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function savePositions(positions: LivePosition[], filePath?: string): void {
  const target = resolvePositionsPath(filePath);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(positions, null, 2), "utf-8");
  } catch (error) {
    throw new Error(
      `Cannot save open positions to ${target}. Check folder permissions (do not run the bot with sudo).`,
      { cause: error }
    );
  }
}

export function getOpenPositions(filePath?: string): LivePosition[] {
  return loadPositions(resolvePositionsPath(filePath));
}

export function hasOpenPosition(marketId: string, filePath?: string): boolean {
  return getOpenPositions(filePath).some((p) => p.marketId === marketId);
}

export function addPosition(position: LivePosition, filePath?: string): void {
  const target = resolvePositionsPath(filePath);
  const positions = loadPositions(target);
  if (positions.some((p) => p.marketId === position.marketId)) return;
  positions.push(position);
  savePositions(positions, target);
}

export function removePosition(marketId: string, filePath?: string): void {
  const target = resolvePositionsPath(filePath);
  const positions = loadPositions(target).filter((p) => p.marketId !== marketId);
  savePositions(positions, target);
}

export function getPositionsDueToClose(
  closeAfterSeconds: number,
  filePath?: string
): LivePosition[] {
  if (closeAfterSeconds <= 0) return [];
  const now = Date.now();
  const threshold = closeAfterSeconds * 1000;
  return getOpenPositions(filePath).filter((p) => now - p.openedAt >= threshold);
}
