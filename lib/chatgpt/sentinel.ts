/**
 * vendored —— 原样取自 pi-gpt v0.4.3（MIT），它又移植自 lanqian528/chat2api（MIT）。
 *
 * 这一段是 ChatGPT 的 Sentinel 反机器人门禁：
 *   - pow.ts       工作量证明（SHA3-512），纯 Node 实现
 *   - turnstile.ts 把服务端下发的字节码回放一遍，纯 Node 实现（不是真 Turnstile 求解）
 *   - sentinel.ts  两者串起来，产出 chat-requirements / proof / turnstile 三个 token
 *
 * 之所以原样 vendor 不重写：这里的指纹数组（navigatorKey / windowKey）是会被
 * 哈希进去的，改动任何一个字符都会导致 proof 校验失败。而且上游随时会变，
 * 保持与上游实现一字不差，将来 diff 升级最省事。
 *
 * 本文件保留了 Node 原生类型标注 —— Node 24 支持类型剥离，可直接 import。
 */
// Sentinel gate: fetch chat-requirements, solve POW + turnstile.
import { getRequirementsToken, solvePow } from "./pow.ts";
import { solveTurnstile } from "./turnstile.ts";

export interface SentinelTokens {
  "chat-requirements": string;
  proof?: string;
  turnstile?: string;
}

const SENTINEL_URL = "https://chatgpt.com/backend-api/sentinel/chat-requirements";

/**
 * @param headers base session headers (Authorization, OAI-*, User-Agent)
 */
export async function getSentinelTokens(headers: Record<string, string>): Promise<SentinelTokens> {
  const ua = headers["User-Agent"] || "";
  const p = getRequirementsToken(ua);

  const r = await fetch(SENTINEL_URL, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json", Accept: "*/*" },
    body: JSON.stringify({ p }),
  });
  if (r.status !== 200) {
    throw new Error(`sentinel/chat-requirements HTTP ${r.status}`);
  }
  const resp: any = await r.json();
  if (!resp || typeof resp !== "object") throw new Error("sentinel unexpected response shape");
  const chatToken: string = resp.token;
  if (!chatToken) throw new Error("sentinel/chat-requirements no token");

  const out: SentinelTokens = { "chat-requirements": chatToken };

  const powBlock = resp.proofofwork || {};
  if (powBlock.required) {
    const seed = powBlock.seed;
    const diff = powBlock.difficulty;
    if (!seed || !diff) throw new Error(`sentinel POW missing seed/difficulty`);
    out.proof = solvePow(seed, diff, ua);
  } else {
    out.proof = "";
  }

  const turnBlock = resp.turnstile || {};
  if (turnBlock.required) {
    const dx = turnBlock.dx;
    if (dx) {
      const proofForXor = out.proof || p;
      const tok = solveTurnstile(dx, proofForXor);
      if (tok) out.turnstile = tok;
    }
  }
  return out;
}
