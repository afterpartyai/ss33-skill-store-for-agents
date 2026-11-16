/**
 * Runs the fake store until Ctrl-C:
 *
 *   npm run fake-store -- --skills test/fixtures/store/basic.json
 *   npm run fake-store -- --cassettes test/cassettes/live --record      (record misses from the real store)
 *
 * Point the CLI or plugin at it with SS33_ENDPOINT=<printed url>.
 */
import { loadConfig, DEFAULT_ENDPOINT } from "../core/config.js";
import { parseArgs } from "../cli/main.js";
import { loadSkillFixture } from "./fixtures.js";
import { startFakeStore } from "./server.js";

const HELP = `fake-store [--port N] [--skills fixture.json] [--cassettes DIR] [--record[=UPSTREAM]]
           [--on-miss error|empty] [--keys k1,k2] [--free-tier N]

  --skills     scripted skills (JSON fixture)
  --cassettes  replay recorded responses from DIR
  --record     forward misses to the real store (default ${DEFAULT_ENDPOINT}) and save them to --cassettes.
               Uses your configured API key (SS33_API_KEY or ss33 config); it is never written to cassettes.
  --keys       emulate auth: only these bearer keys are accepted; anonymous requests get the free tier
  --free-tier  anonymous searches per minute when --keys is set (default 5)`;

async function run(): Promise<void> {
  const { flags } = parseArgs(process.argv.slice(2), ["port", "skills", "cassettes", "on-miss", "keys", "free-tier"]);
  if (flags.help) return void console.log(HELP);
  const str = (k: string) => (typeof flags[k] === "string" ? (flags[k] as string) : undefined);
  const record = flags.record === undefined ? undefined : { upstream: str("record") ?? DEFAULT_ENDPOINT, ...(loadConfig().apiKey ? { apiKey: loadConfig().apiKey! } : {}) };
  const store = await startFakeStore({
    ...(str("port") ? { port: Number(str("port")) } : {}),
    ...(str("skills") ? { skills: loadSkillFixture(str("skills")!) } : {}),
    ...(str("cassettes") ? { cassetteDir: str("cassettes")! } : {}),
    ...(record ? { record } : {}),
    ...(str("on-miss") === "empty" ? { onMiss: "empty" as const } : {}),
    ...(str("keys") ? { auth: { keys: str("keys")!.split(","), ...(str("free-tier") ? { freeTierPerMinute: Number(str("free-tier")) } : {}) } } : {}),
  });
  console.log(`fake store listening: ${store.url}`);
  console.log(`  export SS33_ENDPOINT=${store.url}`);
  console.log(`  calls/misses/outcomes: curl -s http://127.0.0.1:${store.port}/_admin/calls`);
  if (record) console.log(`  recording misses from ${record.upstream} (${record.apiKey ? "with your API key" : "free tier"})`);
  const stop = () => store.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

run().catch((err) => {
  console.error(`fake-store: ${(err as Error).message}`);
  process.exit(1);
});
