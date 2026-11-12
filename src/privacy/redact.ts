/** Patterns for common secrets — redacted before persistence. */
const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "aws_access_key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "aws_secret_assign", re: /(?:aws_secret_access_key|secret_access_key)\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}["']?/gi },
  { name: "github_pat", re: /\bghp_[A-Za-z0-9]{36,}\b/g },
  { name: "github_fine_grained", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { name: "github_oauth", re: /\bgho_[A-Za-z0-9]{36,}\b/g },
  { name: "github_app", re: /\b(?:ghu|ghs)_[A-Za-z0-9]{36,}\b/g },
  { name: "openai_key", re: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { name: "openai_proj_key", re: /\bsk-proj-[A-Za-z0-9_-]{20,}\b/g },
  { name: "anthropic_key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { name: "stripe_key", re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g },
  { name: "slack_token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "slack_webhook", re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9+/]+/g },
  { name: "google_api_key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "npm_token", re: /\bnpm_[A-Za-z0-9]{36,}\b/g },
  { name: "pypi_token", re: /\bpypi-[A-Za-z0-9_-]{20,}\b/g },
  { name: "huggingface_token", re: /\bhf_[A-Za-z0-9]{20,}\b/g },
  { name: "telegram_bot", re: /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g },
  { name: "discord_token", re: /\b[MN][A-Za-z\d]{23,}\.[\w-]{6,}\.[\w-]{27,}\b/g },
  { name: "connection_string", re: /\b(?:postgres|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s'"]+/gi },
  {
    name: "jwt",
    re: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  },
  {
    name: "bearer",
    re: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/gi,
  },
  {
    name: "generic_api_key_assignment",
    re: /\b(?:api[_-]?key|secret|token|password|passwd|auth[_-]?token)\s*[:=]\s*["']?[^\s"'\\]{8,}["']?/gi,
  },
  {
    name: "private_key_block",
    re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
  },
];

export interface RedactionResult {
  text: string;
  redacted: boolean;
  kinds: string[];
}

export function redactSecrets(input: string): RedactionResult {
  let text = input;
  const kinds = new Set<string>();

  for (const { name, re } of SECRET_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(text)) {
      kinds.add(name);
      re.lastIndex = 0;
      text = text.replace(re, `[REDACTED:${name}]`);
    }
  }

  return {
    text,
    redacted: kinds.size > 0,
    kinds: [...kinds],
  };
}

export function listRedactionKinds(): string[] {
  return SECRET_PATTERNS.map((p) => p.name);
}
