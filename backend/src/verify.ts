import { verify } from "./chain.js";
/** `npm run verify` — the same check the public endpoint runs, from the command line. */
const s = verify();
console.log(s.intact ? `intact: ${s.entries} sealed entries${s.unsealed ? `, ${s.unsealed} awaiting seal` : ""}` : `BROKEN at row ${s.brokenAt}: ${s.reason}`);
process.exit(s.intact ? 0 : 1);
