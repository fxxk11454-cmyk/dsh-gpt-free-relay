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
// Turnstile solver VM for chatgpt.com sentinel gate.
// Ported from lanqian528/chat2api (MIT) — same algorithm as gpt2agent's vendored turnstile.py.

let _startTime = 0;

function getTurnstileToken(dx: string, p: string): string | null {
  try {
    const decoded = Buffer.from(dx, "base64").toString("utf8");
    return xor(decoded, p);
  } catch {
    return null;
  }
}

function xor(dx: string, p: string): string {
  if (p.length === 0) return dx;
  let out = "";
  for (let i = 0; i < dx.length; i++) {
    out += String.fromCharCode(dx.charCodeAt(i) ^ p.charCodeAt(i % p.length));
  }
  return out;
}

function isFloat(x: any): boolean {
  return typeof x === "number";
}

function toStr(v: any): string {
  if (v === null || v === undefined) return "undefined";
  if (isFloat(v)) return String(v);
  if (typeof v === "string") {
    const special: Record<string, string> = {
      "window.Math": "[object Math]",
      "window.Reflect": "[object Reflect]",
      "window.performance": "[object Performance]",
      "window.localStorage": "[object Storage]",
      "window.Object": "function Object() { [native code] }",
      "window.Reflect.set": "function set() { [native code] }",
      "window.performance.now": "function () { [native code] }",
      "window.Object.create": "function create() { [native code] }",
      "window.Object.keys": "function keys() { [native code] }",
      "window.Math.random": "function random() { [native code] }",
    };
    return special[v] ?? v;
  }
  if (Array.isArray(v) && v.every((i) => typeof i === "string")) return v.join(",");
  return String(v);
}

class OrderedMap {
  keys: string[] = [];
  values: Record<string, any> = {};
  add(key: string, value: any) {
    if (!(key in this.values)) this.keys.push(key);
    this.values[key] = value;
  }
}

function buildFuncMap(): Map<number, any> {
  const pm = new Map<number, any>();

  const f1 = (e: number, t: number) => (pm.set(e, xor(toStr(pm.get(e)), toStr(pm.get(t)))));
  const f2 = (e: number, t: any) => pm.set(e, t);
  const f5 = (e: number, t: number) => {
    const n = pm.get(e);
    const tres = pm.get(t);
    if (Array.isArray(n)) pm.set(e, [...n, tres]);
    else if (typeof n === "string" || typeof tres === "string") pm.set(e, toStr(n) + toStr(tres));
    else if (isFloat(n) && isFloat(tres)) pm.set(e, n + tres);
    else pm.set(e, "NaN");
  };
  const f6 = (e: number, t: number, n: number) => {
    const tv = pm.get(t);
    const nv = pm.get(n);
    if (typeof tv === "string" && typeof nv === "string") {
      const res = `${tv}.${nv}`;
      pm.set(e, res === "window.document.location" ? "https://chatgpt.com/" : res);
    }
  };
  const f24 = (e: number, t: number, n: number) => {
    const tv = pm.get(t);
    const nv = pm.get(n);
    if (typeof tv === "string" && typeof nv === "string") pm.set(e, `${tv}.${nv}`);
  };
  const f7 = (e: number, ...args: number[]) => {
    const n = args.map((a) => pm.get(a));
    const ev = pm.get(e);
    if (typeof ev === "string") {
      if (ev === "window.Reflect.set") {
        const obj = n[0];
        obj?.add?.(String(n[1]), n[2]);
      }
    } else if (typeof ev === "function") {
      ev(...n);
    }
  };
  const f17 = (e: number, t: number, ...args: number[]) => {
    const i = args.map((a) => pm.get(a));
    const tv = pm.get(t);
    let res: any = null;
    if (typeof tv === "string") {
      if (tv === "window.performance.now") {
        const elapsed = (Date.now() - _startTime) * 1e6;
        res = (elapsed + Math.random()) / 1e6;
      } else if (tv === "window.Object.create") {
        res = new OrderedMap();
      } else if (tv === "window.Object.keys") {
        if (i[0] === "window.localStorage") {
          res = [
            "STATSIG_LOCAL_STORAGE_INTERNAL_STORE_V4",
            "STATSIG_LOCAL_STORAGE_STABLE_ID",
            "client-correlated-secret",
            "oai/apps/capExpiresAt",
            "oai-did",
            "STATSIG_LOCAL_STORAGE_LOGGING_REQUEST",
            "UiState.isNavigationCollapsed.1",
          ];
        }
      } else if (tv === "window.Math.random") {
        res = Math.random();
      }
    } else if (typeof tv === "function") {
      res = tv(...i);
    }
    pm.set(e, res);
  };
  const f8 = (e: number, t: number) => pm.set(e, pm.get(t));
  const f14 = (e: number, t: number) => {
    const tv = pm.get(t);
    if (typeof tv === "string") pm.set(e, JSON.parse(tv));
  };
  const f15 = (e: number, t: number) => pm.set(e, JSON.stringify(pm.get(t)));
  const f18 = (e: number) => pm.set(e, Buffer.from(toStr(pm.get(e)), "base64").toString("utf8"));
  const f19 = (e: number) => pm.set(e, Buffer.from(toStr(pm.get(e)), "utf8").toString("base64"));
  const f20 = (e: number, t: number, n: number, ...args: number[]) => {
    if (pm.get(e) === pm.get(t)) {
      const nv = pm.get(n);
      if (typeof nv === "function") nv(...args.map((a) => pm.get(a)));
    }
  };
  const f21 = (..._args: any[]) => {};
  const f23 = (e: number, t: number, ...args: any[]) => {
    if (pm.get(e) !== null && pm.get(e) !== undefined && typeof pm.get(t) === "function") {
      pm.get(t)(...args);
    }
  };

  pm.set(1, f1);
  pm.set(2, f2);
  pm.set(5, f5);
  pm.set(6, f6);
  pm.set(24, f24);
  pm.set(7, f7);
  pm.set(17, f17);
  pm.set(8, f8);
  pm.set(10, "window");
  pm.set(14, f14);
  pm.set(15, f15);
  pm.set(18, f18);
  pm.set(19, f19);
  pm.set(20, f20);
  pm.set(21, f21);
  pm.set(23, f23);
  return pm;
}

export function solveTurnstile(dx: string, p: string): string | null {
  _startTime = Date.now();
  const tokens = getTurnstileToken(dx, p);
  if (tokens === null) return null;
  let tokenList: any[];
  try {
    tokenList = JSON.parse(tokens);
  } catch {
    return null;
  }

  let res = "";
  const pm = buildFuncMap();
  const f3 = (e: string) => {
    res = Buffer.from(e, "utf8").toString("base64");
  };
  pm.set(3, f3);
  // ponytail: pm[9]=tokenList, pm[16]=p mirror the python sentinel keys
  (pm as any).set(9, tokenList);
  (pm as any).set(16, p);

  for (const token of tokenList) {
    try {
      const e = token[0];
      const t = token.slice(1);
      const f = pm.get(e);
      if (typeof f === "function") f(...t);
    } catch {
      continue;
    }
  }
  return res || null;
}
