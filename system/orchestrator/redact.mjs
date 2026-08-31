import fs from "node:fs";

const SECRET_KEY = /TOKEN|SECRET|KEY|PASSWORD|API_/;
const secrets = new Set();

function remember(value) {
  if (typeof value !== "string") return;
  const v = value.trim();
  if (v.length < 12) return;
  secrets.add(v);
  try {
    const enc = encodeURIComponent(v);
    if (enc !== v && enc.length >= 12) secrets.add(enc);
  } catch {
    /* */
  }
}

export function addSecretValues(values) {
  for (const v of values || []) remember(v);
}

export function seedSecretsFromEnv(env = process.env) {
  for (const [k, v] of Object.entries(env)) {
    if (!v) continue;
    if (SECRET_KEY.test(k)) remember(String(v));
  }
}

export function seedSecretsFromEnvFile(filePath) {
  if (!filePath) return;
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    let val = line.slice(eq + 1);
    if (
      (val.startsWith("\"") && val.endsWith("\"")) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    remember(val);
  }
}

export function redactText(text) {
  if (text == null) return text;
  let s = String(text);
  if (!s || secrets.size === 0) return s;
  const list = [...secrets].sort((a, b) => b.length - a.length);
  for (const secret of list) {
    if (secret && s.includes(secret)) s = s.split(secret).join("[redacted]");
  }
  return s;
}

seedSecretsFromEnv();
if (process.env.TENWHY_ENV_FILE) seedSecretsFromEnvFile(process.env.TENWHY_ENV_FILE);
