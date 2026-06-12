import { randomInt } from "node:crypto";

// Slug + view-token generation (birthday.md "Data model" notes).
//
// Slugs are adjective-noun-5digits (heroku-style) and are NOT secrets — guessing
// a slug gets you nothing on a private doc without the view token. Generated
// randomly; the caller retries on a unique-violation.
//
// View tokens are 10–12 chars from an unambiguous base58-ish alphabet (no
// 0/O/l/I) → 60+ bits of entropy, short enough not to be ugly. Rotatable via the
// API (the "un-share" story).

const ADJECTIVES = [
  "fierce", "gentle", "brave", "calm", "clever", "bright", "swift", "quiet",
  "bold", "eager", "jolly", "keen", "lively", "merry", "noble", "proud",
  "rapid", "shiny", "snug", "spry", "sunny", "vivid", "witty", "zesty",
  "amber", "azure", "coral", "crimson", "golden", "ivory", "jade", "scarlet",
  "ancient", "cosmic", "lunar", "solar", "stormy", "frosty", "misty", "dusky",
  "humble", "mighty", "nimble", "silent", "stellar", "velvet", "wild", "wandering",
  "curious", "daring", "dazzling", "earnest", "feisty", "grand", "hardy", "lucky",
  "modest", "plucky", "regal", "rustic", "sleek", "sturdy", "tidy", "wise",
];

const NOUNS = [
  "tiger", "otter", "falcon", "panda", "lynx", "heron", "raven", "badger",
  "fox", "wolf", "bison", "moose", "lemur", "gecko", "marten", "puma",
  "cedar", "maple", "willow", "birch", "spruce", "aspen", "fern", "moss",
  "river", "meadow", "canyon", "summit", "harbor", "delta", "glacier", "prairie",
  "comet", "nebula", "quasar", "pulsar", "meteor", "galaxy", "nova", "orbit",
  "anchor", "beacon", "compass", "lantern", "lattice", "prism", "quill", "satchel",
  "ember", "cinder", "ripple", "pebble", "thicket", "hollow", "grove", "brook",
  "sparrow", "robin", "finch", "swallow", "magpie", "kestrel", "osprey", "wren",
];

/** Random adjective-noun-5digits slug. Not a secret; retry on unique violation. */
export function generateSlug(): string {
  const adj = ADJECTIVES[randomInt(0, ADJECTIVES.length)];
  const noun = NOUNS[randomInt(0, NOUNS.length)];
  const digits = String(randomInt(0, 100_000)).padStart(5, "0");
  return `${adj}-${noun}-${digits}`;
}

// Unambiguous base58-ish alphabet — no 0/O/l/I (and no upper-I/lower-L confusion).
const ALPHABET = "123456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";
const VIEW_TOKEN_LEN = 11; // in [10,12]; 11 * log2(58) ≈ 64 bits of entropy

/**
 * Random view token (capability URL component). Returned to the owner on create
 * and on every GET — so it is stored PLAINTEXT, not hashed (see documents.view_token
 * comment in lib/docs/store.ts). Each char chosen with a CSPRNG via randomInt
 * (unbiased uniform selection over the alphabet).
 */
export function generateViewToken(): string {
  let out = "";
  for (let i = 0; i < VIEW_TOKEN_LEN; i++) {
    out += ALPHABET[randomInt(0, ALPHABET.length)];
  }
  return out;
}
