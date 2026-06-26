import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseBbox, scrapeWazePoliceCameraAlerts, type WazeTransportMode } from '../src/lib/traffic-alerts/index.ts';

type CliOptions = {
  bbox?: string;
  transport: WazeTransportMode;
  out?: string;
  fixture?: string;
  browserHeadless?: boolean;
  maxTileSpanDegrees?: number;
  concurrency?: number;
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.bbox) {
    throw new Error('Missing required --bbox=south,west,north,east');
  }

  const result = await scrapeWazePoliceCameraAlerts({
    bbox: parseBbox(options.bbox),
    transport: options.fixture ? createFixtureTransport(options.fixture) : options.transport,
    browserHeadless: options.browserHeadless,
    maxTileSpanDegrees: options.maxTileSpanDegrees,
    concurrency: options.concurrency,
  });
  const json = `${JSON.stringify(result, null, 2)}\n`;

  if (options.out) {
    const outPath = resolve(options.out);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, json, 'utf8');
    process.stderr.write(`Wrote ${result.alerts.length} Waze police/camera alerts to ${outPath}\n`);
  } else {
    process.stdout.write(json);
  }

  if (result.errors.length > 0 && result.alerts.length === 0) {
    process.exitCode = 2;
  }
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { transport: 'auto' };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const [key, inlineValue] = arg.startsWith('--') ? arg.slice(2).split(/=(.*)/s, 2) : ['', ''];
    if (!key) throw new Error(`Unexpected argument: ${arg}`);

    const value = inlineValue !== undefined && inlineValue !== '' ? inlineValue : args[++i];
    if (!value) throw new Error(`Missing value for --${key}`);

    switch (key) {
      case 'bbox':
        options.bbox = value;
        break;
      case 'transport':
        options.transport = parseTransport(value);
        break;
      case 'out':
        options.out = value;
        break;
      case 'fixture':
        options.fixture = value;
        break;
      case 'browser-headless':
      case 'headless':
        options.browserHeadless = parseBoolean(key, value);
        break;
      case 'max-tile-degrees':
        options.maxTileSpanDegrees = parsePositiveNumber(key, value);
        break;
      case 'concurrency':
        options.concurrency = parsePositiveInteger(key, value);
        break;
      default:
        throw new Error(`Unknown option: --${key}`);
    }
  }

  return options;
}

function createFixtureTransport(path: string) {
  const fixturePath = resolve(path);
  return {
    async fetchGeoRss() {
      return JSON.parse(await readFile(fixturePath, 'utf8'));
    },
  };
}

function parseTransport(value: string): WazeTransportMode {
  if (value === 'auto' || value === 'http' || value === 'browser') return value;
  throw new Error('--transport must be one of auto, http, browser');
}

function parsePositiveNumber(key: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`--${key} must be a positive number`);
  return parsed;
}

function parsePositiveInteger(key: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`--${key} must be a positive integer`);
  return parsed;
}

function parseBoolean(key: string, value: string): boolean {
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new Error(`--${key} must be true or false`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
